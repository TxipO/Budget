import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidType } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const type = req.nextUrl.searchParams.get('type');
    // Deleting a category only sets isActive=false; its transactions stay and still count in totals.
    const includeInactive = req.nextUrl.searchParams.get('includeInactive') === '1';
    const cats = await prisma.category.findMany({
      where: { householdId, ...(includeInactive ? {} : { isActive: true }), ...(type ? { type } : {}) },
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
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name)                    return badRequest('Назва категорії обов\'язкова');
    if (!isValidType(body.type))  return badRequest('Тип має бути income, expense або savings');

    // A soft-deleted category (isActive=false) still owns the unique
    // (household, name, type) slot, so re-adding the same name would hit
    // P2002 "already exists" with nothing visible to the user. Bring the old
    // one back instead (keeps its history); color/icon refreshed if sent.
    // Keyed by name+type: an inactive same-name category of ANOTHER type is
    // not a collision, and retyping a category with transactions would
    // reclassify its history (see categories/[id] PUT).
    const inactive = await prisma.category.findFirst({ where: { householdId, name, type: body.type, isActive: false } });
    if (inactive) {
      const revived = await prisma.category.update({
        where: { id: inactive.id },
        data: {
          isActive: true,
          ...(typeof body.color === 'string' ? { color: body.color } : {}),
          ...(typeof body.icon  === 'string' ? { icon: body.icon }   : {}),
        },
      });
      return NextResponse.json(revived);
    }

    const cat = await prisma.category.create({
      data: {
        name,
        type: body.type,
        householdId,
        ...(typeof body.color === 'string' ? { color: body.color } : {}),
        ...(typeof body.icon  === 'string' ? { icon: body.icon }   : {}),
      },
    });
    return NextResponse.json(cat);
  } catch (e: any) {
    if (e?.code === 'P2002') return badRequest('Така категорія вже існує');
    console.error('[categories POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
