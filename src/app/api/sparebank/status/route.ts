import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';

// Never touches Enable Banking's own API — just reports what's stored
// locally, same as monobank/status. sbSessionEnc itself never leaves this
// route; only whether it's set. `accounts` reports EVERY real account under
// the consent (see SparebankAccount's own comment on why there can be more
// than one), not just whichever one is syncEnabled — Settings needs to show
// a not-yet-enabled account's label/balance so the user can decide whether
// to turn its own sync on.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const users = await prisma.user.findMany({
      where: { householdId },
      select: {
        id: true, name: true, sbSessionEnc: true, sbValidUntil: true,
        sbAutoSync: true, sbLastAutoSyncAt: true, sbLastAutoSyncOkAt: true, sbSyncFailCount: true, sbLastSyncError: true,
        sparebankAccounts: {
          select: { id: true, label: true, iban: true, syncEnabled: true, lastSyncedAt: true, balanceAmount: true, balanceCurrency: true, balanceFetchedAt: true, categoryId: true },
          orderBy: { id: 'asc' },
        },
      },
      orderBy: { id: 'asc' },
    });
    // Server-side weekly check marker (lib/weeklyCheck.ts) — same for every row; the dashboard
    // badge goes up when it is older than 8 days. Not household data, just a timestamp.
    const weekly = await prisma.appSetting.findUnique({ where: { key: 'weeklyCheck:lastRunAt' } });
    return NextResponse.json(users.map(u => ({
      userId: u.id,
      name: u.name,
      connected: u.sbSessionEnc !== null && u.sparebankAccounts.length > 0,
      validUntil: u.sbValidUntil,
      expired: u.sbValidUntil ? u.sbValidUntil.getTime() < Date.now() : false,
      autoSync: u.sbAutoSync,
      lastAutoSyncAt: u.sbLastAutoSyncAt,
      // Last SUCCESSFUL run; rows from before the column existed: with no failures the last attempt was one.
      lastAutoSyncOkAt: u.sbLastAutoSyncOkAt ?? (u.sbSyncFailCount === 0 ? u.sbLastAutoSyncAt : null),
      weeklyCheckAt: weekly?.value ?? null,
      autoSyncFailCount: u.sbSyncFailCount,
      lastSyncError: u.sbLastSyncError,
      accounts: u.sparebankAccounts.map(a => ({
        id: a.id,
        label: a.label,
        iban: a.iban,
        syncEnabled: a.syncEnabled,
        lastSyncedAt: a.lastSyncedAt,
        balanceAmount: a.balanceAmount,
        balanceCurrency: a.balanceCurrency,
        balanceFetchedAt: a.balanceFetchedAt,
        categoryId: a.categoryId,
      })),
    })));
  } catch (e) {
    console.error('[sparebank/status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
