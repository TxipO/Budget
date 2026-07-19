import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidYear, isValidMonth, isPositiveInt, isNonNegativeNumber, roundMoney } from '@/lib/validate';
import { requireHouseholdId, isOwnedCategory } from '@/lib/household';

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = req.nextUrl;
    const year  = parseInt(searchParams.get('year')  || '2026');
    const month = searchParams.get('month');
    if (!Number.isFinite(year)) return badRequest('Невалідний рік');

    const where: Record<string, unknown> = { year, householdId };
    if (month) {
      const m = parseInt(month);
      if (!Number.isFinite(m) || m < 1 || m > 12) return badRequest('Невалідний місяць');
      where.month = m;
    }

    const plans = await prisma.monthlyPlan.findMany({
      where,
      include: { category: true },
    });
    return NextResponse.json(plans);
  } catch (e) {
    console.error('[plans GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { year, month, categoryId, plannedAmount, notes } = body;

    if (!isValidYear(year))                          return badRequest('Невалідний рік');
    if (!isValidMonth(month))                        return badRequest('Місяць має бути від 1 до 12');
    if (!isPositiveInt(Number(categoryId)))          return badRequest('Невалідна категорія');
    if (!isNonNegativeNumber(Number(plannedAmount))) return badRequest('Сума не може бути від\'ємною');

    // categoryId already implicitly scopes year_month_categoryId to one
    // household (a category belongs to exactly one), but only once we
    // confirm it belongs to THIS caller's household — otherwise this upsert
    // could silently overwrite another household's plan for their own
    // category id.
    if (!(await isOwnedCategory(householdId, Number(categoryId)))) return badRequest('Невалідна категорія');

    const plan = await prisma.monthlyPlan.upsert({
      where: { year_month_categoryId: { year, month, categoryId } },
      update: { plannedAmount: roundMoney(plannedAmount), notes: notes ?? undefined },
      create: { year, month, categoryId, plannedAmount: roundMoney(plannedAmount), notes: notes ?? '', householdId },
      include: { category: true },
    });
    return NextResponse.json(plan);
  } catch (e) {
    console.error('[plans POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
