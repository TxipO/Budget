import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { getCachedExchangeRate } from '@/lib/monobank';
import { merchantKey as toMerchantKey } from '@/lib/merchantKey';
import { guessCategoryId as resolveCategoryId } from '@/lib/categoryGuess';
import { numericForCurrency } from '@/lib/currencies';
import { looksLikeMonoTransferLeg, findCrossBankTransferMatch, NOT_MANUAL } from '@/lib/transferDetect';

export interface MonoStatementItem {
  id: string;
  time: number; // unix seconds
  description: string;
  mcc?: number;
  hold?: boolean; // provisional authorization, not yet settled — can still be declined/cancelled
  // `amount` is ALWAYS in the connected account's own currency (here: UAH —
  // see lib/monobank.ts's getClientInfo), regardless of what currencyCode
  // says. For a purchase made abroad, `operationAmount` is the actual amount
  // charged at the point of sale, denominated in `currencyCode`. Confirmed
  // live 2026-07-11 against Monobank's raw API response: a NOK purchase
  // showed amount=-105560 (1055.60, the UAH-account-debited figure) and
  // operationAmount=-22900 (229.00, the real NOK charge) with currencyCode
  // 578 (NOK) on both fields — using `amount` as if it were already in
  // `currencyCode`'s currency recorded every NOK purchase ~4.6x too large.
  // For a domestic (UAH) transaction the two fields are equal, so preferring
  // operationAmount when present is always correct, never just "close".
  amount: number; // minor units (kopecks), negative = expense — account currency
  operationAmount?: number; // minor units, in currencyCode's currency
  currencyCode: number;
}

export const MONO_CCY_NAMES: Record<number, string> = { 980: 'UAH', 578: 'NOK', 840: 'USD', 978: 'EUR', 985: 'PLN' };

export type IngestResult = 'created' | 'skipped_hold' | 'skipped_duplicate' | 'skipped_malformed';

// 'Перекази' — its own category TYPE (not 'savings'), so isBudgetRelevant()
// excludes every row filed here by type alone, independent of whether
// isTransfer itself got set correctly (see that function's own comment on
// the 2026-08-24 #938/#939 case this guards against). Renamed/retyped from
// 'Переказ між рахунками' (type 'savings') 2026-08-24, at the user's
// request, to give transfers their own dashboard tile instead of hiding
// inside Збереження's totals.
const TRANSFER_CATEGORY_NAME = 'Перекази';
const TRANSFER_CATEGORY_TYPE = 'transfer';

// Monobank statement items carry no counterparty account id (unlike
// SpareBank's creditor_account/debtor_account — see sparebankIngest.ts's own
// findTransferCounterpartAccountId comment on why that's the reliable key
// there), only a free-text description. The only structural signal
// available for "this household is moving money between its own two
// connected Monobank accounts" is: the OTHER household member's own mono
// account has a transaction of the exact opposite direction, the exact same
// amount (both already converted to the household's own currency, so
// directly comparable), within a few days of this one.
// FIXED 2026-08-24: was an exact-amount match, "revisit with a tolerance
// only if that turns out to happen in practice" (original comment). It did
// — confirmed live: #938 (-2582.22) / #939 (+2583.55), a genuine same-day
// transfer pair, missed each other because each leg's UAH->NOK conversion
// hit a different snapshot of the 1h-TTL exchange-rate cache (0.05% apart).
// Both legs go through independent currency conversion (see the
// amount-vs-operationAmount comment above), so a small tolerance is
// structurally expected, not a data-quality problem — 0.5% is an order of
// magnitude above the observed drift while staying two orders below the
// cross-bank detector's 12% (transferDetect.ts), which has to cover an
// intermediary's real FX spread/fee, not just a stale cache.
const TRANSFER_MATCH_AMOUNT_TOLERANCE = 0.005;
const TRANSFER_MATCH_WINDOW_DAYS = 2;

