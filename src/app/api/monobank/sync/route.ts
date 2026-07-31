import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError } from '@/lib/monobank';
import { ingestStatementItem, MonoStatementItem } from '@/lib/monoIngest';
import { requireHouseholdId } from '@/lib/household';

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
//
// 30 days, not 7 — widened 2026-07-23 after finding two real UAH
// transactions (01.07, 12.07) still missing three weeks later: the
// per-item batch-abort bug (fixed same day — one bad currency threw and
// silently dropped every OLDER item in that same call, since Monobank
// returns newest-first) had already caused a gap wider than the old 7-day
// window could ever re-cover on its own. 30 is Monobank's own max span for
// a single statement call, so this costs no extra API calls, just a
// bigger one-time response.
const LOOKBACK_DAYS = 30;

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, householdId: true, monoTokenEnc: true, monoAccountId: true, monoSyncFloor: true },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.monoTokenEnc || !user.monoAccountId) return badRequest('Не підключено');

    const token = decrypt(user.monoTokenEnc);
    const to = Math.floor(Date.now() / 1000);
    // Never let the rolling window cross below a user-set floor — see the
    // field's own schema comment. Without this, every sync re-touches the
    // same rolling 30 days regardless of what was already manually
    // reconciled or deliberately deleted in that range.
    const rollingFrom = to - LOOKBACK_DAYS * 24 * 3600;
    const floorFrom = user.monoSyncFloor ? Math.floor(user.monoSyncFloor.getTime() / 1000) : null;
    const from = floorFrom !== null ? Math.max(rollingFrom, floorFrom) : rollingFrom;

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
    let skippedError = 0;
    for (const item of items) {
      // One bad item (e.g. a currency with no rate available at all) must
      // never abort the whole batch — found live 2026-07-23: a single USD
      // transaction's exchange-rate throw 500'd the entire sync, silently
      // hiding every OTHER legitimate transaction in the same 7-day window
      // behind it, not just the one that actually failed.
      try {
        const result = await ingestStatementItem(user.id, householdId, item);
        if (result === 'created') created++;
        else if (result === 'skipped_hold') skippedHold++;
        else if (result === 'skipped_duplicate') skippedExisting++;
      } catch (e) {
        console.error('[monobank/sync] item failed, continuing with the rest', item.id, e);
        skippedError++;
      }
    }

    return NextResponse.json({ ok: true, created, skippedHold, skippedExisting, skippedError, checked: items.length });
  } catch (e) {
    console.error('[monobank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
