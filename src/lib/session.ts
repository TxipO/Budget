import { createHmac } from 'crypto';

// Must match SESSION_MAX_AGE_MS in middleware.ts.
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 днів

// Session cookie = "<userId>.<householdId>.<issuedAt>.<HMAC-SHA256(AUTH_SECRET,
// 'budget-session:'+userId+':'+householdId+':'+issuedAt)>". Shared by both
// login paths — a PIN login has no specific identity (userId defaults to the
// literal "shared", matching the original behavior: anyone with the PIN acts
// as the whole household), a Telegram login passes a real numeric User.id.
// householdId is now always a real Household.id — multi-tenant migration
// phase B: every session is scoped to exactly one household, carried in the
// signed cookie itself (not looked up per-request) because middleware runs
// on the Edge runtime, which this project deliberately keeps Prisma-free —
// see middleware.ts's own comment on why. issuedAt is embedded and signed so
// the server enforces expiry itself (see middleware.ts's verifySession)
// instead of relying solely on the browser honoring the cookie's Max-Age.
export function sessionCookieValue(secret: string, householdId: string, userId: string = 'shared'): string {
  const issuedAt = Date.now();
  const sig = createHmac('sha256', secret).update(`budget-session:${userId}:${householdId}:${issuedAt}`).digest('hex');
  return `${userId}.${householdId}.${issuedAt}.${sig}`;
}
