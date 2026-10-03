import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { guessCategoryId } from '@/lib/categoryGuess';
import { SbTransaction, SbAccountId } from '@/lib/enableBanking';
import { getCachedExchangeRate, ISO_4217 } from '@/lib/monobank';
import { numericForCurrency } from '@/lib/currencies';
import { looksLikeTransferIntermediary, findCrossBankTransferMatch, looksLikeUnresolvedInternalTransfer, findUnresolvedInternalTransferMatch, NOT_MANUAL } from '@/lib/transferDetect';

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

// A second, simpler card-auth envelope confirmed live 2026-09-15: plain
// domestic-NOK purchases (no foreign currency, so no CCY/amount/Kurs) carry
// just a leading "DD.MM " authorization-date stamp before the merchant name
// — "13.09 96682762Stbar M DALSBERGSTIE STRØMMEN", "12.09 KIWI 582 TORGGA
// TORGGATA 1 OSLO". Same root cause as CARD_AUTH_ENVELOPE above (a bank
// envelope embedding THIS purchase's own date makes every visit to the same
// merchant produce a unique string) — found because a household member
// manually corrected one "Stbar" bar-tab line to "Залежності", which taught
// a MonoCategoryRule keyed on "13.09 96682762stbar...", and the other 15
// lines from the SAME night (same merchant, same real bar tab split across
// many card authorizations) never matched it — the date in the key made it
// unique to that one row. Confirmed systemic, not Stbar-specific: 32 of the
// 53 most recent SpareBank rows carried this exact prefix shape.
const DATE_STAMP_ENVELOPE = /^\d{2}\.\d{2}\s+(.+)$/;

