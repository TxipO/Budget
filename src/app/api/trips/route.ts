import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, parseDate, roundMoney } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';
import { ensureTravelCategory, tripAccountOptions, utcToday } from '@/lib/travelMode';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const [trips, sums, accounts] = await Promise.all([
      prisma.trip.findMany({ where: { householdId }, orderBy: [{ startDate: 'desc' }, { id: 'desc' }] }),
      // Only rows still filed by travel mode; a hand-corrected row drops out of the total.
      prisma.transaction.groupBy({ by: ['tripId'], where: { householdId, tripId: { not: null }, categorySource: 'travel', isTransfer: false }, _sum: { amount: true } }),
      tripAccountOptions(householdId),
    ]);
    const total = new Map(sums.map(s => [s.tripId, s._sum.amount ?? 0]));
    const today = utcToday();
    return NextResponse.json({
      trips: trips.map(t => ({
        id: t.id, name: t.name, accounts: t.accounts,
        startDate: t.startDate.toISOString().slice(0, 10),
        endDate: t.endDate ? t.endDate.toISOString().slice(0, 10) : null,
        active: t.endDate === null || t.endDate >= today,
        total: roundMoney(total.get(t.id) ?? 0),
      })),
      accounts,
    });
  } catch (e) {
    console.error('[trips GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) return badRequest('Назва поїздки обов\'язкова (до 60 символів)');
    if (typeof body.startDate !== 'string' || !DAY_RE.test(body.startDate)) return badRequest('Невалідна дата початку');
    const startDate = parseDate(body.startDate);
    if (!startDate) return badRequest('Невалідна дата початку');
    let endDate: Date | null = null;
    if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
      if (typeof body.endDate !== 'string' || !DAY_RE.test(body.endDate)) return badRequest('Невалідна дата кінця');
      endDate = parseDate(body.endDate);
      if (!endDate) return badRequest('Невалідна дата кінця');
      if (endDate < startDate) return badRequest('Кінець поїздки раніше за початок');
    }
    const allowed = new Set((await tripAccountOptions(householdId)).map(a => a.key));
    const accounts: unknown = body.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts.every(a => typeof a === 'string' && allowed.has(a))) {
      return badRequest('Оберіть рахунки поїздки');
    }

    const categoryId = await ensureTravelCategory(householdId);
    const trip = await prisma.trip.create({
      data: { householdId, name, startDate, endDate, accounts: Array.from(new Set(accounts as string[])), categoryId },
      select: { id: true },
    });
    return NextResponse.json({ id: trip.id });
  } catch (e) {
    console.error('[trips POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
