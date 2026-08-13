import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { guessCategoryId } from '@/lib/categoryGuess';
import { SbTransaction, SbAccountId } from '@/lib/enableBanking';
import { getCachedExchangeRate, ISO_4217 } from '@/lib/monobank';
import { numericForCurrency } from '@/lib/currencies';

const TRANSFER_CATEGORY_NAME = 'Переказ між рахунками';

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

// entry_reference ("<date>-<sequence-within-day>") is NOT stable over time,
// beyond the already-known cross-account collision risk (see
// Transaction.sbTransactionId's own schema comment). Confirmed live
// 2026-08-13: when a same-day transaction settles LATE (posts to the feed
// after an earlier sync already ran), the bank's own sequence numbering
// shifts everything after it — a reference that meant one real transaction
// at sync time can mean a COMPLETELY DIFFERENT one on a later re-fetch. This
// produces two distinct failures, both observed the same week: (a) a new
// real transaction's reference collides with an OLDER, already-recorded,
// DIFFERENT transaction's stale reference — the dedup check wrongly treats
// it as already-seen and silently drops it (a real "Sygnir AS" utility
// payment vanished this way); (b) the SAME real transaction gets reassigned
// a NEW reference on a later fetch — no existing row matches it, so it gets
// recorded a second time (the checking<->pillow transfer duplicate, and a
// separate income duplicate, both found the same week). Both handled below
// by treating CONTENT (amount + date, and for the no-reference-match case
// also counterparty) as a secondary signal alongside the raw reference,
// not as a replacement for it — the reference is still the fast, precise
// path for the overwhelming majority of normal syncs where nothing shifted.
const CONTENT_DEDUP_MIN_AGE_MS = 5 * 60 * 1000;

// Resolves what this item's dedup situation actually is, given both the raw
// entry_reference AND the transaction's own content (amount comes from the
// caller already converted to the household's currency, matching what's
// actually stored). Returns either a decision to skip, or the storage key
// to actually write the row under (usually just dedupKey verbatim; only
// different in the stale-collision recovery case below, where reusing the
// literal colliding reference would violate the @@unique constraint).
async function resolveDedup(userId: number, dedupKey: string, amount: number, date: Date, counterparty: string): Promise<{ skip: true } | { skip: false; storageKey: string }> {
  // Scoped by userId, not a bare lookup on sbTransactionId alone — see the
  // field's own schema comment: entry_reference is only unique WITHIN one
  // account's own daily sequence, not bank-wide, so two different users'
  // first transaction of the same day can share the same raw value.
  const existingByRef = await prisma.transaction.findFirst({
    where: { userId, sbTransactionId: dedupKey },
    select: { id: true, amount: true, date: true },
  });
  if (existingByRef) {
    const sameContent = Math.abs(existingByRef.amount - amount) < 0.01 && existingByRef.date.getTime() === date.getTime();
    if (sameContent) return { skip: true };
    // The row occupying this reference is a DIFFERENT real transaction (the
    // Sygnir case) — this item is genuinely new. A distinguishing suffix
    // avoids the unique-constraint collision the raw reference would hit;
    // deterministic per (reference, amount) pair, so a later re-sync of
    // this exact item (same reference still meaning this same content at
    // that point) still dedups correctly against ITSELF next time.
    console.warn('[sparebankIngest] entry_reference collision with different content, recovering as new row', { dedupKey, existingId: existingByRef.id, amount });
    return { skip: false, storageKey: `${dedupKey}::${amount}` };
  }

  // No reference match. Could be a genuinely new transaction, OR this exact
  // transaction already recorded earlier under a reference that has since
  // drifted away (the transfer-duplicate case). Requiring amount + date +
  // counterparty ALL matching (not just amount + date) guards against two
  // real distinct same-day purchases of the same price coincidentally
  // colliding. Excludes rows created within the last few minutes — two
  // identical purchases arriving in the SAME sync call (e.g. two coffees,
  // same price, same day, same shop) must not shadow each other; genuine
  // reference drift only ever shows up ACROSS separate sync runs in every
  // case observed so far.
  const possibleDrift = await prisma.transaction.findFirst({
    where: {
      userId,
      source: 'sparebank',
      amount,
      date,
      sbCounterparty: counterparty || null,
      createdAt: { lt: new Date(Date.now() - CONTENT_DEDUP_MIN_AGE_MS) },
    },
    select: { id: true },
  });
  if (possibleDrift) {
    console.warn('[sparebankIngest] no reference match but content matches an older row — treating as drifted duplicate', { dedupKey, existingId: possibleDrift.id, amount });
    return { skip: true };
  }

  return { skip: false, storageKey: dedupKey };
}

// Once BOTH accounts of a same-person transfer are syncEnabled, EACH side's
// own sync independently resolves the SAME real movement to the SAME
// savings category (via the learned rule below) — so without this check,
// a single real 3464 kr checking->pillow transfer would tally as 3464+3464
// in "Фінансова подушка". Only the SECOND leg to actually get recorded
// should end up excluded; the first stands as the real entry. Matches by
// amount + SAME direction within a window — same, not opposite, because the
// caller already normalizes savingsWithdrawal to the pool's own perspective
// before calling this (see ingestTransaction's selfIsPoolSide flip), so
// both legs of one real transfer share the identical corrected sign by the
// time either reaches here. Transaction has no column recording which
// physical SparebankAccount a row came from (see the model's own comment),
// so amount+date+category+sign is the best available signal — this is the
// same heuristic shape already proven empirically clean for Monobank's
// inter-person transfers (0 false positives across 104 real transactions,
// see project_monobank_integration memory), just scoped to one user's own
// accounts instead of two different users.
async function findSavingsTransferMirror(userId: number, categoryId: number, amount: number, date: Date, isWithdrawal: boolean): Promise<number | null> {
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
    },
    select: { id: true },
  });
  return match?.id ?? null;
}

