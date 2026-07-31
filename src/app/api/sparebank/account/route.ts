import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

// Renames an account's display label and/or toggles whether ITS OWN
// transactions get pulled into the household budget — a household-member-
// facing control over SparebankAccount, separate from the whole-consent
// User.sbAutoSync (schedule) toggle. Turning syncEnabled off does not touch
// any transaction already recorded — only future syncs stop reaching this
// specific account.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { accountId, label, syncEnabled } = body;
    if (!isPositiveInt(Number(accountId))) return badRequest('Невалідний рахунок');
    if (label !== undefined && (typeof label !== 'string' || !label.trim())) return badRequest('Невалідна назва');
    if (syncEnabled !== undefined && typeof syncEnabled !== 'boolean') return badRequest('Невалідне значення');

    const account = await prisma.sparebankAccount.findUnique({
      where: { id: Number(accountId) },
      select: { userId: true, user: { select: { householdId: true } } },
    });
    if (!account || account.user.householdId !== householdId) return badRequest('Рахунок не знайдено');

    const data: { label?: string; syncEnabled?: boolean; lastSyncedAt?: Date } = {};
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

    const updated = await prisma.sparebankAccount.update({ where: { id: Number(accountId) }, data, select: { id: true, label: true, syncEnabled: true } });
    return NextResponse.json({ ok: true, account: updated });
  } catch (e) {
    console.error('[sparebank/account POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