function stripCardAuthEnvelope(text: string): string {
  const cardAuthMatch = text.match(CARD_AUTH_ENVELOPE);
  if (cardAuthMatch) return cardAuthMatch[1].trim();
  const dateStampMatch = text.match(DATE_STAMP_ENVELOPE);
  return dateStampMatch ? dateStampMatch[1].trim() : text;
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
// should end up excluded; the first stands as the real entry.
//
// REWRITTEN 2026-10 to be deterministic. The old version matched ANY
// sparebank row with the same category/amount/sign within +-3 days, never
// checking it came from the counterpart ACCOUNT nor that it was still
// unpaired. Real damage: two 200 kr Подушка->Основний transfers on 22.09 and
// 23.09 — each 23.09 leg "found" the 22.09 row as its mirror, so both 23.09
// legs got excluded. Now the mirror is looked up by KEY, not by search: the
// counterpart leg of a real transfer is the row
//   sb<counterpartAccountId>|<same booking date>|<opposite CRDT/DBIT>|<same amount>#<same occurrence>
// (buildSbContentKeyBase + the sync-scoped occurrence counter), so repeated
// same-amount transfers pair 1:1 by occurrence index, from the right
// account, on the right day, in either ingest order. It must also still be
// unpaired (isTransfer:false — an already-excluded leg is somebody's
// partner already) and not hand-edited ('manual').
//
// No +-day fallback, deliberately: all 14 real pairs in the data are
// same-booking-date on both accounts, and any date tolerance is exactly what
// let a 22.09 row masquerade as the 23.09 mirror. The cost of a (not yet
// seen) next-day-booked pair is a visible double count in the pool, fixable
// by hand — the cost of the loose window was a silently vanished withdrawal.
//
// The key carries the ORIGINAL NOK amount, so the match is also immune to the
// household-currency conversion drifting between two syncs (the old
// stored-amount equality was not). Cannot match the row itself: its key has
// its OWN account prefix, so the old excludeId workaround (FOUND LIVE
// 2026-08-30: a reconciliation re-run matched the row against itself and
// both legs ended up excluded) is structurally unnecessary now.
async function findSavingsTransferMirror(userId: number, categoryId: number, isWithdrawal: boolean, mirrorKey: string): Promise<number | null> {
  const match = await prisma.transaction.findFirst({
    where: {
      userId,
      source: 'sparebank',
      sbTransactionId: mirrorKey,
      categoryId,
      isTransfer: false,
      savingsWithdrawal: isWithdrawal,
      AND: [NOT_MANUAL],
    },
    select: { id: true },
  });
  return match?.id ?? null;
}

// The only way a partner leg is ever flipped to isTransfer. The matchers
// already exclude 'manual' rows; the guard here also covers a row edited by
// hand in the instant between the match and this write.
async function flipPartner(id: number): Promise<void> {
  await prisma.transaction.updateMany({ where: { id, AND: [NOT_MANUAL] }, data: { isTransfer: true } });
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
    select: { id: true, isTransfer: true, categoryId: true, savingsWithdrawal: true, categorySource: true },
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
  //
  // The account-number path above isn't the only way this can newly have
  // something to act on: `looksLikeUnresolvedInternalTransfer` below covers
  // the case where the account number NEVER resolves at all (confirmed
  // live: still null 10+ days later, transferAccountId's OWN
  // re-fetch window long since closed) — a stored row with that placeholder
  // text and still isTransfer:false deserves the same re-check chance,
  // bounded the exact same way (only re-fetched while still within the
  // sync's own overlap window).
  //
  // A hand-edited row ('manual', set by the PUT route on ANY manual change —
  // category, transfer flag, direction or text) is never reconsidered: this
  // path rewrites category/isTransfer/direction/details, i.e. exactly what a
  // person may have just fixed, and it re-fires on every sync inside the
  // overlap window. Treated as a plain duplicate.
  const needsReconciliation = existing !== null && existing.categorySource !== 'manual' && !existing.isTransfer &&
    (transferAccountId !== null || looksLikeUnresolvedInternalTransfer(details));
  if (existing && !needsReconciliation) return { status: 'skipped_duplicate' };

  let isTransfer: boolean;
  let categoryId: number;
  let categorySource: string | null = null; // only the no-transfer-match branch below actually runs guessCategoryId

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
      const oppositeIndicator = item.credit_debit_indicator === 'CRDT' ? 'DBIT' : 'CRDT';
      const mirrorKey = `${buildSbContentKeyBase(transferAccountId, dateStr, oppositeIndicator, amountOriginal)}#${occurrence}`;
      const mirrorId = await findSavingsTransferMirror(userId, poolCategoryId, savingsWithdrawal, mirrorKey);
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
    // A learned rule can resolve to a 'transfer'-type category — then the row
    // must be excluded from totals too (guessCategoryId's own isTransfer).
    ({ categoryId, source: categorySource, isTransfer } = await guessCategoryId(householdId, userId, txType, merchantKey, undefined));
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

  // Same-bank internal transfer whose account numbers never arrived at all
  // — see transferDetect.ts's own comment on findUnresolvedInternalTransferMatch
  // for the real incident and why this is safe to act on from the
  // placeholder text alone. excludeId matters here specifically on the
  // reconcile path: `existing` already sits in the DB with this exact
  // amount/date/text, so without excluding it, a stuck row with no real
  // sibling yet would "match" itself.
  // The sibling is NEVER flipped when it is the counted savings-pool leg (and
  // this row isn't flipped when IT is) — see findUnresolvedInternalTransferMatch.
  let unresolvedInternalMatchId: number | null = null;
  if (!isTransfer && looksLikeUnresolvedInternalTransfer(details)) {
    const m = await findUnresolvedInternalTransferMatch(userId, amount, date, categoryId, existing?.id);
    if (m) {
      if (m.flipSelf) isTransfer = true;
      if (m.flipSibling) unresolvedInternalMatchId = m.siblingId;
    }
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
      data: { categoryId, categorySource, isTransfer, savingsWithdrawal, details, sbCounterparty: counterparty || null },
    });
    if (crossBankMatchId) {
      await flipPartner(crossBankMatchId);
    }
    if (unresolvedInternalMatchId) {
      await flipPartner(unresolvedInternalMatchId);
    }
    return { status: 'reconciled', id: existing.id };
  }

  // Same double-count guard as Ф5 (Monobank) — a sparebank transaction
  // landing in a category+month that already has an Excel-imported row is a
  // real signal two independent writers might be recording the same event.
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

  let created;
  try {
    created = await prisma.transaction.create({
      data: {
        householdId,
        date,
        categoryId,
        categorySource,
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
    await flipPartner(crossBankMatchId);
  }
  // Same-bank unresolved-account match — same "only flip isTransfer, never
  // touch categoryId" rule, for the same reason: the sibling already
  // resolved to whatever it resolved to, and this fix's whole job is to
  // stop excluding it from being a transfer, not to relitigate its category.
  if (unresolvedInternalMatchId) {
    await flipPartner(unresolvedInternalMatchId);
  }

  return { status: 'created', id: created.id };
}
