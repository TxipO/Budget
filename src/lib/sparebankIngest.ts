import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { guessCategoryId } from '@/lib/categoryGuess';
import { SbTransaction } from '@/lib/enableBanking';

export type IngestResult = 'created' | 'skipped_pending' | 'skipped_duplicate' | 'skipped_malformed';

// Single source of truth for turning one Enable Banking transaction into a
// Transaction row — same role as lib/monoIngest.ts's ingestStatementItem,
// called only from the pull-based sync route (no push/webhook path for this
// integration; see api/sparebank/sync's own comment on why pull-only).
export async function ingestTransaction(userId: number, householdId: number, item: SbTransaction): Promise<IngestResult> {
  const dedupKey = item.transaction_id || item.entry_reference;
  if (!dedupKey) return 'skipped_malformed';

  // Same "provisional vs final" rule as Monobank's hold check (deep-review
  // category 9) — a booking that hasn't cleared can still be reversed or
  // change identifier once it settles. getTransactions() already requests
  // transaction_status=BOOK from the API, but that's the ASPSP's choice to
  // honor; this is the actual guarantee.
  if (item.status && item.status !== 'BOOK') return 'skipped_pending';

  const existing = await prisma.transaction.findUnique({ where: { sbTransactionId: dedupKey } });
  if (existing) return 'skipped_duplicate';

  const rawAmount = Number(item.transaction_amount?.amount);
  if (!Number.isFinite(rawAmount)) return 'skipped_malformed';
  const txType: 'expense' | 'income' = item.credit_debit_indicator === 'CRDT' ? 'income' : 'expense';
  const amount = roundMoney(Math.abs(rawAmount)); // SpareBank 1 is already NOK — no FX conversion needed, unlike Monobank

  // The counterparty is whoever's on the OTHER side of the money: the
  // creditor received an expense, the debtor sent an income.
  const counterparty = (txType === 'expense' ? item.creditor?.name : item.debtor?.name) ?? '';
  const remittance = (item.remittance_information ?? []).join(' ').trim();
  const details = remittance || counterparty || '';
  const merchantKey = (remittance || counterparty || '').trim().toLowerCase().replace(/\s+/g, ' ');

  const dateStr = item.booking_date || item.value_date || item.transaction_date;
  if (!dateStr) return 'skipped_malformed';
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(date.getTime())) return 'skipped_malformed';

  const categoryId = await guessCategoryId(householdId, userId, txType, merchantKey, undefined);

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

  try {
    await prisma.transaction.create({
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
      },
    });
  } catch (e: any) {
    // Same race as monoIngest — two overlapping syncs can both pass the
    // findUnique check before either commits; the loser hits P2002, which is
    // a benign "someone else already recorded this" outcome, not an error.
    if (e?.code === 'P2002') return 'skipped_duplicate';
    throw e;
  }

  return 'created';
}
