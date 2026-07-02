import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.ico'];

// Session cookie = HMAC-SHA256(AUTH_SECRET, 'budget-session').
// The PIN itself lives in the DB (AppSetting) and is checked only at login,
// so it can be changed from Settings without restarting the server.
async function sessionToken(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('budget-session'));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  // No secret configured — fail open so a missing .env never locks the owners out
  if (!secret) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname === p)) return NextResponse.next();

  const cookie = req.cookies.get('budget-auth')?.value;
  if (cookie && cookie === await sessionToken(secret)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