async function findMonoTransferMatch(householdId: number, userId: number, txType: 'income' | 'expense', amount: number, date: Date): Promise<number | null> {
  const oppositeType = txType === 'income' ? 'expense' : 'income';
  const windowStart = new Date(date.getTime() - TRANSFER_MATCH_WINDOW_DAYS * 24 * 3600 * 1000);
  const windowEnd = new Date(date.getTime() + TRANSFER_MATCH_WINDOW_DAYS * 24 * 3600 * 1000);
  // A hand-edited ('manual') EARLIER leg is never a candidate: this match
  // overwrites that leg's category/categorySource/isTransfer, i.e. exactly
  // what the person may have set on purpose. Deterministic among several
  // candidates: closest amount, then closest date, then lowest id.
  const candidates = await prisma.transaction.findMany({
    where: {
      householdId,
      userId: { not: userId },
      source: 'mono',
      isTransfer: false,
      AND: [NOT_MANUAL],
      amount: { gte: amount * (1 - TRANSFER_MATCH_AMOUNT_TOLERANCE), lte: amount * (1 + TRANSFER_MATCH_AMOUNT_TOLERANCE) },
      date: { gte: windowStart, lte: windowEnd },
      category: { type: oppositeType },
    },
    select: { id: true, amount: true, date: true },
  });
  candidates.sort((a, b) => Math.abs(a.amount - amount) - Math.abs(b.amount - amount)
    || Math.abs(a.date.getTime() - date.getTime()) - Math.abs(b.date.getTime() - date.getTime())
    || a.id - b.id);
  return candidates[0]?.id ?? null;
}

// Monobank reports a CANCELLED purchase as a separate, positive item whose
// description is "Скасування. <merchant>" — confirmed live: #1142 "Скасування.
// Steam" (income-shaped) next to #1143 "Steam" (the expense it cancels).
// Counted as ordinary rows the reversal reads as a fake income AND the
// purchase stays an expense. Pairing them as isTransfer (both excluded) makes
// the net effect zero, exactly what a cancellation is.
//
// Deliberately conservative — the pair must be the SAME user, the same merchant
// (the description after the prefix, normalized the same way as merchantKey),
// within +-30 days (a card refund can take weeks), and the same ORIGINAL
// amount (monoAmountOriginal = operationAmount, the merchant-currency figure,
// so a refund is compared with what was charged and not with two independently
// FX-converted totals) within 1%. Never an already-excluded or hand-edited
// row. Works in both ingest orders, see the two finders below.
const REVERSAL_PREFIX = /^Скасування\.\s*(.+)$/i;
const REVERSAL_WINDOW_DAYS = 30;
const REVERSAL_AMOUNT_TOLERANCE = 0.01;

const DAY_MS = 24 * 3600 * 1000;

function reversalWhere(userId: number, amountOriginal: number, date: Date) {
  return {
    userId,
    source: 'mono',
    isTransfer: false,
    AND: [NOT_MANUAL],
    monoAmountOriginal: { gte: amountOriginal * (1 - REVERSAL_AMOUNT_TOLERANCE), lte: amountOriginal * (1 + REVERSAL_AMOUNT_TOLERANCE) },
    date: { gte: new Date(date.getTime() - REVERSAL_WINDOW_DAYS * DAY_MS), lte: new Date(date.getTime() + REVERSAL_WINDOW_DAYS * DAY_MS) },
  };
}

function closest<T extends { id: number; date: Date; monoAmountOriginal: number | null }>(rows: T[], amountOriginal: number, date: Date): T | null {
  rows.sort((a, b) => Math.abs((a.monoAmountOriginal ?? 0) - amountOriginal) - Math.abs((b.monoAmountOriginal ?? 0) - amountOriginal)
    || Math.abs(a.date.getTime() - date.getTime()) - Math.abs(b.date.getTime() - date.getTime())
    || a.id - b.id);
  return rows[0] ?? null;
}

