import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidType } from '@/lib/validate';

export async function GET(req: NextRequest) {
  try {
    const type = req.nextUrl.searchParams.get('type');
    const cats = await prisma.category.findMany({
      where: { isActive: true, ...(type ? { type } : {}) },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(cats);
  } catch (e) {
    console.error('[categories GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name)                    return badRequest('Назва категорії обов\'язкова');
    if (!isValidType(body.type))  return badRequest('Тип має бути income, expense або savings');

    const cat = await prisma.category.create({ data: { ...body, name } });
    return NextResponse.json(cat);
  } catch (e) {
    console.error('[categories POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
