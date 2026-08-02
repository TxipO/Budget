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
export async function ingestTransaction(userId: number, householdId: number, item: SbTransaction): Promise<IngestOutcome> {
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

  // Scoped by userId, not a bare lookup on sbTransactionId alone — see the
  // field's own schema comment: entry_reference is only unique WITHIN one
  // account's own daily sequence, not bank-wide, so two different users'
  // first transaction of the same day can share the same raw value.
  const existing = await prisma.transaction.findFirst({ where: { userId, sbTransactionId: dedupKey } });
  if (existing) return { status: 'skipped_duplicate' };

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

  // Is the OTHER side of this transaction one of this same user's own known
  // accounts? DBIT's counterparty is who received it (creditor_account);
  // CRDT's is who sent it (debtor_account) — the account being synced is
  // never its own counterparty, so no need to exclude it explicitly.
  const counterpartAccount = txType === 'expense' ? item.creditor_account : item.debtor_account;
  const transferAccountId = await findTransferCounterpartAccountId(userId, counterpartAccount);
  const isTransfer = transferAccountId !== null;

  const categoryId = isTransfer
    ? (await prisma.category.upsert({
        where: { householdId_name_type: { householdId, name: TRANSFER_CATEGORY_NAME, type: 'savings' } },
        update: {},
        create: { householdId, name: TRANSFER_CATEGORY_NAME, type: 'savings', color: '#64748B', icon: 'wallet' },
        select: { id: true },
      })).id
    : await guessCategoryId(householdId, userId, txType, merchantKey, undefined);

  // Purely a DISPLAY signal now (see the transactions-list sign/color logic
  // that reads it) — whether money is flowing INTO this account (CRDT,
  // shown "+") or OUT of it (DBIT, shown "-"). Applies the same whether the
  // row landed in the dedicated transfer category or an ordinary savings
  // category (e.g. a manually-entered cash/crypto cushion movement) — see
  // Transaction.savingsWithdrawal's own schema comment. isTransfer (not
  // this) is what actually excludes a row from budget math.
  const savingsWithdrawal = txType === 'income';

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
        sbTransactionId: dedupKey,
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
