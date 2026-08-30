import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { guessCategoryId } from '@/lib/categoryGuess';
import { SbTransaction, SbAccountId } from '@/lib/enableBanking';
import { getCachedExchangeRate, ISO_4217 } from '@/lib/monobank';
import { numericForCurrency } from '@/lib/currencies';
import { looksLikeTransferIntermediary, findCrossBankTransferMatch } from '@/lib/transferDetect';

// See monoIngest.ts's own comment on the 2026-08-24 rename/retype from
// 'Переказ між рахунками' (type 'savings') to a dedicated 'transfer' type.
const TRANSFER_CATEGORY_NAME = 'Перекази';
const TRANSFER_CATEGORY_TYPE = 'transfer';

// SpareBank 1's own remittance_information format for (some) card
// transactions embeds transaction-specific data directly in the text:
// "*<card-last-4> <DD.MM> <CCY> <amount> <merchant name> Kurs: <rate>".
// Confirmed live 2026-08-14/15 with "NORSK REISELIVSMUSEUM": the SAME real
// merchant sends a plain short description ("NORSK REISELIVSMUSEUM") for
// some transactions and this card-authorization envelope for others — and
// since the envelope embeds THIS purchase's own amount+date, every card
// purchase at that merchant produces a UNIQUE string. Left un-stripped,
// that string becomes both `details` (noisy) and `merchantKey` (broken) —
// a merchantKey that's different every time can never match a previously
// learned MonoCategoryRule, so the user had to re-teach the identical
// correction twice in two days before this was caught. Stripped down to
// just the merchant name (the same stable text the SAME merchant sends in
// its other, non-card-format remittance style) before it becomes either.
const CARD_AUTH_ENVELOPE = /^\*\d+\s+\d{2}\.\d{2}\s+[A-Z]{3}\s+[\d.,]+\s+(.+?)\s+Kurs:\s*[\d.,]+$/i;
function stripCardAuthEnvelope(text: string): string {
  const match = text.match(CARD_AUTH_ENVELOPE);
  return match ? match[1].trim() : text;
}

// True ONLY when the counterparty account is ALSO syncEnabled — i.e. this
// transfer will independently produce its OWN row on the other side too, so
// excluding both from every total prevents a genuine double count. When the
// counterpart is a known-but-not-synced account (e.g. a "pillow" savings
// account that only ever has ITS transactions pulled here, on the checking
// side), there is exactly ONE row for this real-world movement, not a pair —
// that row must stay a normal savingsWithdrawal-signed transaction under
// whatever category it represents (e.g. "Фінансова подушка"), the same way
// it worked before this account-matching existed, or the category's own
// tracked total silently stops decreasing when money actually leaves it.
// Found live 2026-08-02: the two real "подушка -> основний" transfers
// (only "Основний" ever synced) got wrongly excluded entirely by this
// function initially matching on account id alone, breaking exactly the
// withdrawal-tracking behavior the user asked for at the start of this
// whole feature.
//
// Matching by account number, not by counterparty NAME, is still deliberate
// — a name-based rule (what an earlier version of this feature effectively
// did via the learned-category-rule mechanism) is exactly the kind of
// merchant/person-specific hardcoding this project's own convention warns
// against; an account number is a real, structural fact that works for any
// user without hardcoding anything about who they are. Confirmed live
// 2026-08-01: SpareBank 1 populates account_id.other.identification, a
// BBAN-style local number, more reliably than iban on these fields.
async function findTransferCounterpartAccountId(userId: number, counterpart: SbAccountId | null | undefined): Promise<number | null> {
  if (!counterpart) return null;
  const identification = counterpart.other?.identification;
  const iban = counterpart.iban;
  if (!identification && !iban) return null;
  const match = await prisma.sparebankAccount.findFirst({
    where: {
      userId,
      syncEnabled: true,
      OR: [
        ...(identification ? [{ identification }] : []),
        ...(iban ? [{ iban }] : []),
      ],
    },
    select: { id: true },
  });
  return match?.id ?? null;
}

