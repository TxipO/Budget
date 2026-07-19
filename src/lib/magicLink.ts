import { createHmac } from 'crypto';
import { safeEqual } from '@/lib/pin';

// Short-lived HMAC-signed tokens for the email magic-link flow — same shape
// as lib/telegramAuth.ts's signPendingRegistration/verifyPendingRegistration,
// kept as separate functions rather than a shared generic because the two
// carry different payloads (a plain email string here vs a whole Telegram
// identity there) and evolved from different trust boundaries.

const LINK_MAX_AGE_MS = 15 * 60 * 1000; // 15 хвилин — час на клік по листу
const REGISTRATION_MAX_AGE_MS = 10 * 60 * 1000; // 10 хвилин на форму імені
const CLOCK_SKEW_TOLERANCE_MS = 5000;

function sign(secret: string, namespace: string, email: string, issuedAt: number): string {
  const payload = Buffer.from(email).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${namespace}:${payload}:${issuedAt}`).digest('hex');
  return `${payload}.${issuedAt}.${sig}`;
}

function verify(secret: string, namespace: string, token: string, maxAgeMs: number): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [payload, issuedAtStr, sig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return null;
  const age = Date.now() - issuedAt;
  if (age < -CLOCK_SKEW_TOLERANCE_MS || age > maxAgeMs) return null;
  const expected = createHmac('sha256', secret).update(`${namespace}:${payload}:${issuedAt}`).digest('hex');
  if (!safeEqual(sig, expected)) return null;
  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// The link emailed to the user — proves whoever clicks it controls the inbox.
export function signMagicLinkToken(secret: string, email: string): string {
  return sign(secret, 'magic-link', email, Date.now());
}

export function verifyMagicLinkToken(secret: string, token: string): string | null {
  return verify(secret, 'magic-link', token, LINK_MAX_AGE_MS);
}

// Minted only after a magic-link token has already been verified once (see
// api/auth/magic-link/verify) — carries the now-proven email through the
// browser-side "what's your name" step without re-sending another email.
export function signPendingEmailRegistration(secret: string, email: string): string {
  return sign(secret, 'pending-email-registration', email, Date.now());
}

export function verifyPendingEmailRegistration(secret: string, token: string): string | null {
  return verify(secret, 'pending-email-registration', token, REGISTRATION_MAX_AGE_MS);
}
