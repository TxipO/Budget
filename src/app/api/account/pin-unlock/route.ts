import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { unlockCookieValue, UNLOCK_MAX_AGE_S } from '@/lib/session';
import { hashPin, safeEqual, currentPinHash, registerPinFailure, clearPinFailures, pinLockoutResponse } from '@/lib/pin';

// The /lock screen's action — proves the caller knows the ALREADY-configured
// PIN for their own household (identity is already established by the
// session itself; this route never creates a session, only the unlock
// cookie middleware.ts's P4 gate checks for). In middleware.ts's
// LOCKED_ALLOWLIST so it stays reachable even while locked — otherwise
// there'd be no way to ever unlock at all.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const blocked = await pinLockoutResponse(householdId);
    if (blocked) return blocked;

    const stored = await currentPinHash(householdId);
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body?.pin !== 'string' || !safeEqual(hashPin(body.pin), stored)) {
      await registerPinFailure(householdId);
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }
    await clearPinFailures(householdId);

    const res = NextResponse.json({ ok: true });
    res.cookies.set('budget-unlocked', unlockCookieValue(authSecret, String(householdId)), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: UNLOCK_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[account/pin-unlock POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
