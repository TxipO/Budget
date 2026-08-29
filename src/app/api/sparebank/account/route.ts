import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

// Renames an account's display label, toggles whether ITS OWN transactions
// get pulled into the household budget, and/or maps it onto a tracked
// savings category (Ф2 — see SparebankAccount.categoryId's own schema
// comment for why this replaced four separate guesses in
// sparebankIngest.ts) — all household-member-facing controls over
// SparebankAccount, separate from the whole-consent User.sbAutoSync
// (schedule) toggle. Turning syncEnabled off does not touch any transaction
// already recorded — only future syncs stop reaching this specific account.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { accountId, label, syncEnabled, categoryId } = body;
    if (!isPositiveInt(Number(accountId))) return badRequest('Невалідний рахунок');
    if (label !== undefined && (typeof label !== 'string' || !label.trim())) return badRequest('Невалідна назва');
    if (syncEnabled !== undefined && typeof syncEnabled !== 'boolean') return badRequest('Невалідне значення');
    // null clears the mapping (this account isn't a tracked pool); anything
    // else must be a real, positive category id.
    if (categoryId !== undefined && categoryId !== null && !isPositiveInt(Number(categoryId))) return badRequest('Невалідна категорія');

    const account = await prisma.sparebankAccount.findUnique({
      where: { id: Number(accountId) },
      select: { userId: true, user: { select: { householdId: true } } },
    });
    if (!account || account.user.householdId !== householdId) return badRequest('Рахунок не знайдено');

    const data: { label?: string; syncEnabled?: boolean; lastSyncedAt?: Date; categoryId?: number | null } = {};
    if (label !== undefined) data.label = label.trim();
    if (syncEnabled !== undefined) {
      data.syncEnabled = syncEnabled;
      // Turning sync ON for an account that's never been synced starts its
      // watermark at "now" — same "forward only, no automatic historical
      // backfill" default every other connect path in this app already uses.
      if (syncEnabled) {
        const current = await prisma.sparebankAccount.findUnique({ where: { id: Number(accountId) }, select: { lastSyncedAt: true } });
        if (!current?.lastSyncedAt) data.lastSyncedAt = new Date();
      }
    }
    if (categoryId !== undefined) {
      if (categoryId === null) {
        data.categoryId = null;
      } else {
        // Must be this household's own, active, type "savings" category —
        // the whole point of this field is "this account IS a tracked
        // savings pool", so anything else would silently break the
        // withdrawal-sign logic that reads it.
        const cat = await prisma.category.findUnique({ where: { id: Number(categoryId) }, select: { householdId: true, isActive: true, type: true } });
        if (!cat || cat.householdId !== householdId || !cat.isActive || cat.type !== 'savings') return badRequest('Категорія має бути активною категорією типу "Збереження"');
        data.categoryId = Number(categoryId);
      }
    }

    const updated = await prisma.sparebankAccount.update({ where: { id: Number(accountId) }, data, select: { id: true, label: true, syncEnabled: true, categoryId: true } });
    return NextResponse.json({ ok: true, account: updated });
  } catch (e) {
    console.error('[sparebank/account POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
