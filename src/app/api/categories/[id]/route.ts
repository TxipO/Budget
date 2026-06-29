import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const cat = await prisma.category.update({
      where: { id: parseInt(params.id) },
      data: body,
    });
    return NextResponse.json(cat);
  } catch (e) {
    console.error('[categories/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await prisma.category.update({
      where: { id: parseInt(params.id) },
      data: { isActive: false },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[categories/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
