import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { ISO_4217, normalizeMerchantKey, getCachedExchangeRate } from '@/lib/monobank';
import { guessCategoryId as resolveCategoryId } from '@/lib/categoryGuess';

export interface MonoStatementItem {
  id: string;
  time: number; // unix seconds
  description: string;
  mcc?: number;
  hold?: boolean; // provisional authorization, not yet settled — can still be declined/cancelled
  amount: number; // minor units (kopecks), negative = expense
  currencyCode: number;
}

export const MONO_CCY_NAMES: Record<number, string> = { 980: 'UAH', 578: 'NOK' };

export type IngestResult = 'created' | 'skipped_hold' | 'skipped_duplicate' | 'skipped_malformed';

// Single source of truth for turning one Monobank StatementItem into a
// Transaction row — used by both the push webhook and the manual/backfill
// sync route, so the two paths can never drift into different behavior for
// the same event (they already did once: the manual path was about to
// duplicate this logic before being extracted here).
export async function ingestStatementItem(userId: number, item: MonoStatementItem): Promise<IngestResult> {
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
  const amountOriginal = roundMoney(Math.abs(item.amount) / 100);

  let fxRate = 1;
  if (item.currencyCode !== ISO_4217.NOK) {
    const rate = await getCachedExchangeRate(item.currencyCode, ISO_4217.NOK);
    // No silent 1.0 fallback: defaulting to "1 UAH = 1 kr" when the rate is
    // genuinely unavailable (no cache yet AND the live endpoint is down)
    // would record a real ~4-5x overstatement with no error anywhere.
    if (rate === null) throw new Error(`No exchange rate available for currency ${item.currencyCode} -> NOK`);
    fxRate = rate;
  }
  const amount = roundMoney(amountOriginal * fxRate);

  const merchantKey = normalizeMerchantKey(item.description || '');
  const categoryId = await resolveCategoryId(userId, txType, merchantKey, item.mcc);

  // Truncate to UTC midnight of the calendar day — matches this app's
  // existing convention (manual/import rows land on UTC midnight,
  // recurring-generated rows on UTC noon). item.time is an unambiguous UTC
  // epoch second count, and truncation uses getUTC*() accessors, so this is
  // correct no matter what timezone this server process happens to run in.
  const raw = new Date(item.time * 1000);
  const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));

  // Ф5: the same real-world payment counted twice from two independent
  // writers. A mono transaction landing in a category+month that already
  // has a recurring-generated or Excel-imported row is a real signal
  // something might double-count — flag it rather than block the write.
  const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const possibleDup = await prisma.transaction.findFirst({
    where: {
      categoryId,
      date: { gte: monthStart, lt: monthEnd },
      OR: [{ recurringTemplateId: { not: null } }, { details: '[імпорт]' }],
    },
  });

  await prisma.transaction.create({
    data: {
      date,
      categoryId,
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
    },
  });

  return 'created';
}
