import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { guessCategoryId } from '@/lib/categoryGuess';
import { SbTransaction } from '@/lib/enableBanking';
import { getCachedExchangeRate, ISO_4217 } from '@/lib/monobank';
import { numericForCurrency } from '@/lib/currencies';

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
