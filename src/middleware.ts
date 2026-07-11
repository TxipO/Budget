import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.ico'];

// Prefix matches, kept separate from the exact-match list above so widening
// one never accidentally widens the other.
const PUBLIC_PREFIXES = [
  // Monobank calls this URL directly (GET to verify it's alive, POST to push
  // transactions) — it can't send our session cookie, so it must bypass PIN
  // auth entirely. Safe because the route itself is the real gate: it only
  // acts on a request whose :secret matches a per-user 192-bit random value
  // stored in the DB, and no-ops (still 200) on anything else.
  '/api/webhooks/monobank/',
  // Telegram calls this URL directly for voice-message webhook updates — it
  // can't send our session cookie either. Its own gate is the
  // X-Telegram-Bot-Api-Secret-Token header check inside the route itself
  // (Telegram has no per-integration secret-path mechanism the way a
  // hand-rolled webhook URL can have), not the middleware.
  '/api/webhooks/telegram',
  // Everything under /api/auth/ is part of logging in — by definition
  // reached before any session exists. /api/auth itself (PIN login) is
  // already in the exact-match list above; this prefix covers the Telegram
  // sub-routes without needing a matcher for a path that doesn't exist yet.
  // Each of those routes is its own gate (HMAC signature verification), not
  // the middleware.
  '/api/auth/',
];

// Must match SESSION_MAX_AGE_MS / the cookie's maxAge in api/auth/route.ts.
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 30 * 1000; // 30 днів
// The cookie is issued by a Node.js serverless function (api/auth/route.ts)
// and verified here in a separate Edge runtime instance — different
// infrastructure, not guaranteed to have perfectly synced clocks. Without
// this tolerance, the very first request right after a successful login
// could get bounced back to /login if the issuing clock is even 1ms ahead
// of the verifying one (age computes negative and gets rejected outright).
const CLOCK_SKEW_TOLERANCE_MS = 5000;

// Session cookie = "<userId>.<householdId>.<hasPin>.<issuedAt>.<HMAC-SHA256(
// ...)>" — see lib/session.ts's sessionCookieValue for the full format note.
// userId is "shared" for a PIN login (no specific identity — matches the
// original behavior, anyone with the PIN acts as the whole household) or a
// real numeric User.id for a Telegram/email login; householdId is always a
// real Household.id; hasPin (P4) says whether this household currently has
// a PIN lock configured, decided at issuance time. issuedAt is embedded and
// signed (not just relied on the browser's Max-Age) so a raw copied cookie
// value can't be replayed forever via a plain HTTP client that ignores
// Max-Age — the server itself enforces expiry here. All of this is carried
// IN the signed cookie, not looked up per-request from the DB, because this
// file runs on Vercel's Edge runtime, which this project deliberately keeps
// Prisma-free (Prisma's Node-API query engine isn't available there without
// a separate driver adapter this project hasn't taken on).
async function sign(secret: string, userId: string, householdId: string, hasPinFlag: string, issuedAt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`budget-session:${userId}:${householdId}:${hasPinFlag}:${issuedAt}`));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Same HMAC scheme, different namespace — the short-lived "PIN was entered
// correctly for this household" proof (lib/session.ts's unlockCookieValue).
async function signUnlock(secret: string, householdId: string, issuedAt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`budget-unlock:${householdId}:${issuedAt}`));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare — Web Crypto has no built-in timing-safe
// compare, so this is the manual edge-runtime equivalent of
// crypto.timingSafeEqual. Both expected inputs here are fixed-length hex
// hashes, so comparing .length first leaks nothing an attacker doesn't
// already know.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface VerifiedSession {
  userId: string;
  householdId: string;
  hasPin: boolean;
}

async function verifySession(cookieValue: string, secret: string): Promise<VerifiedSession | null> {
  const parts = cookieValue.split('.');
  if (parts.length !== 5) return null;
  const [userId, householdId, hasPinFlag, issuedAtStr, sig] = parts;
  if (!userId || !householdId || (hasPinFlag !== '0' && hasPinFlag !== '1')) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return null;
  const age = Date.now() - issuedAt;
  if (age < -CLOCK_SKEW_TOLERANCE_MS || age > SESSION_MAX_AGE_MS) return null; // expired, or issued implausibly far in the future (tampered)
  const expected = await sign(secret, userId, householdId, hasPinFlag, String(issuedAt));
  return timingSafeEqual(sig, expected) ? { userId, householdId, hasPin: hasPinFlag === '1' } : null;
}

// UNLOCK_MAX_AGE_S in lib/session.ts, mirrored here for the same Node/Edge
// split reason as SESSION_MAX_AGE_MS above.
const UNLOCK_MAX_AGE_MS = 60 * 60 * 24 * 1000; // 24 години

async function verifyUnlock(cookieValue: string, secret: string, expectedHouseholdId: string): Promise<boolean> {
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const [householdId, issuedAtStr, sig] = parts;
  // Bound to the specific household from the session, not just "any valid
  // unlock cookie" — otherwise an unlock minted for household A on a shared
  // browser profile could unlock household B's locked session too.
  if (householdId !== expectedHouseholdId) return false;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  if (age < -CLOCK_SKEW_TOLERANCE_MS || age > UNLOCK_MAX_AGE_MS) return false;
  const expected = await signUnlock(secret, householdId, String(issuedAt));
  return timingSafeEqual(sig, expected);
}

