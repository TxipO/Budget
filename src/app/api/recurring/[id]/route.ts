import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');

    const body = await req.json();
    const { name, amount, categoryId, userId, details, isActive } = body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim()))
      return badRequest('Назва шаблону обов\'язкова');
    if (amount !== undefined && !isPositiveNumber(Number(amount)))
      return badRequest('Сума має бути більше 0');
    if (categoryId !== undefined && !isPositiveInt(Number(categoryId)))
      return badRequest('Невалідна категорія');
    if (userId !== undefined && !isPositiveInt(Number(userId)))
      return badRequest('Невалідний користувач');

    const template = await prisma.recurringTemplate.update({
      where: { id },
      data: {
        ...(name       !== undefined && { name: name.trim() }),
        ...(amount     !== undefined && { amount: roundMoney(Number(amount)) }),
        ...(categoryId !== undefined && { categoryId: Number(categoryId) }),
        ...(userId     !== undefined && { userId: Number(userId) }),
        ...(details    !== undefined && { details }),
        ...(isActive   !== undefined && { isActive: Boolean(isActive) }),
      },
      include: { category: true, user: true },
    });
    return NextResponse.json(template);
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Шаблон не знайдено' }, { status: 404 });
    console.error('[recurring/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    await prisma.recurringTemplate.update({
      where: { id },
      data: { isActive: false },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Шаблон не знайдено' }, { status: 404 });
    console.error('[recurring/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
