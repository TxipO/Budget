import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { sessionCookieValue, unlockCookieValue, SESSION_MAX_AGE_S, UNLOCK_MAX_AGE_S } from '@/lib/session';
import { hashPin, safeEqual, currentPinHash, setPinHash, registerPinFailure, clearPinFailures, pinLockoutResponse } from '@/lib/pin';
import { badRequest } from '@/lib/validate';

const PIN_FORMAT = /^\d{4,8}$/;

// Set / change / remove the PIN lock for the CALLER's own household — works
// for any household, not just #1 (see project's P4 plan: PIN login itself
// stays exclusive to household #1, but the lock is universal). `next` empty
// or absent removes the PIN. `current` is required whenever the household
// already has a PIN (to prove you're not a stranger with a stolen session
// turning the lock off); not required the very first time one is set.
export async function PUT(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const next = typeof body?.next === 'string' ? body.next : '';
    if (next && !PIN_FORMAT.test(next)) return badRequest('PIN — від 4 до 8 цифр');

    const stored = await currentPinHash(householdId);
    if (stored) {
      const blocked = await pinLockoutResponse(householdId);
      if (blocked) return blocked;
      if (typeof body?.current !== 'string' || !safeEqual(hashPin(body.current), stored)) {
        await registerPinFailure(householdId);
        return NextResponse.json({ error: 'Невірний поточний PIN' }, { status: 401 });
      }
      await clearPinFailures(householdId);
    }

    await setPinHash(householdId, next ? hashPin(next) : null);

    // Reissue the session cookie with the fresh hasPin bit immediately —
    // otherwise the lock wouldn't engage/disengage until the next full
    // login (see lib/session.ts's comment on why hasPin is a snapshot).
    // userId must be preserved exactly as middleware set it: 'shared' for a
    // bare PIN session (x-current-user-id absent), the real id otherwise.
    const userId = req.headers.get('x-current-user-id') ?? 'shared';
    const res = NextResponse.json({ ok: true, hasPin: !!next });
    const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
    res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(householdId), userId, !!next), { ...cookieOpts, maxAge: SESSION_MAX_AGE_S });
    if (next) {
      // Setting/changing a PIN while already inside the app shouldn't
      // immediately re-lock the person who just proved it — issue the
      // unlock cookie in the same response.
      res.cookies.set('budget-unlocked', unlockCookieValue(authSecret, String(householdId)), { ...cookieOpts, maxAge: UNLOCK_MAX_AGE_S });
    } else {
      res.cookies.set('budget-unlocked', '', { ...cookieOpts, maxAge: 0 });
    }
    return res;
  } catch (e) {
    console.error('[account/pin PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
