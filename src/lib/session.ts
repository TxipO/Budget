import { createHmac } from 'crypto';

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
