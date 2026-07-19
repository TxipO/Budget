import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isValidDate, isPositiveInt, isPositiveNumber, roundMoney } from '@/lib/validate';
import { normalizeMerchantKey } from '@/lib/monobank';
import { requireHouseholdId, isOwnedCategory, isOwnedUser } from '@/lib/household';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const body = await req.json();

    if (!isValidDate(body.date))                   return badRequest('Невалідна дата');
    if (!isPositiveInt(Number(body.categoryId)))   return badRequest('Невалідна категорія');
    if (!isPositiveNumber(Number(body.amount)))    return badRequest('Сума має бути більше 0');

    const newCategoryId = parseInt(body.categoryId);

    // Read the pre-update row so we can tell whether this is a Monobank- or
    // voice-sourced transaction getting its category corrected — that's the
    // signal MonoCategoryRule learns from (never Claude's own guess), so a
    // repeat merchant/phrase is never re-guessed after being fixed once.
    // Fetched before the update, not after, so we compare against the
    // category that was actually wrong. Also doubles as the household
    // ownership check — a bare update({ where: { id } }) would let one
    // household edit another's transaction just by guessing its id.
    const before = await prisma.transaction.findUnique({
      where: { id },
      select: { source: true, monoMerchant: true, details: true, userId: true, categoryId: true, householdId: true },
    });
    if (!before || before.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    if (!(await isOwnedCategory(householdId, newCategoryId))) return badRequest('Невалідна категорія');
    if (body.userId && !(await isOwnedUser(householdId, parseInt(body.userId)))) return badRequest('Невалідний користувач');

    // Truncate to a clean UTC calendar-day boundary — see the matching
    // comment in transactions/route.ts POST. Found during deep-review
    // 2026-07-11.
    const parsedDate = new Date(body.date);
    const truncatedDate = new Date(Date.UTC(parsedDate.getUTCFullYear(), parsedDate.getUTCMonth(), parsedDate.getUTCDate()));

    const tx = await prisma.transaction.update({
      where: { id },
      data: {
        date:       truncatedDate,
        categoryId: newCategoryId,
        amount:     roundMoney(parseFloat(body.amount)),
        details:    body.details || '',
        userId:     body.userId ? parseInt(body.userId) : null,
      },
      include: { category: true, user: { select: { id: true, name: true } } },
    });

    // Voice transcripts rarely repeat verbatim, so this rarely hits tier 1
    // of guessCategoryId on a *future* message the way a real merchant name
    // does — but per spec.md's US1 acceptance criteria, a voice correction
    // must still reach the same learning mechanism, not be silently
    // excluded. Previously gated on source === 'mono' only, so a voice
    // correction here never ran at all.
    const correctionKey = before?.source === 'mono' ? before.monoMerchant
      : before?.source === 'voice' ? before.details
      : null;
    if (correctionKey && before?.userId && newCategoryId !== before.categoryId) {
      const merchantKey = normalizeMerchantKey(correctionKey);
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

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const owned = await prisma.transaction.findUnique({ where: { id }, select: { householdId: true } });
    if (!owned || owned.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
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
