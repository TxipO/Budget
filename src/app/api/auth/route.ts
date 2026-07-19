import { NextRequest, NextResponse } from 'next/server';
import { issueAuthCookies } from '@/lib/session';
import { hashPin, safeEqual, currentPinHash, PIN_HOUSEHOLD_ID, registerPinFailure as registerFailure, clearPinFailures as clearFailures, pinLockoutResponse as tooManyAttempts } from '@/lib/pin';

// PIN LOGIN — establishes identity for household #1 (see lib/pin.ts's
// PIN_HOUSEHOLD_ID). Changing/removing a PIN, for household #1 or any other
// household, is api/account/pin's job (P4's universal PIN lock) — this
// route only ever authenticates.
export async function POST(req: NextRequest) {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const blocked = await tooManyAttempts(PIN_HOUSEHOLD_ID);
    if (blocked) return blocked;

    const stored = await currentPinHash(PIN_HOUSEHOLD_ID);
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.pin !== 'string' || !safeEqual(hashPin(body.pin), stored)) {
      await registerFailure(PIN_HOUSEHOLD_ID);
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }
    await clearFailures(PIN_HOUSEHOLD_ID);

    const res = NextResponse.json({ ok: true });
    // Typing the PIN correctly here proves both identity AND the P4 lock in
    // one step — household #1's whole login IS a PIN, so there's no
    // separate /lock screen to also pass right after this succeeds.
    issueAuthCookies(res, secret, { householdId: String(PIN_HOUSEHOLD_ID), hasPin: true, unlock: true });
    return res;
  } catch (e) {
    console.error('[auth POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
