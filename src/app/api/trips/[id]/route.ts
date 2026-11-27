import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, parseDate, parseId } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';
import { utcToday } from '@/lib/travelMode';

// "Завершити": ends the trip today (UTC), or on the given day.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (id === null) return badRequest('Невалідний ID');
    const body = await req.json().catch(() => ({}));
    let endDate = utcToday();
    if (body.endDate !== undefined && body.endDate !== null) {
      const d = typeof body.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.endDate) ? parseDate(body.endDate) : null;
      if (!d) return badRequest('Невалідна дата кінця');
      endDate = d;
    }
    const trip = await prisma.trip.findFirst({ where: { id, householdId }, select: { startDate: true } });
    if (!trip) return NextResponse.json({ error: 'Поїздку не знайдено' }, { status: 404 });
    if (endDate < trip.startDate) endDate = trip.startDate; // ended before it began: a one-day trip
    await prisma.trip.updateMany({ where: { id, householdId }, data: { endDate } });
    return NextResponse.json({ ok: true, endDate: endDate.toISOString().slice(0, 10) });
  } catch (e) {
    console.error('[trips/[id] PATCH]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Undo: rows still filed by travel mode go back to their previous category and
// source; rows the person re-categorised since stay as they are. One transaction,
// so a half-restored trip can't exist.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (id === null) return badRequest('Невалідний ID');
    const trip = await prisma.trip.findFirst({ where: { id, householdId }, select: { id: true } });
    if (!trip) return NextResponse.json({ error: 'Поїздку не знайдено' }, { status: 404 });

    const restored = await prisma.$transaction(async tx => {
      const rows = await tx.transaction.findMany({
        where: { tripId: id, categorySource: 'travel', tripPrevCategoryId: { not: null } },
        select: { id: true, tripPrevCategoryId: true, tripPrevCategorySource: true },
      });
      const groups = new Map<string, number[]>();
      for (const r of rows) {
        const k = `${r.tripPrevCategoryId}|${r.tripPrevCategorySource ?? ''}`;
        groups.set(k, [...(groups.get(k) ?? []), r.id]);
      }
      for (const [k, ids] of groups) {
        const [cat, src] = k.split('|');
        await tx.transaction.updateMany({ where: { id: { in: ids } }, data: { categoryId: Number(cat), categorySource: src || null } });
      }
      await tx.transaction.updateMany({ where: { tripId: id }, data: { tripId: null, tripPrevCategoryId: null, tripPrevCategorySource: null } });
      await tx.trip.delete({ where: { id } });
      return rows.length;
    });
    return NextResponse.json({ ok: true, restored });
  } catch (e) {
    console.error('[trips/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
