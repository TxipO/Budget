import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { requireHouseholdId, isOwnedCategory, isOwnedUser } from '@/lib/household';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    if (categoryId !== undefined && !(await isOwnedCategory(householdId, Number(categoryId)))) {
      return badRequest('Невалідна категорія');
    }
    if (userId !== undefined && !(await isOwnedUser(householdId, Number(userId)))) {
      return badRequest('Невалідний користувач');
    }

    // updateMany scoped by householdId — a bare update({where:{id}}) would
    // let one household edit another's template by guessing its id.
    const result = await prisma.recurringTemplate.updateMany({
      where: { id, householdId },
      data: {
        ...(name       !== undefined && { name: name.trim() }),
        ...(amount     !== undefined && { amount: roundMoney(Number(amount)) }),
        ...(categoryId !== undefined && { categoryId: Number(categoryId) }),
        ...(userId     !== undefined && { userId: Number(userId) }),
        ...(details    !== undefined && { details }),
        ...(isActive   !== undefined && { isActive: Boolean(isActive) }),
      },
    });
    if (result.count === 0) return NextResponse.json({ error: 'Шаблон не знайдено' }, { status: 404 });
    const template = await prisma.recurringTemplate.findUnique({
      where: { id },
      include: { category: true, user: { select: { id: true, name: true } } },
    });
    return NextResponse.json(template);
  } catch (e: any) {
    console.error('[recurring/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const result = await prisma.recurringTemplate.updateMany({
      where: { id, householdId },
      data: { isActive: false },
    });
    if (result.count === 0) return NextResponse.json({ error: 'Шаблон не знайдено' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[recurring/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
