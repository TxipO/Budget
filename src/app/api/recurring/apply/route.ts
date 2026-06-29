import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidYear, isValidMonth, isPositiveInt } from '@/lib/validate';

export async function POST(req: NextRequest) {
  try {
    const { year, month, templateIds } = await req.json() as { year: number; month: number; templateIds: number[] };

    if (!isValidYear(year))   return badRequest('Невалідний рік');
    if (!isValidMonth(month)) return badRequest('Місяць має бути від 1 до 12');
    if (!Array.isArray(templateIds) || templateIds.length === 0 || !templateIds.every(id => isPositiveInt(id)))
      return badRequest('Невалідний список шаблонів');

    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month, 1);

    const alreadyApplied = await prisma.transaction.findMany({
      where: { recurringTemplateId: { in: templateIds }, date: { gte: start, lt: end } },
      select: { recurringTemplateId: true },
    });
    const appliedSet = new Set(alreadyApplied.map(t => t.recurringTemplateId));

    const toApply = templateIds.filter(id => !appliedSet.has(id));
    if (toApply.length === 0) return NextResponse.json({ applied: 0, skipped: templateIds.length });

    const templates = await prisma.recurringTemplate.findMany({
      where: { id: { in: toApply }, isActive: true },
    });

    await prisma.transaction.createMany({
      data: templates.map(t => ({
        date: new Date(Date.UTC(year, month - 1, 1, 12, 0, 0)),
        categoryId: t.categoryId,
        amount: t.amount,
        details: t.details || t.name,
        userId: t.userId,
        recurringTemplateId: t.id,
      })),
    });

    return NextResponse.json({ applied: templates.length, skipped: appliedSet.size });
  } catch (e) {
    console.error('[recurring/apply POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
