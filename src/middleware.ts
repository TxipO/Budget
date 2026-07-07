import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.ico'];

// Must match SESSION_MAX_AGE_MS / the cookie's maxAge in api/auth/route.ts.
const SESSION_MAX_AGE_MS = 60 * 60 * 24 * 30 * 1000; // 30 днів
// The cookie is issued by a Node.js serverless function (api/auth/route.ts)
// and verified here in a separate Edge runtime instance — different
// infrastructure, not guaranteed to have perfectly synced clocks. Without
// this tolerance, the very first request right after a successful login
// could get bounced back to /login if the issuing clock is even 1ms ahead
// of the verifying one (age computes negative and gets rejected outright).
const CLOCK_SKEW_TOLERANCE_MS = 5000;

// Session cookie = "<issuedAt>.<HMAC-SHA256(AUTH_SECRET, 'budget-session:'+issuedAt)>".
// issuedAt is embedded and signed (not just relied on the browser's Max-Age)
// so a raw copied cookie value can't be replayed forever via a plain HTTP
// client that ignores Max-Age — the server itself enforces expiry here.
// The PIN itself lives in the DB (AppSetting) and is checked only at login,
// so it can be changed from Settings without restarting the server.
async function sign(secret: string, issuedAt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`budget-session:${issuedAt}`));
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

async function verifySession(cookieValue: string, secret: string): Promise<boolean> {
  const dot = cookieValue.indexOf('.');
  if (dot < 0) return false;
  const issuedAt = Number(cookieValue.slice(0, dot));
  const sig = cookieValue.slice(dot + 1);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  if (age < -CLOCK_SKEW_TOLERANCE_MS || age > SESSION_MAX_AGE_MS) return false; // expired, or issued implausibly far in the future (tampered)
  const expected = await sign(secret, String(issuedAt));
  return timingSafeEqual(sig, expected);
}

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
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
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
  if (PUBLIC_PATHS.some(p => pathname === p)) {
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
  if (cookie && await verifySession(cookie, secret)) {
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
