import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PIN_HOUSEHOLD_ID } from '@/lib/pin';
import { requireHouseholdId } from '@/lib/household';

// Not under /api/auth/ — that prefix is middleware's PUBLIC_PREFIXES bypass
// for pre-login routes. This one needs the opposite: it reads
// x-current-user-id, which middleware only sets after verifying a real
// session, so it must go through the normal auth gate like any other page.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Single source of truth for both isPinHousehold and onboarded — derived
    // from the household itself (via the session-carried householdId, never
    // a client-supplied value) rather than assumed from which branch below
    // runs, so it stays correct even for edge cases (e.g. a shared-PIN
    // session for a household that isn't #1, if that ever becomes possible).
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { onboardedAt: true } });
    const onboarded = !!household?.onboardedAt;
    const isPinHousehold = householdId === PIN_HOUSEHOLD_ID;

    const userId = req.headers.get('x-current-user-id');
    if (!userId) return NextResponse.json({ shared: true, isPinHousehold, onboarded });

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, name: true, telegramUsername: true, telegramFirstName: true, email: true },
    });
    if (!user) return NextResponse.json({ shared: true, isPinHousehold, onboarded });
    // Settings' "change PIN" section only makes sense for household #1 —
    // PUT /api/auth always targets PIN_HOUSEHOLD_ID regardless of caller, so
    // showing that form to any other household is a dead end at best (their
    // "current PIN" guess just fails) and confusing regardless.
    return NextResponse.json({ shared: false, user, isPinHousehold, onboarded });
  } catch (e) {
    console.error('[account/me GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
