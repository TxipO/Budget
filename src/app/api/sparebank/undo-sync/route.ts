import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

// Sync commits to the DB immediately (unlike the single-transaction delete's
// delay-then-write pattern), so its "Скасувати" undo has to be a real
// reversal — this deletes exactly the rows the triggering sync call
// reported creating and restores the sbLastSyncedAt watermark to what it
// was before that sync, so the next real sync re-covers the same window
// instead of silently treating it as already-seen.
const MAX_IDS = 2000; // generous — a single sync's created-row count should never realistically approach this

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId, transactionIds, previousSyncedAt } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');
    if (!Array.isArray(transactionIds) || transactionIds.length === 0 || transactionIds.length > MAX_IDS
      || !transactionIds.every(id => isPositiveInt(Number(id)))) {
      return badRequest('Невалідний список транзакцій');
    }
    if (previousSyncedAt !== null && isNaN(Date.parse(previousSyncedAt))) {
      return badRequest('Невалідна дата синхронізації');
    }

    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { householdId: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');

    await prisma.$transaction([
      // householdId + userId + source scoping means this can only ever
      // remove this specific user's own sparebank rows, even if the id list
      // were tampered with client-side.
      prisma.transaction.deleteMany({
        where: { id: { in: transactionIds.map(Number) }, householdId, userId: Number(userId), source: 'sparebank' },
      }),
      prisma.user.update({
        where: { id: Number(userId) },
        data: { sbLastSyncedAt: previousSyncedAt ? new Date(previousSyncedAt) : null },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[sparebank/undo-sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
