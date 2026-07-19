import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { issueAuthCookies } from '@/lib/session';
import { hashPin, safeEqual, currentPinHash, setPinHash, registerPinFailure, clearPinFailures, pinLockoutResponse, PIN_HOUSEHOLD_ID } from '@/lib/pin';
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
    // Household #1 can't actually remove its PIN — currentPinHash() always
    // falls back to the APP_PIN env var for this household specifically, so
    // a bare setPinHash(null) would silently keep the lock functionally
    // active (hasPinConfigured() stays true, re-locking on the very next
    // login) while telling the user it was removed. PIN login is #1's sole
    // identity mechanism, not just an optional lock — changing is fine,
    // fully disabling isn't a real state this household can be in. Found
    // during deep-review 2026-07-11.
    if (!next && householdId === PIN_HOUSEHOLD_ID) {
      return badRequest('Для цього акаунту PIN не можна прибрати — це основний спосіб входу. Можна лише змінити його.');
    }

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
    // unlock: !!next — setting/changing a PIN while already inside the app
    // shouldn't immediately re-lock the person who just proved it, so the
    // unlock cookie is issued in the same response; removing one means the
    // lock is off, so any stale unlock cookie is cleared instead.
    issueAuthCookies(res, authSecret, { householdId: String(householdId), userId, hasPin: !!next, unlock: !!next });
    return res;
  } catch (e) {
    console.error('[account/pin PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
