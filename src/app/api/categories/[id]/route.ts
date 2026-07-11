import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidType } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const body = await req.json();

    // Whitelist mutable fields — never trust arbitrary body keys
    const data: { name?: string; type?: string; color?: string; icon?: string } = {};
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim();
    if (body.type !== undefined) {
      if (!isValidType(body.type)) return badRequest('Невалідний тип');
      // Every stats/analytics/export aggregate reads category.type live via
      // the relation, not a snapshot taken when each transaction was
      // written — changing it here would silently reclassify every past
      // transaction under this category (expense -> income or vice versa)
      // in every historical report, with no warning and no audit trail.
      // Confirmed live: a transaction created under an "expense" category
      // showed as "income" in the very next stats query after only the
      // category's type changed, the transaction itself untouched. Not
      // reachable via the current UI (which only ever PUTs color/icon), but
      // the route itself must not allow it regardless of caller.
      const txCount = await prisma.transaction.count({ where: { categoryId: id, householdId } });
      if (txCount > 0) return badRequest('Не можна змінити тип категорії, якщо в ній вже є транзакції — створіть нову категорію замість цього');
      data.type = body.type;
    }
    if (typeof body.color === 'string') data.color = body.color;
    if (typeof body.icon  === 'string') data.icon  = body.icon;

    // updateMany scoped by householdId, not a bare update({ where: { id } }),
    // so a household can never modify another household's category just by
    // guessing/knowing its id — the multi-tenant isolation boundary, same
    // shape as the TOCTOU-safe updateMany pattern already used for claiming
    // a Telegram account (see auth/telegram/register/route.ts).
    const result = await prisma.category.updateMany({ where: { id, householdId }, data });
    if (result.count === 0) return NextResponse.json({ error: 'Категорію не знайдено' }, { status: 404 });
    const cat = await prisma.category.findUnique({ where: { id } });
    return NextResponse.json(cat);
  } catch (e: any) {
    if (e?.code === 'P2002') return badRequest('Така категорія вже існує');
    console.error('[categories/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const result = await prisma.category.updateMany({
      where: { id, householdId },
      data: { isActive: false },
    });
    if (result.count === 0) return NextResponse.json({ error: 'Категорію не знайдено' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[categories/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
