import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, parseId } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';
import { tripAccountOptions, tripCandidates } from '@/lib/travelMode';

// Rows the rule would move into the trip now. Read-only: nothing is written until /apply.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (id === null) return badRequest('Невалідний ID');
    const trip = await prisma.trip.findFirst({ where: { id, householdId }, select: { id: true, householdId: true, startDate: true, endDate: true, accounts: true, categoryId: true } });
    if (!trip) return NextResponse.json({ error: 'Поїздку не знайдено' }, { status: 404 });
    const [rows, accounts] = await Promise.all([tripCandidates(trip), tripAccountOptions(householdId)]);
    const label = new Map(accounts.map(a => [a.key, a.label]));
    return NextResponse.json(rows.map(r => ({
      id: r.id, date: r.date.toISOString().slice(0, 10), merchant: r.merchant, amount: r.amount,
      currentCategory: { id: r.categoryId, name: r.categoryName }, account: label.get(r.account) ?? r.account,
    })));
  } catch (e) {
    console.error('[trips/[id]/preview GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
