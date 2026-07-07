import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { roundMoney } from '@/lib/validate';
import { ISO_4217, guessCategoryByMcc, normalizeMerchantKey, getCachedExchangeRate } from '@/lib/monobank';

interface StatementItem {
  id: string;
  time: number; // unix seconds
  description: string;
  mcc?: number;
  amount: number; // minor units (kopecks), negative = expense
  currencyCode: number;
}

const CCY_NAMES: Record<number, string> = { 980: 'UAH', 578: 'NOK' };

async function resolveCategoryId(userId: number, txType: 'expense' | 'income', merchantKey: string, mcc: number | undefined): Promise<number> {
  // 1. Learned rule from a manual correction — highest priority, no guessing.
  const rule = await prisma.monoCategoryRule.findUnique({
    where: { userId_merchantKey: { userId, merchantKey } },
  });
  if (rule) return rule.categoryId;

  // 2. Crude MCC guess (Ф4 adds a Claude call as the real fallback on top).
  const mccGuess = guessCategoryByMcc(mcc);
  if (mccGuess) {
    const cat = await prisma.category.findFirst({ where: { name: mccGuess, type: txType, isActive: true } });
    if (cat) return cat.id;
  }

  // 3. Safe fallback — a bucket that always exists for the type.
  const fallbackName = txType === 'expense' ? 'Незрозуміло' : 'Додаткове';
  const fallback = await prisma.category.findFirst({ where: { name: fallbackName, type: txType, isActive: true } });
  if (fallback) return fallback.id;

  // 4. Absolute last resort — any active category of the right type, so an
  // import never crashes even if the expected fallback category was renamed
  // or deleted.
  const any = await prisma.category.findFirst({ where: { type: txType, isActive: true }, orderBy: { id: 'asc' } });
  if (!any) throw new Error(`No active ${txType} category exists to file a Monobank transaction under`);
  return any.id;
}

export async function GET() {
  // Monobank sends a GET to this URL to verify it's alive before accepting a
  // webhook registration — must 200 regardless of whether :secret is a real
  // user's secret or disconnect.ts's inert "disconnected" placeholder.
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: { secret: string } }) {
  try {
    const user = await prisma.user.findUnique({ where: { monoWebhookSecret: params.secret } });
    // 200, not 404: an unrecognized secret (stale/disconnected/probing) isn't
    // an error for Monobank to retry, it's just nothing to do.
    if (!user) return NextResponse.json({ ok: true });

    const body = await req.json();
    if (body?.type !== 'StatementItem') return NextResponse.json({ ok: true });
    const item: StatementItem = body.data?.statementItem;
    if (!item?.id) return NextResponse.json({ ok: true });

    // Idempotent: Monobank redelivering the same event (or its own retry
    // after a slow response) must never create a duplicate transaction.
    const existing = await prisma.transaction.findUnique({ where: { monoStatementId: item.id } });
    if (existing) return NextResponse.json({ ok: true });

    const txType: 'expense' | 'income' = item.amount < 0 ? 'expense' : 'income';
    const amountOriginal = roundMoney(Math.abs(item.amount) / 100);

    let fxRate = 1;
    if (item.currencyCode !== ISO_4217.NOK) {
      fxRate = (await getCachedExchangeRate(item.currencyCode, ISO_4217.NOK)) ?? 1;
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

    await prisma.transaction.create({
      data: {
        date,
        categoryId,
        amount,
        details: item.description || '',
        userId: user.id,
        source: 'mono',
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
