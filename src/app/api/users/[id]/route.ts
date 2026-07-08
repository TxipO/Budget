import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!isPositiveInt(id)) return badRequest('Невалідний ID');

    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return badRequest("Вкажіть ім'я");

    const user = await prisma.user.update({ where: { id }, data: { name }, select: { id: true, name: true } });
    return NextResponse.json(user);
  } catch (e: any) {
    if (e?.code === 'P2002') return badRequest("Це ім'я вже використовується");
    if (e?.code === 'P2025') return badRequest('Користувача не знайдено');
    console.error('[users/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!isPositiveInt(id)) return badRequest('Невалідний ID');

    // Must keep at least one user — deleting the last one would leave the
    // household in a state where every page bounces to /setup again, which
    // should be a deliberate "start over" action, not an accidental
    // one-click side effect.
    const total = await prisma.user.count();
    if (total <= 1) return badRequest('Має залишитися хоча б один користувач');

    // Transaction.userId is optional with an implicit SetNull on delete —
    // their transaction history survives, just becomes unassigned to a
    // specific person. RecurringTemplate.userId is required (Restrict), so
    // block instead of letting Postgres reject it with an opaque FK error.
    const templateCount = await prisma.recurringTemplate.count({ where: { userId: id } });
    if (templateCount > 0) {
      return badRequest('У цього користувача є шаблони — спочатку видаліть або передайте їх іншому користувачу');
    }

    // MonoCategoryRule.userId is also Restrict, but these are just
    // auto-learned categorization rules from past corrections (Ф4b) —
    // nothing financial, safe to drop along with the user rather than
    // blocking the delete over them.
    await prisma.$transaction([
      prisma.monoCategoryRule.deleteMany({ where: { userId: id } }),
      prisma.user.delete({ where: { id } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 'P2025') return badRequest('Користувача не знайдено');
    console.error('[users/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
