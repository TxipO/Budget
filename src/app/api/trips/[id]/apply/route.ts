import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, parseId } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';
import { tripCandidates } from '@/lib/travelMode';

const MAX_IDS = 2000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (id === null) return badRequest('Невалідний ID');
    const body = await req.json();
    const ids: unknown = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every(isPositiveInt)) return badRequest('Невалідний список транзакцій');
    const trip = await prisma.trip.findFirst({ where: { id, householdId }, select: { id: true, householdId: true, startDate: true, endDate: true, accounts: true, categoryId: true } });
    if (!trip) return NextResponse.json({ error: 'Поїздку не знайдено' }, { status: 404 });

    // Re-run the rule server-side: an id that no longer qualifies (edited since the
    // preview, or never qualified) is silently skipped, never forced.
    const wanted = new Set<number>(ids);
    const rows = (await tripCandidates(trip)).filter(c => wanted.has(c.id));
    const results = await prisma.$transaction(rows.map(r => prisma.transaction.updateMany({
      // categoryId in the guard: a hand edit landing between the check and this write wins.
      where: { id: r.id, categoryId: r.categoryId },
      data: { categoryId: trip.categoryId, categorySource: 'travel', tripId: trip.id, tripPrevCategoryId: r.categoryId, tripPrevCategorySource: r.categorySource },
    })));
    return NextResponse.json({ count: results.reduce((n, x) => n + x.count, 0) });
  } catch (e) {
    console.error('[trips/[id]/apply POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
