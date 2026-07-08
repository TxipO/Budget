import { createHmac } from 'crypto';

// Must match SESSION_MAX_AGE_MS in middleware.ts.
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 днів

// Session cookie = "<userId>.<issuedAt>.<HMAC-SHA256(AUTH_SECRET, 'budget-session:'+userId+':'+issuedAt)>".
// Shared by both login paths — a PIN login has no specific identity (userId
// defaults to the literal "shared", matching the original behavior: anyone
// with the PIN acts as the whole household), a Telegram login passes a real
// numeric User.id. issuedAt is embedded and signed so the server enforces
// expiry itself (see middleware.ts's verifySession) instead of relying
// solely on the browser honoring the cookie's Max-Age.
export function sessionCookieValue(secret: string, userId: string = 'shared'): string {
  const issuedAt = Date.now();
  const sig = createHmac('sha256', secret).update(`budget-session:${userId}:${issuedAt}`).digest('hex');
  return `${userId}.${issuedAt}.${sig}`;
}
