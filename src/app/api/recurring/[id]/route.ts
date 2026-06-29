import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const { name, amount, categoryId, userId, details, isActive } = body;
    const template = await prisma.recurringTemplate.update({
      where: { id: Number(params.id) },
      data: {
        ...(name       !== undefined && { name }),
        ...(amount     !== undefined && { amount: Number(amount) }),
        ...(categoryId !== undefined && { categoryId: Number(categoryId) }),
        ...(userId     !== undefined && { userId: Number(userId) }),
        ...(details    !== undefined && { details }),
        ...(isActive   !== undefined && { isActive }),
      },
      include: { category: true, user: true },
    });
    return NextResponse.json(template);
  } catch (e) {
    console.error('[recurring/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await prisma.recurringTemplate.update({
      where: { id: Number(params.id) },
      data: { isActive: false },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[recurring/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
