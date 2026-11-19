import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';
import { loadPending } from '@/lib/monoPending';
import { usableMerchantKey } from '@/lib/merchantKey';

// Holds for the dashboard's "Очікують підтвердження" block, each with the
// category the user already picked for it (intent) if any. The fetch/cache/
// ingest logic lives in lib/monoPending.ts, shared with the intent route.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json([], { status: 401 });
    const userId = Number(req.nextUrl.searchParams.get('userId'));
    if (!Number.isFinite(userId) || userId <= 0) return NextResponse.json([]);

    const holds = await loadPending(userId, householdId);
    if (holds.length === 0) return NextResponse.json([]);

    const intents = await prisma.pendingCategoryIntent.findMany({
      where: { householdId, userId, holdId: { in: holds.map(h => h.id) } },
      select: { holdId: true, categoryId: true, scope: true },
    });
    const byHold = new Map(intents.map(i => [i.holdId, i]));
    return NextResponse.json(holds.map(h => {
      const i = byHold.get(h.id);
      return {
        ...h,
        userId,
        // false = a bare payment-type text ("nettgiro"): no merchant to learn a rule for.
        canLearn: usableMerchantKey(h.description) !== null,
        intent: i ? { categoryId: i.categoryId, scope: i.scope } : null,
      };
    }));
  } catch (e) {
    console.error('[monobank/pending GET]', e);
    return NextResponse.json([]);
  }
}
