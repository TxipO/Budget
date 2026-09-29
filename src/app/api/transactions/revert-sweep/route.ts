import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId, isOwnedCategory } from '@/lib/household';
import { merchantKeyOf, SWEEPABLE_SOURCES } from '@/lib/sweepSiblings';

// "Скасувати" on the "також виправлено ще N" toast: turns an apply-to-all
// correction back into "only this one" — the swept rows return to their old
// category, the learned rule returns to what it was, and the primary row is
// marked 'manual' so no later sweep flips it. The client-supplied ids are
// re-verified against the primary row's own merchant key on the server, so a
// crafted list can't name unrelated rows.
const MAX_IDS = 2000;

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { primaryId, sweptIds, fromCategoryId, toCategoryId, ruleBefore } = body;

    if (!isPositiveInt(Number(primaryId))) return badRequest('Невалідний ID');
    if (!Array.isArray(sweptIds) || sweptIds.length === 0 || sweptIds.length > MAX_IDS || !sweptIds.every(x => isPositiveInt(Number(x)))) {
      return badRequest('Невалідний список транзакцій');
    }
    if (!isPositiveInt(Number(fromCategoryId)) || !isPositiveInt(Number(toCategoryId))) return badRequest('Невалідна категорія');
    if (ruleBefore !== null && (!ruleBefore || !isPositiveInt(Number(ruleBefore.categoryId)) || !Number.isInteger(Number(ruleBefore.hitCount)) || Number(ruleBefore.hitCount) < 0)) {
      return badRequest('Невалідне правило');
    }
    if (!(await isOwnedCategory(householdId, Number(fromCategoryId)))) return badRequest('Невалідна категорія');
    if (ruleBefore && !(await isOwnedCategory(householdId, Number(ruleBefore.categoryId)))) return badRequest('Невалідна категорія');

    const primary = await prisma.transaction.findUnique({
      where: { id: Number(primaryId) },
      select: { householdId: true, userId: true, categoryId: true, source: true, monoMerchant: true, details: true },
    });
    if (!primary || primary.householdId !== householdId || !primary.userId || primary.categoryId !== Number(toCategoryId)) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    const merchantKey = merchantKeyOf(primary);
    if (!merchantKey) return badRequest('Неможливо скасувати');

    const candidates = await prisma.transaction.findMany({
      where: {
        id: { in: sweptIds.map(Number) }, householdId, userId: primary.userId,
        categoryId: Number(toCategoryId), categorySource: 'rule', source: { in: SWEEPABLE_SOURCES },
      },
      select: { id: true, source: true, monoMerchant: true, details: true },
    });
    const revertIds = candidates.filter(c => merchantKeyOf(c) === merchantKey).map(c => c.id);

    await prisma.$transaction([
      prisma.transaction.updateMany({
        where: { id: { in: revertIds } },
        data: { categoryId: Number(fromCategoryId), categorySource: 'rule' },
      }),
      prisma.transaction.update({ where: { id: Number(primaryId) }, data: { categorySource: 'manual' } }),
      // Put the rule back exactly as it was — or remove it if this very
      // correction created it. Guarded on the rule still pointing where the
      // correction put it, so a rule changed since then isn't clobbered.
      ruleBefore
        ? prisma.monoCategoryRule.updateMany({
            where: { userId: primary.userId, merchantKey, categoryId: Number(toCategoryId) },
            data: { categoryId: Number(ruleBefore.categoryId), hitCount: Number(ruleBefore.hitCount) },
          })
        : prisma.monoCategoryRule.deleteMany({
            where: { userId: primary.userId, merchantKey, categoryId: Number(toCategoryId) },
          }),
    ]);

    return NextResponse.json({ ok: true, reverted: revertIds.length });
  } catch (e) {
    console.error('[transactions/revert-sweep POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