const MIRROR_WINDOW_DAYS = 3; // generous — matches RECONCILIATION_OVERLAP_DAYS-ish tolerance for late settlement

// entry_reference ("<date>-<sequence-within-day>") is NOT used for dedup at
// all anymore. FIXED 2026-08-14, superseding the 2026-08-13 "recover as a
// new row on reference collision" patch — that patch made things WORSE, not
// better. It assumed the bank only shifts the TAIL of a day's numbering when
// a late item settles. Confirmed live 2026-08-14 that's wrong: SpareBank
// 1/Enable Banking reshuffles the ENTIRE day's ordering on every re-fetch,
// with no stable relationship between an old reference and a new one. Under
// the 2026-08-13 patch, every item in a reshuffled day looked like "a
// reference collision with different content" — so every single sync
// recreated every transaction from that day under a fresh distinguishing
// key. One 22:51 sync produced 4 new duplicate rows this way.
//
// The set of real transactions for a given (account, day) IS stable across
// re-fetches even though their reported order isn't — so the key is built
// from content instead: account + date + direction + amount. Deliberately
// EXCLUDES remittance_information/creditor name, despite that being the
// obvious extra disambiguating signal — confirmed live 2026-08-14 that text
// isn't stable either. The exact same real "NORSK REISELIVSMUSEUM" purchase
// carried a long card-authorization description
// ("*0506 12.08 NOK 49.50 NORSK REISELIVSMUSEUM Kurs: 1.0000") at ingest
// time and a short, simplified one ("NORSK REISELIVSMUSEUM") on a later
// re-fetch — the bank enriches/cleans up the text after settlement. Putting
// that in the key would have reproduced the exact same multiplying-dedup
// bug this fix exists to kill, just on a slower fuse. amount+date+direction
// is the only combination confirmed stable across every re-fetch observed
// so far.
//
// Two genuinely distinct transactions that happen to share that exact
// signature (e.g. two identical same-day purchases) get an ordinal suffix,
// assigned by counting how many times the signature has already been seen
// EARLIER IN THIS SAME FETCH (occurrenceCounts, a fresh Map per
// syncSparebankAccount call). The Nth occurrence of a signature within one
// fetch always claims storage slot #N — whether this is the first sync to
// ever see it (slot doesn't exist yet, create) or the tenth reconciliation
// re-fetch of the same already-stored transaction (slot already exists,
// skip). Correctness doesn't depend on which physical item maps to which
// slot when two share a signature — they're indistinguishable by amount/
// date/direction anyway, so at worst a same-amount-same-day pair could swap
// which row holds which merchant text after a reshuffle, a harmless
// cosmetic edge case next to the alternative (ongoing duplication). This
// only works because ingestTransaction is always called sequentially within
// one sync (see sparebankSync.ts's plain for-of loop, never Promise.all) —
// two same-signature items in one fetch claim consecutive slots without
// racing each other.
//
// Exported so the one-off backfill script that re-keyed the 24 pre-existing
// rows to this scheme could reuse the exact same formula instead of
// duplicating it and risking drift between the two.
export function buildSbContentKeyBase(accountId: number, dateStr: string, direction: string, amount: number): string {
  return `sb${accountId}|${dateStr}|${direction}|${amount.toFixed(2)}`;
}

