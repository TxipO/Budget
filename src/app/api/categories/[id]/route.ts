import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidType } from '@/lib/validate';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const body = await req.json();

    // Whitelist mutable fields — never trust arbitrary body keys
    const data: { name?: string; type?: string; color?: string; icon?: string } = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (body.type !== undefined) {
      if (!isValidType(body.type)) return badRequest('Невалідний тип');
      data.type = body.type;
    }
    if (typeof body.color === 'string') data.color = body.color;
    if (typeof body.icon  === 'string') data.icon  = body.icon;

    const cat = await prisma.category.update({
      where: { id },
      data,
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