// The REVERSAL is being ingested: find the purchase it cancels.
async function findReversalOriginal(userId: number, merchantKey: string, amountOriginal: number, date: Date): Promise<{ id: number; categoryId: number } | null> {
  if (!merchantKey) return null; // nothing left after noise-stripping: pairing on "" would match any blank-key row
  const rows = await prisma.transaction.findMany({
    where: { ...reversalWhere(userId, amountOriginal, date), savingsWithdrawal: false },
    select: { id: true, date: true, monoAmountOriginal: true, categoryId: true, monoMerchant: true },
  });
  return closest(rows.filter(r => toMerchantKey(r.monoMerchant ?? '') === merchantKey), amountOriginal, date);
}

// The PURCHASE is being ingested (after its reversal already arrived): find
// the still-unpaired reversal. merchantKey is the purchase's own.
async function findUnpairedReversal(userId: number, merchantKey: string, amountOriginal: number, date: Date): Promise<{ id: number } | null> {
  if (!merchantKey) return null;
  const rows = await prisma.transaction.findMany({
    where: { ...reversalWhere(userId, amountOriginal, date), savingsWithdrawal: true, monoMerchant: { startsWith: 'Скасування.', mode: 'insensitive' as const } },
    select: { id: true, date: true, monoAmountOriginal: true, monoMerchant: true },
  });
  return closest(rows.filter(r => { const m = (r.monoMerchant ?? '').trim().match(REVERSAL_PREFIX); return !!m && toMerchantKey(m[1]) === merchantKey; }), amountOriginal, date);
}

