import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { normalizeMerchantKey, getCachedExchangeRate } from '@/lib/monobank';
import { guessCategoryId as resolveCategoryId } from '@/lib/categoryGuess';
import { numericForCurrency } from '@/lib/currencies';
import { looksLikeTransferIntermediary, findCrossBankTransferMatch } from '@/lib/transferDetect';

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
  const match = await prisma.transaction.findFirst({
    where: {
      householdId,
      userId: { not: userId },
      source: 'mono',
      isTransfer: false,
      amount: { gte: amount * (1 - TRANSFER_MATCH_AMOUNT_TOLERANCE), lte: amount * (1 + TRANSFER_MATCH_AMOUNT_TOLERANCE) },
      date: { gte: windowStart, lte: windowEnd },
      category: { type: oppositeType },
    },
    select: { id: true },
  });
  return match?.id ?? null;
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
  const existing = await prisma.transaction.findUnique({ where: { monoStatementId: item.id } });
  if (existing) return 'skipped_duplicate';

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

  // Is this the household moving money between Паша's and Женя's own
  // connected Monobank accounts? See findMonoTransferMatch's own comment.
  const matchedTransferId = await findMonoTransferMatch(householdId, userId, txType, amount, date);
  let isTransfer = matchedTransferId !== null;

  const merchantKey = normalizeMerchantKey(item.description || '');
  let categoryId: number;
  let categorySource: string | null = null; // only the non-transfer branch below actually runs resolveCategoryId
  if (isTransfer) {
    categoryId = (await prisma.category.upsert({
      where: { householdId_name_type: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE } },
      update: {},
      create: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE, color: '#64748B', icon: 'wallet' },
      select: { id: true },
    })).id;
  } else {
    ({ categoryId, source: categorySource } = await resolveCategoryId(householdId, userId, txType, merchantKey, item.mcc));
  }

  // Cross-bank same-person transfer (e.g. a Paysend top-up from the
  // household's own SpareBank account) — see transferDetect.ts's own
  // comment. Only attempted when this ISN'T already a same-bank transfer
  // match above, and deliberately doesn't touch categoryId: this row keeps
  // whatever it already resolved to (e.g. the receiving member's own
  // personal-income category).
  let crossBankMatchId: number | null = null;
  if (!isTransfer && looksLikeTransferIntermediary(item.description || '', item.mcc)) {
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
  // has a recurring-generated or Excel-imported row is a real signal
  // something might double-count — flag it rather than block the write.
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const possibleDup = await prisma.transaction.findFirst({
    where: {
      householdId,
      categoryId,
      date: { gte: monthStart, lt: monthEnd },
      OR: [{ recurringTemplateId: { not: null } }, { details: '[імпорт]' }],
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
    await prisma.transaction.update({
      where: { id: matchedTransferId },
      data: { categoryId, categorySource, isTransfer: true },
    });
  }
  // Cross-bank match: only flip isTransfer on the other leg, never its
  // category — see transferDetect.ts's own comment on why.
  if (crossBankMatchId) {
    await prisma.transaction.update({
      where: { id: crossBankMatchId },
      data: { isTransfer: true },
    });
  }

  return 'created';
}
