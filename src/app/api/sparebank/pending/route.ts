import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { prisma } from '@/lib/prisma';
import { loadSparebankPending } from '@/lib/sparebankPending';
import { usableMerchantKey } from '@/lib/merchantKey';

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
    if (items.length === 0) return NextResponse.json([]);
    // Same shape as monobank/pending: the category already picked for each reservation, if any.
    const intents = await prisma.pendingCategoryIntent.findMany({
      where: { householdId, userId, bank: 'sparebank', holdId: { in: items.map(i => i.id) } },
      select: { holdId: true, categoryId: true, scope: true },
    });
    const byHold = new Map(intents.map(i => [i.holdId, i]));
    return NextResponse.json(items.map(i => {
      const t = byHold.get(i.id);
      return { ...i, userId, canLearn: usableMerchantKey(i.description) !== null, intent: t ? { categoryId: t.categoryId, scope: t.scope } : null };
    }));
  } catch (e) {
    console.error('[sparebank/pending GET]', e);
    return NextResponse.json([]);
  }
}
