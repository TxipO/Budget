import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber } from '@/lib/validate';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const year  = searchParams.get('year');
    const month = searchParams.get('month');
    const type  = searchParams.get('type');
    const limitParam = searchParams.get('limit');

    const where: Record<string, unknown> = {};
    let take: number | undefined;

    if (year && month) {
      const y = parseInt(year), m = parseInt(month);
      if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12)
        return badRequest('Невалідний рік або місяць');
      where.date = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    } else if (year) {
      const y = parseInt(year);
      if (!Number.isFinite(y)) return badRequest('Невалідний рік');
      where.date = { gte: new Date(y, 0, 1), lt: new Date(y + 1, 0, 1) };
      const lim = limitParam ? parseInt(limitParam) : 500;
      take = Number.isFinite(lim) && lim > 0 ? lim : 500;
    } else {
      const lim = limitParam ? parseInt(limitParam) : 100;
      take = Number.isFinite(lim) && lim > 0 ? lim : 100;
    }

    if (type) {
      where.category = { type };
    }

    const txs = await prisma.transaction.findMany({
      where,
      include: { category: true, user: true },
      orderBy: { date: 'desc' },
      ...(take !== undefined ? { take } : {}),
    });
    return NextResponse.json(txs);
  } catch (e) {
    console.error('[transactions GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { date, categoryId, amount, details, userId } = body;

    if (!isValidDate(date))                  return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(categoryId)))  return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(amount)))   return badRequest('Сума має бути більше 0');

    const tx = await prisma.transaction.create({
      data: {
        date:       new Date(date),
        categoryId: parseInt(categoryId),
        amount:     parseFloat(amount),
        details:    details || '',
        userId:     userId ? parseInt(userId) : null,
      },
      include: { category: true, user: true },
    });
    return NextResponse.json(tx, { status: 201 });
  } catch (e) {
    console.error('[transactions POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
