import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { ISO_4217, normalizeMerchantKey, getCachedExchangeRate } from '@/lib/monobank';
import { guessCategoryId as resolveCategoryId } from '@/lib/categoryGuess';

interface StatementItem {
  id: string;
  time: number; // unix seconds
  description: string;
  mcc?: number;
  hold?: boolean; // provisional authorization, not yet settled — can still be declined/cancelled
  amount: number; // minor units (kopecks), negative = expense
  currencyCode: number;
}

const CCY_NAMES: Record<number, string> = { 980: 'UAH', 578: 'NOK' };

export async function GET() {
  // Monobank sends a GET to this URL to verify it's alive before accepting a
  // webhook registration — must 200 regardless of whether :secret is a real
  // user's secret or disconnect.ts's inert "disconnected" placeholder.
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: { secret: string } }) {
  try {
    const user = await prisma.user.findUnique({ where: { monoWebhookSecret: params.secret }, select: { id: true } });
    // 200, not 404: an unrecognized secret (stale/disconnected/probing) isn't
    // an error for Monobank to retry, it's just nothing to do.
    if (!user) return NextResponse.json({ ok: true });

    const body = await req.json();
    if (body?.type !== 'StatementItem') return NextResponse.json({ ok: true });
    const item: StatementItem = body.data?.statementItem;
    if (!item?.id) return NextResponse.json({ ok: true });

    // A hold is a provisional card authorization, not a finalized payment —
    // it can still be declined by the merchant or cancelled (a fuel-pump
    // pre-auth that never completes, an expired reservation) and never
    // settle at all. Recording it now would risk both a phantom transaction
    // (if it never settles) and a duplicate (if it settles later under a
    // different statement id). Monobank sends a separate, later webhook
    // once the hold actually clears — only that one should be recorded.
    if (item.hold) return NextResponse.json({ ok: true });

    // Idempotent: Monobank redelivering the same event (or its own retry
    // after a slow response) must never create a duplicate transaction.
    const existing = await prisma.transaction.findUnique({ where: { monoStatementId: item.id } });
    if (existing) return NextResponse.json({ ok: true });

    const txType: 'expense' | 'income' = item.amount < 0 ? 'expense' : 'income';
    const amountOriginal = roundMoney(Math.abs(item.amount) / 100);

    let fxRate = 1;
    if (item.currencyCode !== ISO_4217.NOK) {
      const rate = await getCachedExchangeRate(item.currencyCode, ISO_4217.NOK);
      // No silent 1.0 fallback: defaulting to "1 UAH = 1 kr" when the rate
      // is genuinely unavailable (no cache yet AND the live endpoint is
      // down) would record a real ~4-5x overstatement of the amount with
      // no error anywhere — a valid-looking number, so nothing downstream
      // would ever catch it. Throwing here routes through the same 500 +
      // Monobank-retry path as any other failure, so the transaction gets
      // recorded correctly once the rate is available again instead of
      // being recorded wrong forever.
      if (rate === null) throw new Error(`No exchange rate available for currency ${item.currencyCode} -> NOK`);
      fxRate = rate;
    }
    const amount = roundMoney(amountOriginal * fxRate);

    const merchantKey = normalizeMerchantKey(item.description || '');
    const categoryId = await resolveCategoryId(user.id, txType, merchantKey, item.mcc);

    // Truncate to UTC midnight of the calendar day — matches this app's
    // existing convention (manual/import rows land on UTC midnight,
    // recurring-generated rows on UTC noon), so this doesn't trip the
    // "suspicious timestamp" integrity check. Not the old local-timezone
    // bug: item.time is an unambiguous UTC epoch second count, and
    // truncation uses getUTC*() accessors, so it's correct no matter what
    // timezone this server process happens to run in.
    const raw = new Date(item.time * 1000);
    const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));

    // Ф5: the same real-world payment counted twice from two independent
    // writers (already happened once this session — Excel import + a
    // recurring template both silently wrote "rent" for the same month).
    // A mono transaction landing in a category+month that already has a
    // recurring-generated or Excel-imported row is a real signal something
    // might double-count — flag it rather than block the write (blocking
    // risks losing a genuine transaction that just happens to share a
    // category with an unrelated recurring payment).
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
        userId: user.id,
        source: 'mono',
        possibleDuplicateOf: possibleDup?.id ?? null,
        monoStatementId: item.id,
        monoMerchant: item.description || null,
        monoMcc: item.mcc ?? null,
        monoAmountOriginal: amountOriginal,
        monoCurrency: CCY_NAMES[item.currencyCode] ?? String(item.currencyCode),
        fxRate,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[webhooks/monobank POST]', e);
    // Non-200 on purpose: Monobank retries a failed delivery a few times,
    // which is the only safety net against a transient error (DB blip, FX
    // endpoint down) actually losing a transaction. Swallowing every error
    // into a 200 would silently drop real pushes instead.
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
