import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidYear, isValidMonth, isPositiveInt, isNonNegativeNumber } from '@/lib/validate';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const year  = parseInt(searchParams.get('year')  || '2026');
    const month = searchParams.get('month');

    const where: Record<string, unknown> = { year };
    if (month) where.month = parseInt(month);

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
    const body = await req.json();
    const { year, month, categoryId, plannedAmount, notes } = body;

    if (!isValidYear(year))                          return badRequest('Невалідний рік');
    if (!isValidMonth(month))                        return badRequest('Місяць має бути від 1 до 12');
    if (!isPositiveInt(Number(categoryId)))          return badRequest('Невалідна категорія');
    if (!isNonNegativeNumber(Number(plannedAmount))) return badRequest('Сума не може бути від\'ємною');

    const plan = await (prisma.monthlyPlan as any).upsert({
      where: { year_month_categoryId: { year, month, categoryId } },
      update: { plannedAmount, notes: notes ?? undefined },
      create: { year, month, categoryId, plannedAmount, notes: notes ?? '' },
      include: { category: true },
    });
    return NextResponse.json(plan);
  } catch (e) {
    console.error('[plans POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
