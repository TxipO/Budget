import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';

// Toggles User.sbAutoSync — an explicit opt-in the user flips themselves,
// never turned on implicitly by connecting a bank. Automatically reaching
// into someone's bank on a schedule is a consent decision, not a convenience
// default.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId, enabled } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');
    if (typeof enabled !== 'boolean') return badRequest('Невалідне значення');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { householdId: true, sbSessionEnc: true, sparebankAccounts: { where: { syncEnabled: true }, select: { id: true } } },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (enabled && (!user.sbSessionEnc || user.sparebankAccounts.length === 0)) return badRequest('Спершу підключіть SpareBank 1');

    // Reset the fail counter on every toggle — flipping it off-then-on is a
    // reasonable way for the user to acknowledge past failures and try
    // again, without needing a separate "clear errors" control.
    await prisma.user.update({ where: { id: Number(userId) }, data: { sbAutoSync: enabled, sbSyncFailCount: 0 } });

    return NextResponse.json({ ok: true, autoSync: enabled });
  } catch (e) {
    console.error('[sparebank/auto-sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
