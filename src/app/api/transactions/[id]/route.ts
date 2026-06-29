import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber } from '@/lib/validate';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();

    if (!isValidDate(body.date))                   return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(body.categoryId)))   return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(body.amount)))    return badRequest('Сума має бути більше 0');

    const tx = await prisma.transaction.update({
      where: { id: parseInt(params.id) },
      data: {
        date:       new Date(body.date),
        categoryId: parseInt(body.categoryId),
        amount:     parseFloat(body.amount),
        details:    body.details || '',
        userId:     body.userId ? parseInt(body.userId) : null,
      },
      include: { category: true, user: true },
    });
    return NextResponse.json(tx);
  } catch (e) {
    console.error('[transactions/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    await prisma.transaction.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    console.error('[transactions/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
