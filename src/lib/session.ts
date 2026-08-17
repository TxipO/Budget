import { createHmac } from 'crypto';
import { NextResponse } from 'next/server';

// Must match SESSION_MAX_AGE_MS in middleware.ts.
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 днів

// Session cookie = "<userId>.<householdId>.<hasPin>.<issuedAt>.<HMAC-SHA256(
// AUTH_SECRET, 'budget-session:'+userId+':'+householdId+':'+hasPin+':'+
// issuedAt)>". Shared by both login paths — a PIN login has no specific
// identity (userId defaults to the literal "shared", matching the original
// behavior: anyone with the PIN acts as the whole household), a Telegram/
// email login passes a real numeric User.id. householdId is always a real
// Household.id — multi-tenant migration phase B: every session is scoped to
// exactly one household, carried in the signed cookie itself (not looked up
// per-request) because middleware runs on the Edge runtime, which this
// project deliberately keeps Prisma-free — see middleware.ts's own comment
// on why.
//
// hasPin (P4 — universal PIN lock) is decided and signed AT ISSUANCE TIME,
// not re-checked from the DB on every request, for the same Edge/no-Prisma
// reason. That means it's a snapshot: setting/removing a PIN via
// api/account/pin reissues this cookie immediately so the lock engages or
// disengages without forcing a full relogin, but any OTHER still-open
// session (a second device, an old tab) keeps acting on the bit it was
// issued with until it naturally re-authenticates. Never trust a
// client-supplied hasPin — it's part of the signed payload specifically so
// it can't be stripped to bypass the lock.
//
// issuedAt is embedded and signed so the server enforces expiry itself (see
// middleware.ts's verifySession) instead of relying solely on the browser
// honoring the cookie's Max-Age.
export function sessionCookieValue(secret: string, householdId: string, userId: string = 'shared', hasPin: boolean = false): string {
  const issuedAt = Date.now();
  const hasPinFlag = hasPin ? '1' : '0';
  const sig = createHmac('sha256', secret).update(`budget-session:${userId}:${householdId}:${hasPinFlag}:${issuedAt}`).digest('hex');
  return `${userId}.${householdId}.${hasPinFlag}.${issuedAt}.${sig}`;
}

// Separate short-lived cookie proving "this already-authenticated session
// also entered the household's PIN correctly" — the lock middleware.ts
// gates on when the session's hasPin bit is set. 24h: long enough that
// reopening the app minutes/hours later doesn't re-prompt, short enough
// that a lost/shared device re-locks itself within a day rather than
// staying open for the full 30-day session lifetime.
export const UNLOCK_MAX_AGE_S = 60 * 60 * 24; // 24 години

// Bound to a specific householdId (signed in) so an unlock cookie minted for
// one household can never unlock a different one — relevant on a shared
// browser profile where a second household's session cookie might also be
// present (e.g. after switching accounts without clearing cookies).
export function unlockCookieValue(secret: string, householdId: string): string {
  const issuedAt = Date.now();
  const sig = createHmac('sha256', secret).update(`budget-unlock:${householdId}:${issuedAt}`).digest('hex');
  return `${householdId}.${issuedAt}.${sig}`;
}

// Shared by every route that issues or reissues auth state (PIN login,
// api/account/pin's set/change/remove, onboarding completion, and every
// Telegram/email login route) — previously each one hand-built the same
// cookieOpts object and res.cookies.set call, and copies had already
// drifted (one always set both cookies, one conditionally cleared the
// unlock cookie, one only ran at all when a PIN was involved). One place
// now decides the cookie attributes; callers only decide the things that
// actually vary: identity, whether the lock is on, and what this response
// should do to the unlock state.
//
// unlock has three meanings, not two — found live 2026-08-19 (/fullreview):
// the six Telegram/email login routes were still hand-rolling their own
// res.cookies.set instead of calling this, specifically because neither
// `true` nor `false` was correct for them. Establishing identity via
// Telegram/email is NOT proof of the household's PIN (so `true` would
// bypass the P4 lock without ever checking it), but this device may
// already have proven the PIN minutes ago on this SAME household — see
// UNLOCK_MAX_AGE_S — so `false` would force a re-prompt that current,
// verified behavior never required. `undefined` (the default) leaves
// whatever unlock cookie the browser already has untouched, which is what
// every one of those six routes actually needs.
export function issueAuthCookies(
  res: NextResponse,
  secret: string,
  opts: { householdId: string; userId?: string; hasPin: boolean; unlock?: boolean },
): void {
  const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/' };
  res.cookies.set('budget-auth', sessionCookieValue(secret, opts.householdId, opts.userId ?? 'shared', opts.hasPin), { ...cookieOpts, maxAge: SESSION_MAX_AGE_S });
  if (opts.unlock === true) {
    res.cookies.set('budget-unlocked', unlockCookieValue(secret, opts.householdId), { ...cookieOpts, maxAge: UNLOCK_MAX_AGE_S });
  } else if (opts.unlock === false) {
    // Explicit clear, not "leave whatever unlock cookie the browser already
    // had" — callers that pass unlock:false mean the lock should NOT be
    // considered open after this response (e.g. removing a PIN), so a stale
    // still-valid unlock cookie from before must not linger.
    res.cookies.set('budget-unlocked', '', { ...cookieOpts, maxAge: 0 });
  }
  // opts.unlock omitted entirely: don't touch the unlock cookie at all.
}
