import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError } from '@/lib/monobank';
import { ingestStatementItem, MonoStatementItem } from '@/lib/monoIngest';

// Push delivery has no guarantee of arriving — Monobank's webhook is
// best-effort, and there is no dashboard or API to inspect missed/failed
// deliveries after the fact. Found live: two settled transfers never
// created a transaction despite a healthy webhook registration, with no
// error logged anywhere (Vercel's log retention had already rolled past
// the window by the time it was noticed). This route is the safety net —
// it re-derives from Monobank's own statement (the source of truth) using
// the exact same ingestStatementItem() the webhook uses, so anything the
// push missed gets picked up here, and anything it already recorded is
// skipped via the monoStatementId uniqueness check inside that function.
const LOOKBACK_DAYS = 7;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, monoTokenEnc: true, monoAccountId: true },
    });
    if (!user || !user.monoTokenEnc || !user.monoAccountId) return badRequest('Не підключено');

    const token = decrypt(user.monoTokenEnc);
    const to = Math.floor(Date.now() / 1000);
    const from = to - LOOKBACK_DAYS * 24 * 3600;

    let items: MonoStatementItem[];
    try {
      items = await getStatement(token, user.monoAccountId, from, to);
    } catch (e) {
      if (e instanceof MonobankError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
      throw e;
    }

    let created = 0;
    let skippedHold = 0;
    let skippedExisting = 0;
    for (const item of items) {
      const result = await ingestStatementItem(user.id, item);
      if (result === 'created') created++;
      else if (result === 'skipped_hold') skippedHold++;
      else if (result === 'skipped_duplicate') skippedExisting++;
    }

    return NextResponse.json({ ok: true, created, skippedHold, skippedExisting, checked: items.length });
  } catch (e) {
    console.error('[monobank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
