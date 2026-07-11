import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ingestStatementItem, MonoStatementItem } from '@/lib/monoIngest';

export async function GET() {
  // Monobank sends a GET to this URL to verify it's alive before accepting a
  // webhook registration — must 200 regardless of whether :secret is a real
  // user's secret or disconnect.ts's inert "disconnected" placeholder.
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest, { params }: { params: { secret: string } }) {
  try {
    const user = await prisma.user.findUnique({ where: { monoWebhookSecret: params.secret }, select: { id: true, householdId: true } });
    // 200, not 404: an unrecognized secret (stale/disconnected/probing) isn't
    // an error for Monobank to retry, it's just nothing to do. A user with no
    // household (shouldn't happen post-backfill) is treated the same way —
    // nothing safe to file the transaction under.
    if (!user || !user.householdId) return NextResponse.json({ ok: true });

    const body = await req.json();
    if (body?.type !== 'StatementItem') return NextResponse.json({ ok: true });
    const item: MonoStatementItem = body.data?.statementItem;
    if (!item?.id) return NextResponse.json({ ok: true });

    await ingestStatementItem(user.id, user.householdId, item);

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