// Single source of truth for turning one Monobank StatementItem into a
// Transaction row — used by both the push webhook and the manual/backfill
// sync route, so the two paths can never drift into different behavior for
// the same event (they already did once: the manual path was about to
// duplicate this logic before being extracted here).
export async function ingestStatementItem(userId: number, householdId: number, item: MonoStatementItem): Promise<IngestResult> {
  if (!item?.id) return 'skipped_malformed';

  // A hold is a provisional card authorization, not a finalized payment —
  // it can still be declined by the merchant or cancelled (a fuel-pump
  // pre-auth that never completes, an expired reservation) and never
  // settle at all. Recording it now would risk both a phantom transaction
  // (if it never settles) and a duplicate (if it settles later under a
  // different statement id). Monobank sends a separate, later webhook (or
  // this item simply flips hold:false on the next statement fetch) once it
  // actually clears — only that one should be recorded.
  if (item.hold) return 'skipped_hold';

  // Idempotent: a webhook redelivery, its own retry, and a manual sync
  // covering an overlapping date range must never create a duplicate.
  const existing = await prisma.transaction.findUnique({ where: { monoStatementId: item.id }, select: { id: true, userId: true } });
  if (existing) {
    // Detector, not a fix: a statement id is globally unique, so seeing it
    // arrive for a DIFFERENT user means two users hold the same Monobank
    // client (the repeated wrong-user attribution — connect now refuses to
    // bind one clientId to two users). Still a duplicate: never a second row.
    if (existing.userId !== userId) {
      console.error('[monoIngest] statement', item.id, 'already stored as tx', existing.id, 'for user', existing.userId, 'but ingested for user', userId, '- possible shared Monobank client');
    }
    return 'skipped_duplicate';
  }

  const txType: 'expense' | 'income' = item.amount < 0 ? 'expense' : 'income';
  // operationAmount (in currencyCode's currency), not amount (always the
  // account's own currency) — see the MonoStatementItem comment above.
  const rawAmount = item.operationAmount ?? item.amount;
  const amountOriginal = roundMoney(Math.abs(rawAmount) / 100);

  // Convert to the HOUSEHOLD's own chosen currency, not a hardcoded NOK —
  // see lib/currencies.ts. Household.currency defaults to "NOK" for every
  // pre-existing row, so this is behaviorally identical to before for any
  // household that hasn't explicitly chosen something else at onboarding.
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { currency: true } });
  const targetCcy = numericForCurrency(household?.currency ?? 'NOK');

  let fxRate = 1;
  if (item.currencyCode !== targetCcy) {
    const rate = await getCachedExchangeRate(item.currencyCode, targetCcy);
    // No silent 1.0 fallback: defaulting to "1 unit = 1 unit" when the rate
    // is genuinely unavailable (no cache yet AND the live endpoint is down)
    // would record a real, possibly multi-x overstatement with no error
    // anywhere.
    if (rate === null) throw new Error(`No exchange rate available for currency ${item.currencyCode} -> ${targetCcy}`);
    fxRate = rate;
  }
  const amount = roundMoney(amountOriginal * fxRate);

  // Truncate to UTC midnight of the calendar day — matches this app's
  // existing convention (manual/import rows land on UTC midnight,
  // recurring-generated rows on UTC noon). item.time is an unambiguous UTC
  // epoch second count, and truncation uses getUTC*() accessors, so this is
  // correct no matter what timezone this server process happens to run in.
  const raw = new Date(item.time * 1000);
  const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));

  const merchantKey = toMerchantKey(item.description || '');

  // "Скасування. <merchant>" reversal arriving AFTER its purchase — see
  // findReversalOriginal. Checked before the same-bank transfer match: it is
  // the more specific signal.
  const reversalPrefix = txType === 'income' ? (item.description || '').trim().match(REVERSAL_PREFIX) : null;
  const reversalOriginal = reversalPrefix ? await findReversalOriginal(userId, toMerchantKey(reversalPrefix[1]), amountOriginal, date) : null;

  // Is this the household moving money between Паша's and Женя's own
  // connected Monobank accounts? See findMonoTransferMatch's own comment.
  const matchedTransferId = reversalOriginal ? null : await findMonoTransferMatch(householdId, userId, txType, amount, date);
  let isTransfer = matchedTransferId !== null || reversalOriginal !== null;

  let categoryId: number;
  let categorySource: string | null = null; // only the non-transfer branch below actually runs resolveCategoryId
  if (reversalOriginal) {
    // The cancelled purchase's own category, so the pair reads as one story.
    categoryId = reversalOriginal.categoryId;
    categorySource = 'reversal';
  } else if (isTransfer) {
    categoryId = (await prisma.category.upsert({
      where: { householdId_name_type: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE } },
      update: {},
      create: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE, color: '#64748B', icon: 'wallet' },
      select: { id: true },
    })).id;
  } else {
    let categoryIsTransfer: boolean;
    ({ categoryId, source: categorySource, isTransfer: categoryIsTransfer } = await resolveCategoryId(householdId, userId, txType, merchantKey, item.mcc));
    // A learned rule can point at a 'transfer'-type category — exclude the row
    // from totals too, not just file it there.
    if (categoryIsTransfer) isTransfer = true;
  }

  // The PURCHASE arriving AFTER its reversal — see findUnpairedReversal.
  let pairedReversalId: number | null = null;
  if (!isTransfer && txType === 'expense') {
    const rev = await findUnpairedReversal(userId, merchantKey, amountOriginal, date);
    if (rev) { pairedReversalId = rev.id; isTransfer = true; }
  }

  // Cross-bank same-person transfer (e.g. a Paysend top-up from the
  // household's own SpareBank account) — see transferDetect.ts's own
  // comment. Only attempted when this ISN'T already a same-bank transfer
  // match above, and deliberately doesn't touch categoryId: this row keeps
  // whatever it already resolved to (e.g. the receiving member's own
  // personal-income category).
  let crossBankMatchId: number | null = null;
  if (!isTransfer && await looksLikeMonoTransferLeg(userId, item.description || '', item.mcc)) {
    crossBankMatchId = await findCrossBankTransferMatch(userId, 'mono', txType, amount, date);
    if (crossBankMatchId) isTransfer = true;
  }

  // Only read when the resolved category turns out to be type "savings" —
  // see Transaction.savingsWithdrawal's own schema comment and the matching
  // note in sparebankIngest.ts. A transfer OUT of a connected account
  // (amount < 0, "expense"-shaped) into a savings pot is a deposit; money
  // coming back IN (amount >= 0, "income"-shaped) is a withdrawal. Applies
  // the same whether the row landed in the dedicated transfer category or an
  // ordinary category — isTransfer/category.type (not this) is what actually
  // excludes a row from budget math, see isBudgetRelevant's own comment.
  // Also doubles as the "Перекази" tile's direction signal for type
  // 'transfer' rows (stats.ts sums only the false/outgoing leg of each pair,
  // to avoid double-counting a matched transfer twice).
  const savingsWithdrawal = txType === 'income';

  // Ф5: the same real-world payment counted twice from two independent
  // writers. A mono transaction landing in a category+month that already
  // has an Excel-imported row is a real signal something might
  // double-count — flag it rather than block the write.
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const possibleDup = await prisma.transaction.findFirst({
    where: {
      householdId,
      categoryId,
      date: { gte: monthStart, lt: monthEnd },
      details: '[імпорт]',
    },
  });

  try {
    await prisma.transaction.create({
      data: {
        householdId,
        date,
        categoryId,
        categorySource,
        amount,
        details: item.description || '',
        userId,
        source: 'mono',
        possibleDuplicateOf: possibleDup?.id ?? null,
        monoStatementId: item.id,
        monoMerchant: item.description || null,
        monoMcc: item.mcc ?? null,
        monoAmountOriginal: amountOriginal,
        monoCurrency: MONO_CCY_NAMES[item.currencyCode] ?? String(item.currencyCode),
        fxRate,
        savingsWithdrawal,
        isTransfer,
      },
    });
  } catch (e: any) {
    // The webhook and a manual /monobank/sync (or two overlapping syncs) can
    // both reach this function for the same never-before-seen item — the
    // findUnique check above has a race window, so both can pass it before
    // either commits. Whoever loses the race hits this unique-constraint
    // violation on monoStatementId; that's not a real error, it's the same
    // outcome as the findUnique check finding it (someone else already
    // recorded this exact event). Confirmed live: two concurrent calls with
    // the same statement id — one 'created', the other threw P2002 — before
    // this fix, an uncaught throw here aborted sync/route.ts's whole batch
    // loop (every item after the racing one silently never got processed
    // that run, and the response became a generic 500 instead of the
    // accurate partial-success counts).
    if (e?.code === 'P2002') return 'skipped_duplicate';
    throw e;
  }

  // The matched OTHER half of a same-bank transfer was recorded earlier
  // under whatever category it originally guessed (it had no way to know
  // about this side yet) — retroactively reclassify it now too, or only the
  // later-arriving side would ever get excluded from budget totals.
  if (matchedTransferId) {
    // updateMany + NOT_MANUAL: the matcher already skips hand-edited legs;
    // the guard also covers an edit landing between the match and this write.
    await prisma.transaction.updateMany({
      where: { id: matchedTransferId, AND: [NOT_MANUAL] },
      data: { categoryId, categorySource, isTransfer: true },
    });
  }
  // Reversal ingested after its purchase: the purchase is excluded too.
  if (reversalOriginal) {
    await prisma.transaction.updateMany({ where: { id: reversalOriginal.id, AND: [NOT_MANUAL] }, data: { isTransfer: true } });
  }
  // Purchase ingested after its reversal: the reversal is excluded and takes
  // the purchase's category.
  if (pairedReversalId) {
    await prisma.transaction.updateMany({
      where: { id: pairedReversalId, AND: [NOT_MANUAL] },
      data: { categoryId, categorySource: 'reversal', isTransfer: true },
    });
  }
  // Cross-bank match: only flip isTransfer on the other leg, never its
  // category — see transferDetect.ts's own comment on why.
  if (crossBankMatchId) {
    await prisma.transaction.updateMany({
      where: { id: crossBankMatchId, AND: [NOT_MANUAL] },
      data: { isTransfer: true },
    });
  }

  return 'created';
}
