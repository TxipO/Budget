import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { normalizeMerchantKey } from '@/lib/monobank';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const body = await req.json();

    if (!isValidDate(body.date))                   return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(body.categoryId)))   return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(body.amount)))    return badRequest('Сума має бути більше 0');

    const newCategoryId = parseInt(body.categoryId);

    // Read the pre-update row so we can tell whether this is a Monobank-
    // imported transaction getting its category corrected — that's the
    // ONLY signal MonoCategoryRule ever learns from (never Claude's own
    // guess), so a repeat merchant is never re-guessed after being fixed
    // once. Fetched before the update, not after, so we compare against
    // the category that was actually wrong.
    const before = await prisma.transaction.findUnique({
      where: { id },
      select: { source: true, monoMerchant: true, userId: true, categoryId: true },
    });

    const tx = await prisma.transaction.update({
      where: { id },
      data: {
        date:       new Date(body.date),
        categoryId: newCategoryId,
        amount:     roundMoney(parseFloat(body.amount)),
        details:    body.details || '',
        userId:     body.userId ? parseInt(body.userId) : null,
      },
      include: { category: true, user: { select: { id: true, name: true } } },
    });

    if (before?.source === 'mono' && before.monoMerchant && before.userId && newCategoryId !== before.categoryId) {
      const merchantKey = normalizeMerchantKey(before.monoMerchant);
      await prisma.monoCategoryRule.upsert({
        where: { userId_merchantKey: { userId: before.userId, merchantKey } },
        update: { categoryId: newCategoryId, hitCount: { increment: 1 } },
        create: { userId: before.userId, merchantKey, categoryId: newCategoryId, hitCount: 1 },
      });
    }

    return NextResponse.json(tx);
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    console.error('[transactions/[id] PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    // possibleDuplicateOf is a plain Int, not a real FK relation (deliberately —
    // see Ф5), so Postgres won't clean up references to this row on its own.
    // Clear them first so deleting the "original" of a flagged pair never
    // leaves the flagged row pointing at a transaction that no longer exists.
    await prisma.transaction.updateMany({ where: { possibleDuplicateOf: id }, data: { possibleDuplicateOf: null } });
    await prisma.transaction.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    console.error('[transactions/[id] DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
