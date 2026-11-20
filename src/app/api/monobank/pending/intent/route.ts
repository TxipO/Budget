import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, parseId } from '@/lib/validate';
import { requireHouseholdId, isOwnedUser } from '@/lib/household';
import { loadPending } from '@/lib/monoPending';
import { usableMerchantKey } from '@/lib/merchantKey';

// A category chosen for a Monobank hold that has not settled yet (no
// Transaction exists). Applied by monoIngest.ts when the settled item arrives;
// see PendingCategoryIntent in schema.prisma.
const INTENT_TTL_MS = 14 * 24 * 3600 * 1000; // = the pending list's lookback

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const userId = parseId(body.userId);
    const categoryId = parseId(body.categoryId);
    const holdId = typeof body.holdId === 'string' ? body.holdId : '';
    if (userId === null || !(await isOwnedUser(householdId, userId))) return badRequest('Невалідний користувач');
    if (!holdId || holdId.length > 100) return badRequest('Невалідна покупка');
    if (categoryId === null) return badRequest('Невалідна категорія');
    if (body.scope !== 'one' && body.scope !== 'all') return badRequest('Невалідний режим застосування');

    // Same cached helper as the dashboard list: no extra Monobank call while its cache is fresh.
    const hold = (await loadPending(userId, householdId)).find(h => h.id === holdId);
    // The hold may have settled before the user saved (the cached list can still show it): the
    // row then already exists under the hold's id, and an intent for it could never be consumed.
    const settled = await prisma.transaction.findFirst({
      where: { householdId, userId, monoStatementId: holdId },
      select: { id: true, isTransfer: true, monoMerchant: true, category: { select: { type: true } } },
    });
    if (!hold && !settled) return NextResponse.json({ error: 'Покупка вже не очікує підтвердження' }, { status: 404 });

    // expense/income/savings only — 'transfer' is detected, never picked; active only. A settled
    // row also keeps ingest's rule: an income row cannot take an expense category and vice versa.
    const rowType = settled?.category.type === 'income' ? 'income' : 'expense';
    const cat = await prisma.category.findFirst({ where: { id: categoryId, householdId, isActive: true, type: { in: settled ? [rowType, 'savings'] : ['expense', 'income', 'savings'] } }, select: { id: true } });
    if (!cat) return badRequest('Невалідна категорія');

    if (body.scope === 'all') {
      // The same rule the edit form's "all from this merchant" learns (transactions/[id] PUT).
      const merchantKey = usableMerchantKey(hold?.description ?? settled?.monoMerchant ?? '');
      if (!merchantKey) return badRequest('Для цього продавця не можна створити правило — оберіть «Тільки ця покупка»');
      await prisma.monoCategoryRule.upsert({
        where: { userId_merchantKey: { userId, merchantKey } },
        update: { categoryId, hitCount: { increment: 1 } },
        create: { userId, merchantKey, categoryId, hitCount: 1 },
      });
    }

    if (settled) {
      // Same outcome ingest would have produced; a detected transfer stays excluded (transfer wins).
      if (!settled.isTransfer) {
        await prisma.transaction.update({ where: { id: settled.id }, data: { categoryId, categorySource: body.scope === 'all' ? 'rule' : 'manual' } });
      }
      return NextResponse.json({ categoryId, scope: body.scope, applied: !settled.isTransfer });
    }

    const now = new Date();
    const data = { householdId, categoryId, scope: body.scope as string, createdAt: now, expiresAt: new Date(now.getTime() + INTENT_TTL_MS) };
    // createdAt is refreshed on replace: it starts the decline-prune grace (monoPending.ts).
    const intent = await prisma.pendingCategoryIntent.upsert({
      where: { userId_holdId: { userId, holdId } },
      update: data,
      create: { ...data, userId, holdId, merchantText: hold!.description, amount: hold!.amount, holdTime: new Date(hold!.time * 1000) },
      select: { categoryId: true, scope: true },
    });
    return NextResponse.json(intent);
  } catch (e) {
    console.error('[monobank/pending/intent POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Clears the choice only; a merchant rule learned with scope 'all' stays (it is
// an ordinary rule now — change it from the transaction edit form).
export async function DELETE(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = parseId(req.nextUrl.searchParams.get('userId'));
    const holdId = req.nextUrl.searchParams.get('holdId') ?? '';
    if (userId === null || !holdId) return badRequest('Невалідний запит');
    await prisma.pendingCategoryIntent.deleteMany({ where: { householdId, userId, holdId } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[monobank/pending/intent DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