export type IngestResult = 'created' | 'skipped_pending' | 'skipped_duplicate' | 'skipped_malformed';
export interface IngestOutcome { status: IngestResult; id?: number }

// Single source of truth for turning one Enable Banking transaction into a
// Transaction row — same role as lib/monoIngest.ts's ingestStatementItem,
// called only from the pull-based sync route (no push/webhook path for this
// integration; see api/sparebank/sync's own comment on why pull-only). The
// created row's id is returned so the sync route can offer a "Скасувати"
// undo — sync commits immediately (unlike the single-transaction delete's
// delay-then-write pattern), so undoing it needs a real reversal call
// naming exactly the rows this specific sync created.
export async function ingestTransaction(userId: number, householdId: number, item: SbTransaction, selfAccountId: number): Promise<IngestOutcome> {
  // entry_reference first, NOT transaction_id — confirmed live 2026-07-22 by
  // fetching the same real transaction twice a few seconds apart:
  // transaction_id is an opaque per-request encrypted blob that's DIFFERENT
  // on every call ("ZW5jISF..." — decodes to "enc!!..."), while
  // entry_reference ("2026-07-21-0", date + same-day sequence number) was
  // identical both times. Using transaction_id as the dedup key meant
  // *every* sync recreated everything in its date range, since the "unique"
  // id was never actually the same twice — this is exactly the "a
  // valid-looking wrong value is more dangerous than a crash" trap: the
  // field named transaction_id looked like the obviously-correct choice.
  const dedupKey = item.entry_reference || item.transaction_id;
  if (!dedupKey) return { status: 'skipped_malformed' };

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
  const remittance = (item.remittance_information ?? []).join(' ').trim();
  const details = remittance || counterparty || '';
  const merchantKey = (remittance || counterparty || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const dateStr = item.booking_date || item.value_date || item.transaction_date;
  if (!dateStr) return { status: 'skipped_malformed' };
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(date.getTime())) return { status: 'skipped_malformed' };

  const dedup = await resolveDedup(userId, dedupKey, amount, date, counterparty);
  if (dedup.skip) return { status: 'skipped_duplicate' };
  const storageKey = dedup.storageKey;

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
  const counterpartAccount = txType === 'expense' ? item.creditor_account : item.debtor_account;
  const transferAccountId = await findTransferCounterpartAccountId(userId, counterpartAccount);

  let isTransfer: boolean;
  let categoryId: number;

  if (transferAccountId !== null) {
    // Known movement between this user's own accounts. If a correction has
    // already taught the category-guess chain that this exact counterparty
    // (merchantKey — typically the account holder's own name on a
    // self-transfer) belongs to a savings category, the transfer itself IS
    // the real, meaningful event: money moving into or out of a tracked
    // pool like "Фінансова подушка". Blanket-excluding it (the previous
    // behavior) silently understated real savings activity — found live
    // 2026-08-13 on a genuine "Основний -> Подушка" deposit. Bypasses
    // guessCategoryId's normal expense/income-only tiers (which structurally
    // can't return a savings category — see that function's own comment)
    // and reads the learned rule directly.
    const rule = await prisma.monoCategoryRule.findUnique({
      where: { userId_merchantKey: { userId, merchantKey } },
      select: { categoryId: true, category: { select: { isActive: true, type: true } } },
    });
    if (rule?.category.isActive && rule.category.type === 'savings') {
      // ponytail: SparebankAccount ids have no explicit "which one is the
      // tracked pool" marker (that's the deferred Ф2 — an explicit
      // account<->category mapping + Settings UI). Lower id = the
      // reference/checking side, higher id = the pool side, is an ordinal
      // proxy, not a real signal — correct today because Основний (id 1)
      // was created before Подушка (id 2), but not guaranteed for a
      // household whose accounts get connected in the opposite order.
      // Revisit with the explicit mapping if that ever produces a
      // backwards-signed row.
      const selfIsPoolSide = selfAccountId > transferAccountId;
      if (selfIsPoolSide) savingsWithdrawal = !savingsWithdrawal;
      const mirrorId = await findSavingsTransferMirror(userId, rule.categoryId, amount, date, savingsWithdrawal);
      categoryId = rule.categoryId;
      // Only the SECOND leg to actually sync gets excluded — see
      // findSavingsTransferMirror's own comment on why blindly excluding
      // BOTH sides would drop a real deposit/withdrawal from the total.
      isTransfer = mirrorId !== null;
    } else {
      // No learned rule pointing this counterparty at a savings category —
      // still a same-person account movement, but we don't know which
      // tracked pool (if any) it should reduce/increase, so file it
      // separately rather than guessing. A manual correction here teaches
      // the rule above for next time, same as any other category fix.
      isTransfer = true;
      categoryId = (await prisma.category.upsert({
        where: { householdId_name_type: { householdId, name: TRANSFER_CATEGORY_NAME, type: 'savings' } },
        update: {},
        create: { householdId, name: TRANSFER_CATEGORY_NAME, type: 'savings', color: '#64748B', icon: 'wallet' },
        select: { id: true },
      })).id;
    }
  } else {
    isTransfer = false;
    categoryId = await guessCategoryId(householdId, userId, txType, merchantKey, undefined);
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

  return { status: 'created', id: created.id };
}
