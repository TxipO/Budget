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
    // previousSyncedAt is normally just echoed back verbatim from a sync
    // response we issued seconds earlier — but the client could send
    // anything. A future date here would silently push sbLastSyncedAt ahead
    // of real time, and every later sync would compute dateFrom from THAT,
    // meaning all real transaction history between now and that future date
    // gets skipped with no error anywhere the next time a real sync runs.
    // Found during deep-review 2026-07-22 — same "silent data loss via an
    // unvalidated trust boundary" shape this skill watches for.
    if (previousSyncedAt !== null && (isNaN(Date.parse(previousSyncedAt)) || Date.parse(previousSyncedAt) > Date.now())) {
      return badRequest('Невалідна дата синхронізації');
    }

    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { householdId: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');

    // UNDO_WINDOW_MS caps deletion to rows created moments ago — without
    // this, transactionIds is a client-supplied list of ids that could name
    // ANY of this user's past sparebank transactions (ids are sequential,
    // easy to guess), not just the ones the triggering sync actually just
    // created. householdId + userId + source scoping already stops this from
    // reaching another household's or another source's rows; this stops it
    // reaching this user's OWN older, legitimately-kept sparebank history.
    const UNDO_WINDOW_MS = 60 * 1000;
    await prisma.$transaction([
      prisma.transaction.deleteMany({
        where: {
          id: { in: transactionIds.map(Number) },
          householdId,
          userId: Number(userId),
          source: 'sparebank',
          createdAt: { gte: new Date(Date.now() - UNDO_WINDOW_MS) },
        },
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
