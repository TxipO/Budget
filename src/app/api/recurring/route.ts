import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = new URL(req.url);
    const year  = searchParams.get('year')  ? Number(searchParams.get('year'))  : null;
    const month = searchParams.get('month') ? Number(searchParams.get('month')) : null;

    const templates = await prisma.recurringTemplate.findMany({
      where: { isActive: true, householdId },
      include: { category: true, user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (year && month) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end   = new Date(Date.UTC(year, month, 1));
      const applied = await prisma.transaction.findMany({
        where: { recurringTemplateId: { not: null }, date: { gte: start, lt: end }, householdId },
        select: { recurringTemplateId: true, id: true },
      });
      const appliedMap = new Map(applied.map(t => [t.recurringTemplateId!, t.id]));
      return NextResponse.json(templates.map(t => ({
        ...t,
        applied: appliedMap.has(t.id),
        transactionId: appliedMap.get(t.id) ?? null,
      })));
    }

    return NextResponse.json(templates);
  } catch (e) {
    console.error('[recurring GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { name, amount, categoryId, userId, details } = body;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName)                         return badRequest('Назва шаблону обов\'язкова');
    if (!isPositiveNumber(Number(amount)))    return badRequest('Сума має бути більше 0');
    if (!isPositiveInt(Number(categoryId)))   return badRequest('Невалідна категорія');
    if (!isPositiveInt(Number(userId)))       return badRequest('Невалідний користувач');

    const cat = await prisma.category.findFirst({ where: { id: Number(categoryId), householdId }, select: { id: true } });
    if (!cat) return badRequest('Невалідна категорія');
    const u = await prisma.user.findFirst({ where: { id: Number(userId), householdId }, select: { id: true } });
    if (!u) return badRequest('Невалідний користувач');

    const template = await prisma.recurringTemplate.create({
      data: { name: trimmedName, amount: roundMoney(Number(amount)), categoryId: Number(categoryId), userId: Number(userId), details: details ?? '', householdId },
      include: { category: true, user: { select: { id: true, name: true } } },
    });
    return NextResponse.json(template);
  } catch (e) {
    console.error('[recurring POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