// Reachable even while a session is locked (hasPin && no valid unlock
// cookie) — otherwise there'd be no way to ever unlock (can't POST the
// unlock endpoint) or leave (can't log out) without waiting for the whole
// 30-day session to expire.
const LOCKED_ALLOWLIST = ['/lock', '/api/account/pin-unlock', '/api/account/logout'];

// CSP must use a per-request NONCE, not a fixed sha256 hash: Next.js App
// Router injects its own inline scripts for RSC-streaming hydration
// (`self.__next_f.push(...)`), and their content is different on every
// single request. A hash can only allowlist unchanging content (fine for
// the one static theme-detection script in layout.tsx, but hashing was
// tried here first and it broke ALL client-side interactivity in
// production — hydration scripts got blocked, so no event handlers ever
// attached, and clicking "Увійти" silently did nothing). Next.js
// recognizes a nonce-based CSP response header and automatically applies
// the same nonce to every script it injects itself.
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval' is required specifically by telegram-widget.js, which
    // calls eval() internally during its own init — confirmed live via an
    // uncaught CSP EvalError, only reproducible with a real registered bot
    // + a domain passed through /setdomain (a fake test bot's "Bot domain
    // invalid" response short-circuits before widget.js reaches that code
    // path, so this was invisible in every earlier test). 'strict-dynamic'
    // governs script *sources*, not eval — a separate CSP concern entirely.
    // Accepted tradeoff: this app has no user-generated content that could
    // feed an attacker-controlled string into an eval() reachable from
    // already-trusted code, so the realistic XSS-via-eval risk here is low.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // Telegram Login Widget's own iframe (oauth.telegram.org) — without
    // this, frame-src falls back to default-src 'self' and silently blocks
    // the widget in production only (dev mode skips CSP entirely, so this
    // gap wasn't visible in local testing).
    "frame-src https://oauth.telegram.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

function withCsp(res: NextResponse, nonce: string): NextResponse {
  // Dev mode's HMR bundle needs 'unsafe-eval', which a strict CSP can't
  // grant without also weakening script-src for prod — so CSP is
  // production-only, same call as next.config.mjs's other headers.
  if (process.env.NODE_ENV === 'production') {
    res.headers.set('Content-Security-Policy', buildCsp(nonce));
  }
  return res;
}

export async function middleware(req: NextRequest) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);

  const secret = process.env.AUTH_SECRET;
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname === p) || PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
  }

  // Fail CLOSED, not open: without a secret we cannot verify any cookie, so
  // granting access would mean anyone gets in with no PIN at all. This is
  // exactly what happened on Preview deployments — AUTH_SECRET is only
  // configured for the Production environment in Vercel, so every Preview
  // build served the full dashboard to anyone with the URL, no login
  // required. A misconfigured env var must break loudly, not silently open
  // the door.
  if (!secret) {
    if (pathname.startsWith('/api/')) {
      return withCsp(NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 }), nonce);
    }
    return withCsp(new NextResponse('Автентифікацію не налаштовано. Зверніться до адміністратора.', { status: 500 }), nonce);
  }

  const cookie = req.cookies.get('budget-auth')?.value;
  const session = cookie ? await verifySession(cookie, secret) : null;
  if (session) {
    // Always decide these here, never leave a client-supplied value from the
    // incoming request alone — requestHeaders started as a clone of
    // req.headers, so an attacker-set x-current-user-id/x-household-id would
    // otherwise survive untouched, letting them impersonate a specific
    // Telegram-bound user or claim a different household's data to routes
    // that trust these headers. "shared" itself is intentionally not
    // forwarded as a real user id — pages check for its absence rather than
    // treating the literal string "shared" as a User.id to look up.
    if (session.userId !== 'shared') requestHeaders.set('x-current-user-id', session.userId);
    else requestHeaders.delete('x-current-user-id');
    // Every route that reads/writes tenant-owned data needs this — it's the
    // multi-tenant isolation boundary. Always set, for both PIN and Telegram
    // sessions, since a "shared" PIN session still belongs to exactly one
    // household.
    requestHeaders.set('x-household-id', session.householdId);

    // P4 — universal PIN lock. A session that says hasPin must ALSO present
    // a still-valid unlock cookie for this exact household, or every page/
    // API route (except the small allowlist needed to unlock or log out at
    // all) is gated — this is what makes the lock a real security boundary
    // on the data itself, not just a UI overlay a client could skip past by
    // calling the API directly.
    if (session.hasPin && !LOCKED_ALLOWLIST.includes(pathname)) {
      const unlockCookie = req.cookies.get('budget-unlocked')?.value;
      const unlocked = unlockCookie ? await verifyUnlock(unlockCookie, secret, session.householdId) : false;
      if (!unlocked) {
        if (pathname.startsWith('/api/')) {
          return withCsp(NextResponse.json({ error: 'Locked' }, { status: 401 }), nonce);
        }
        const url = req.nextUrl.clone();
        url.pathname = '/lock';
        url.search = '';
        return withCsp(NextResponse.redirect(url), nonce);
      }
    }

    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }), nonce);
  }

  if (pathname.startsWith('/api/')) {
    return withCsp(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), nonce);
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return withCsp(NextResponse.redirect(url), nonce);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
