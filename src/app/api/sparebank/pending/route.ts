import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { loadSparebankPending } from '@/lib/sparebankPending';

// Card reservations for the dashboard's «Очікують підтвердження» block. Called
// only when someone opens the dashboard, so the PSU headers below are genuine
// (attended request — see lib/sparebankPending.ts). Never errors to the client.
export async function GET(req: NextRequest) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json([], { status: 401 });
    const userId = Number(req.nextUrl.searchParams.get('userId'));
    if (!Number.isFinite(userId) || userId <= 0) return NextResponse.json([]);

    // Same PSU sourcing as api/sparebank/sync.
    const psu = {
      ipAddress: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
      userAgent: req.headers.get('user-agent') || undefined,
    };
    const items = await loadSparebankPending(userId, householdId, psu);
    return NextResponse.json(items.map(i => ({ ...i, userId })));
  } catch (e) {
    console.error('[sparebank/pending GET]', e);
    return NextResponse.json([]);
  }
}
