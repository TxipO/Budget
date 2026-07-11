import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PIN_HOUSEHOLD_ID } from '@/lib/pin';

// Not under /api/auth/ — that prefix is middleware's PUBLIC_PREFIXES bypass
// for pre-login routes. This one needs the opposite: it reads
// x-current-user-id, which middleware only sets after verifying a real
// session, so it must go through the normal auth gate like any other page.
export async function GET(req: NextRequest) {
  try {
    const userId = req.headers.get('x-current-user-id');
    // No specific user picked — only possible for a bare PIN login, and PIN
    // login only ever exists for household #1 (see lib/pin.ts's
    // PIN_HOUSEHOLD_ID), so this case is unconditionally that household.
    if (!userId) return NextResponse.json({ shared: true, isPinHousehold: true });

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, name: true, telegramUsername: true, telegramFirstName: true, email: true, householdId: true },
    });
    if (!user) return NextResponse.json({ shared: true, isPinHousehold: true });
    // Settings' "change PIN" section only makes sense for household #1 —
    // PUT /api/auth always targets PIN_HOUSEHOLD_ID regardless of caller, so
    // showing that form to any other household is a dead end at best (their
    // "current PIN" guess just fails) and confusing regardless.
    const { householdId, ...publicUser } = user;
    return NextResponse.json({ shared: false, user: publicUser, isPinHousehold: householdId === PIN_HOUSEHOLD_ID });
  } catch (e) {
    console.error('[account/me GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