// Once BOTH accounts of a same-person transfer are syncEnabled, EACH side's
// own sync independently resolves the SAME real movement to the SAME
// savings category (via SparebankAccount.categoryId, see its own comment)
// — so without this check,
// a single real 3464 kr checking->pillow transfer would tally as 3464+3464
// in "Фінансова подушка". Only the SECOND leg to actually get recorded
// should end up excluded; the first stands as the real entry. Matches by
// amount + SAME direction within a window — same, not opposite, because the
// caller already normalizes savingsWithdrawal to the pool's own perspective
// before calling this (see ingestTransaction's selfIsPool flip), so
// both legs of one real transfer share the identical corrected sign by the
// time either reaches here. Transaction has no column recording which
// physical SparebankAccount a row came from (see the model's own comment),
// so amount+date+category+sign is the best available signal — this is the
// same heuristic shape already proven empirically clean for Monobank's
// inter-person transfers (0 false positives across 104 real transactions,
// see project_monobank_integration memory), just scoped to one user's own
// accounts instead of two different users.
// excludeId: the row currently being processed, when reconciling an
// already-stored transaction (see ingestTransaction's `needsReconciliation`
// path) — WITHOUT this, a reconciliation re-run matches the row against
// ITSELF (same categoryId/amount/date/sign it already has) and "finds" a
// mirror that's really just its own row, flipping isTransfer to true on the
// one leg that was correctly counted. FOUND LIVE 2026-08-30: exactly this
// happened to a real withdrawal the very next sync after it was correctly
// recorded — both legs of the transfer ended up excluded and the withdrawal
// silently vanished from "Фінансова подушка" entirely, not just miscounted.
// In the CREATE path this can't happen (the row doesn't exist yet when this
// runs), so excludeId is only ever passed from the reconcile path.
async function findSavingsTransferMirror(userId: number, categoryId: number, amount: number, date: Date, isWithdrawal: boolean, excludeId?: number): Promise<number | null> {
  const windowStart = new Date(date.getTime() - MIRROR_WINDOW_DAYS * 24 * 3600 * 1000);
  const windowEnd = new Date(date.getTime() + MIRROR_WINDOW_DAYS * 24 * 3600 * 1000);
  const match = await prisma.transaction.findFirst({
    where: {
      userId,
      source: 'sparebank',
      categoryId,
      isTransfer: false,
      amount,
      savingsWithdrawal: isWithdrawal,
      date: { gte: windowStart, lte: windowEnd },
      ...(excludeId !== undefined ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return match?.id ?? null;
}

export type IngestResult = 'created' | 'reconciled' | 'skipped_pending' | 'skipped_duplicate' | 'skipped_malformed';
export interface IngestOutcome { status: IngestResult; id?: number }

// Single source of truth for turning one Enable Banking transaction into a
// Transaction row — same role as lib/monoIngest.ts's ingestStatementItem,
// called only from the pull-based sync route (no push/webhook path for this
// integration; see api/sparebank/sync's own comment on why pull-only). The
// created row's id is returned so the sync route can offer a "Скасувати"
// undo — sync commits immediately (unlike the single-transaction delete's
// delay-then-write pattern), so undoing it needs a real reversal call
// naming exactly the rows this specific sync created.
//
// occurrenceCounts is a Map the caller creates fresh once per
// syncSparebankAccount call (see that function) and threads through every
// item in that sync — see buildSbContentKeyBase's own comment for why a
// shared, sync-scoped counter is what makes the ordinal-suffix dedup
// correct instead of just plausible.
export async function ingestTransaction(userId: number, householdId: number, item: SbTransaction, selfAccountId: number, occurrenceCounts: Map<string, number>): Promise<IngestOutcome> {

  // Same "provisional vs final" rule as Monobank's hold check (deep-review
  // category 9) — a booking that hasn't cleared can still be reversed or
  // change identifier once it settles. getTransactions() already requests
  // transaction_status=BOOK from the API, but that's the ASPSP's choice to
  // honor; this is the actual guarantee.
  if (item.status && item.status !== 'BOOK') return { status: 'skipped_pending' };

  const rawAmount = Number(item.transaction_amount?.amount);
  if (!Number.isFinite(rawAmount)) return { status: 'skipped_malformed' };
  const txType: 'expense' | 'income' = item.credit_debit_indicator === 'CRDT' ? 'income' : 'expense';
  const amountOriginal = roundMoney(Math.abs(rawAmount));

  // SpareBank 1's own account currency is always NOK — but the HOUSEHOLD's
  // chosen display currency (lib/currencies.ts) might not be. Reuses
  // Monobank's public-feed exchange-rate lookup (no dependency on the
  // household even having Monobank connected — it's just a public rate
  // source, same UAH-triangulation logic already proven for Monobank).
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { currency: true } });
  const targetCcy = numericForCurrency(household?.currency ?? 'NOK');
  let amount = amountOriginal;
  if (targetCcy !== ISO_4217.NOK) {
    const rate = await getCachedExchangeRate(ISO_4217.NOK, targetCcy);
    if (rate === null) throw new Error(`No exchange rate available for currency NOK -> ${targetCcy}`);
    amount = roundMoney(amountOriginal * rate);
  }

  // The counterparty is whoever's on the OTHER side of the money: the
  // creditor received an expense, the debtor sent an income.
  const counterparty = (txType === 'expense' ? item.creditor?.name : item.debtor?.name) ?? '';
  const remittance = stripCardAuthEnvelope((item.remittance_information ?? []).join(' ').trim());
  // remittance_information is usually the useful human text ("Kiwi 123
  // Bergen") when creditor/debtor.name is empty (direct debits, standing
  // orders). But for KID/OCR-referenced bill payments it can be nothing but
  // a bare account/reference number ("2824300100055") while the real payee
  // name only lives in counterparty — confirmed live 2026-08-13 (a Sygnir AS
  // electricity bill recorded its account number as the description and
  // fell through category-guessing to "Незрозуміло"). A pure digit/
  // punctuation string is never a description, so counterparty wins then.
  const remittanceIsReference = remittance !== '' && !/[a-z]/i.test(remittance);
  const details = (remittanceIsReference ? '' : remittance) || counterparty || remittance || '';
  const merchantKey = ((remittanceIsReference ? '' : remittance) || counterparty || remittance || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const dateStr = item.booking_date || item.value_date || item.transaction_date;
  if (!dateStr) return { status: 'skipped_malformed' };
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(date.getTime())) return { status: 'skipped_malformed' };

  const keyBase = buildSbContentKeyBase(selfAccountId, dateStr, item.credit_debit_indicator, amountOriginal);
  const occurrence = (occurrenceCounts.get(keyBase) ?? 0) + 1;
  occurrenceCounts.set(keyBase, occurrence);
  const storageKey = `${keyBase}#${occurrence}`;

  // Purely a DISPLAY signal (see the transactions-list sign/color logic that
  // reads it) — whether money is flowing INTO this account (CRDT, shown "+")
  // or OUT of it (DBIT, shown "-"). Computed before the transfer branch below
  // since findSavingsTransferMirror needs to know which direction to look
  // for the opposite leg. isTransfer (not this) is what actually excludes a
  // row from budget math.
  //
  // Correct ONLY from the perspective of a non-pool account: CRDT arriving
  // at checking (sourced from the pool) IS a withdrawal. But when the
  // account CURRENTLY being synced is itself the pool (e.g. syncing
  // "Подушка"'s own feed), the exact same formula is backwards — CRDT
  // arriving AT the pool is a DEPOSIT, not a withdrawal. Flipped below,
  // once we know whether this row is even landing in a savings-mapped
  // transfer category, for the account that isn't the reference side.
  let savingsWithdrawal = txType === 'income';

  // Is the OTHER side of this transaction one of this same user's own known
  // accounts? DBIT's counterparty is who received it (creditor_account);
  // CRDT's is who sent it (debtor_account) — the account being synced is
  // never its own counterparty, so no need to exclude it explicitly.
  // Computed BEFORE the dedup check below (moved there deliberately — see
  // its own comment on why a self-transfer's account numbers can arrive
  // only on a LATER re-fetch of the same already-stored transaction).
  const counterpartAccount = txType === 'expense' ? item.creditor_account : item.debtor_account;
  const transferAccountId = await findTransferCounterpartAccountId(userId, counterpartAccount);

  const existing = await prisma.transaction.findFirst({
    where: { userId, sbTransactionId: storageKey },
    select: { id: true, isTransfer: true, categoryId: true, savingsWithdrawal: true },
  });
  // Reconciliation, not just a duplicate skip. FOUND LIVE 2026-08-28: a
  // same-person Основний<->Подушка transfer's FIRST sync recorded
  // creditor_account/debtor_account both empty — SpareBank 1 hadn't
  // resolved the counterparty account yet, only a generic placeholder
  // description ("Overførsel mellom egne konti i Mobilbank, forfall i
  // dag", same enrichment-arrives-later shape as stripCardAuthEnvelope's
  // own precedent). transferAccountId came back null, isTransfer stayed
  // false, and the row landed as an ordinary expense/income pair instead
  // of a detected transfer. RECONCILIATION_OVERLAP_DAYS exists exactly to
  // re-fetch this window and catch data that settles/enriches late — but
  // the OLD dedup check exited on `existing` before any of that logic ever
  // ran, so the later-arriving account numbers had nowhere to land; the
  // pair just stayed silently mis-detected forever.
  //
  // Only reconsider when there's actually something new to act on (still
  // not a transfer, AND the account now resolves) — every other duplicate
  // hit (the overwhelming majority of re-fetches) still exits immediately
  // below, without re-running guessCategoryId (which can reach an LLM
  // tier) for rows that already have a perfectly good, unrelated category.
  const needsReconciliation = existing !== null && !existing.isTransfer && transferAccountId !== null;
  if (existing && !needsReconciliation) return { status: 'skipped_duplicate' };

  let isTransfer: boolean;
  let categoryId: number;

  if (transferAccountId !== null) {
    // Known movement between this user's own accounts. Ф2 (2026-08-29): ask
    // the two real SparebankAccount rows directly whether either of them IS
    // a tracked savings pool (SparebankAccount.categoryId, set once by the
    // user in Settings) — an explicit fact, not a guess. Replaces the old
    // MonoCategoryRule text-match ("does a learned rule for this
    // counterparty's name point at a savings category?") and the ordinal
    // id-comparison hack for which side is the pool — see
    // SparebankAccount.categoryId's own schema comment for the whole
    // history of what this used to get wrong.
    const [selfAcct, counterpartAcct] = await Promise.all([
      prisma.sparebankAccount.findUnique({ where: { id: selfAccountId }, select: { categoryId: true, category: { select: { isActive: true, type: true } } } }),
      prisma.sparebankAccount.findUnique({ where: { id: transferAccountId }, select: { categoryId: true, category: { select: { isActive: true, type: true } } } }),
    ]);
    const selfIsPool = !!(selfAcct?.categoryId && selfAcct.category?.isActive && selfAcct.category.type === 'savings');
    const counterpartIsPool = !!(counterpartAcct?.categoryId && counterpartAcct.category?.isActive && counterpartAcct.category.type === 'savings');
    // Both sides mapped to a pool is a genuinely odd setup (not the normal
    // checking<->pillow shape) — prefer this account's own mapping rather
    // than silently pick one; not worth modeling further until it's a real
    // household's actual setup.
    const poolCategoryId = selfIsPool ? selfAcct!.categoryId! : counterpartIsPool ? counterpartAcct!.categoryId! : null;

    if (poolCategoryId !== null) {
      if (selfIsPool) savingsWithdrawal = !savingsWithdrawal;
      // excludeId: when reconciling, this row itself already sits in the DB
      // with these exact categoryId/amount/date/sign — without excluding
      // it, the query below finds itself as its own "mirror" (see this
      // function's own comment for the real incident this caused).
      const mirrorId = await findSavingsTransferMirror(userId, poolCategoryId, amount, date, savingsWithdrawal, existing?.id);
      categoryId = poolCategoryId;
      // Only the SECOND leg to actually sync gets excluded — see
      // findSavingsTransferMirror's own comment on why blindly excluding
      // BOTH sides would drop a real deposit/withdrawal from the total.
      isTransfer = mirrorId !== null;
    } else {
      // Neither account is mapped to a tracked pool — still a same-person
      // account movement, but we don't know which pool (if any) it should
      // reduce/increase, so file it separately rather than guessing. Map
      // one of the two accounts to a savings category in Settings to fix
      // this for good, instead of a per-transaction correction.
      isTransfer = true;
      categoryId = (await prisma.category.upsert({
        where: { householdId_name_type: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE } },
        update: {},
        create: { householdId, name: TRANSFER_CATEGORY_NAME, type: TRANSFER_CATEGORY_TYPE, color: '#64748B', icon: 'wallet' },
        select: { id: true },
      })).id;
    }
  } else {
    isTransfer = false;
    categoryId = await guessCategoryId(householdId, userId, txType, merchantKey, undefined);
  }

  // Cross-bank same-person transfer (e.g. a Paysend top-up landing on the
  // household's own Monobank account) — see transferDetect.ts's own
  // comment. Only attempted when this isn't already a known SpareBank-
  // internal movement (transferAccountId above), and deliberately doesn't
  // touch categoryId: this row keeps whatever the user taught it (e.g.
  // "Враховано деінде").
  let crossBankMatchId: number | null = null;
  if (!isTransfer && looksLikeTransferIntermediary(merchantKey)) {
    crossBankMatchId = await findCrossBankTransferMatch(userId, 'sparebank', txType, amount, date);
    if (crossBankMatchId) isTransfer = true;
  }

  if (existing) {
    // Reconciling an already-stored row (see the `needsReconciliation`
    // comment above). Only actually write when the freshly computed result
    // DIFFERS from what's stored — this row will keep re-entering this
    // branch on every future sync (transferAccountId resolves every time
    // once the accounts are known; that's not something that stops being
    // true), so treating every re-entry as a real change is what let a
    // correctly-resolved row get re-processed and corrupted the next day
    // (see findSavingsTransferMirror's own comment on the exact incident).
    // A no-op recompute now behaves exactly like an ordinary duplicate hit.
    const changed = existing.categoryId !== categoryId || existing.isTransfer !== isTransfer || existing.savingsWithdrawal !== savingsWithdrawal;
    if (!changed) return { status: 'skipped_duplicate' };
    await prisma.transaction.update({
      where: { id: existing.id },
      data: { categoryId, isTransfer, savingsWithdrawal, details, sbCounterparty: counterparty || null },
    });
    if (crossBankMatchId) {
      await prisma.transaction.update({ where: { id: crossBankMatchId }, data: { isTransfer: true } });
    }
    return { status: 'reconciled', id: existing.id };
  }

  // Same double-count guard as Ф5 (Monobank) — a sparebank transaction
  // landing in a category+month that already has a recurring/import row is a
  // real signal two independent writers might be recording the same event.
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

  let created;
  try {
    created = await prisma.transaction.create({
      data: {
        householdId,
        date,
        categoryId,
        amount,
        details,
        userId,
        source: 'sparebank',
        possibleDuplicateOf: possibleDup?.id ?? null,
        sbTransactionId: storageKey,
        sbCounterparty: counterparty || null,
        savingsWithdrawal,
        isTransfer,
      },
      select: { id: true },
    });
  } catch (e: any) {
    // Same race as monoIngest — two overlapping syncs can both pass the
    // findUnique check before either commits; the loser hits P2002, which is
    // a benign "someone else already recorded this" outcome, not an error.
    if (e?.code === 'P2002') return { status: 'skipped_duplicate' };
    throw e;
  }

  // Cross-bank match: only flip isTransfer on the other leg (Monobank side),
  // never its category — see transferDetect.ts's own comment on why.
  if (crossBankMatchId) {
    await prisma.transaction.update({
      where: { id: crossBankMatchId },
      data: { isTransfer: true },
    });
  }

  return { status: 'created', id: created.id };
}
