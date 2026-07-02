import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/login', '/api/auth', '/manifest.json', '/icon-192.png', '/icon-512.png', '/favicon.ico'];

// Cookie stores SHA-256("budget-auth:<PIN>") so the raw PIN never lives in the browser
async function expectedToken(pin: string): Promise<string> {
  const data = new TextEncoder().encode(`budget-auth:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function middleware(req: NextRequest) {
  const pin = process.env.APP_PIN;
  // No PIN configured — fail open so a missing .env never locks the owners out
  if (!pin) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname === p)) return NextResponse.next();

  const cookie = req.cookies.get('budget-auth')?.value;
  if (cookie && cookie === await expectedToken(pin)) return NextResponse.next();

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
