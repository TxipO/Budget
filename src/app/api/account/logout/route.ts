import { NextResponse } from 'next/server';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  const expire = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/', maxAge: 0 };
  res.cookies.set('budget-auth', '', expire);
  // Also clear the PIN-lock unlock cookie — otherwise a subsequent login to
  // the same household on this browser would find a stale still-valid
  // unlock cookie and skip the lock screen entirely, without ever having
  // re-entered the PIN.
  res.cookies.set('budget-unlocked', '', expire);
  return res;
}
