import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId, isOwnedCategory } from '@/lib/household';
import { merchantKeyOf, findSweepSiblings } from '@/lib/sweepSiblings';

// Read-only: what would "apply to every transaction from this merchant" do if
// the user changes this row's category to `categoryId`? TransactionForm calls
// this before saving so it can ask "only this one, or all of them?" instead
// of silently sweeping (see PUT /api/transactions/[id]'s scope comment).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseInt(params.id);
    if (!Number.isFinite(id) || id <= 0) return badRequest('Невалідний ID');
    const newCategoryId = Number(req.nextUrl.searchParams.get('categoryId'));
    if (!isPositiveInt(newCategoryId)) return badRequest('Невалідна категорія');

    const row = await prisma.transaction.findUnique({
      where: { id },
      select: { source: true, monoMerchant: true, details: true, userId: true, categoryId: true, categorySource: true, householdId: true },
    });
    if (!row || row.householdId !== householdId) {
      return NextResponse.json({ error: 'Транзакцію не знайдено' }, { status: 404 });
    }
    if (!(await isOwnedCategory(householdId, newCategoryId))) return badRequest('Невалідна категорія');

    const merchantKey = row.userId && newCategoryId !== row.categoryId ? merchantKeyOf(row) : null;
    if (!merchantKey) return NextResponse.json({ applicable: false });

    const [siblings, rule] = await Promise.all([
      findSweepSiblings({ householdId, userId: row.userId!, categoryId: row.categoryId, merchantKey, excludeId: id }),
      prisma.monoCategoryRule.findUnique({
        where: { userId_merchantKey: { userId: row.userId!, merchantKey } },
        select: { categoryId: true, category: { select: { name: true } } },
      }),
    ]);

    const conflictingRule = rule && rule.categoryId !== newCategoryId ? { categoryName: rule.category.name } : null;
    // Ask only when there's something a wrong answer could damage: other
    // rows that would move, or an existing rule that would be overwritten.
    // A brand-new merchant with neither just learns the rule silently.
    const needsChoice = siblings.length > 0 || conflictingRule !== null;
    // A rule/brand/manual category is something the user (or their earlier
    // corrections) put there on purpose — changing it is more likely an
    // exception. Anything else (fallback/llm/keyword/mcc/self-named/none) is
    // the system's own guess being corrected, which is more likely a real fix.
    const defaultScope: 'one' | 'merchant' = ['rule', 'brand', 'manual'].includes(row.categorySource ?? '') ? 'one' : 'merchant';

    return NextResponse.json({
      applicable: true,
      needsChoice,
      defaultScope,
      siblings: siblings.length,
      existingRule: conflictingRule,
      merchantLabel: row.source === 'mono' ? row.monoMerchant : row.details,
    });
  } catch (e) {
    console.error('[transactions/[id]/sweep-preview GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
