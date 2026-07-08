import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Not under /api/auth/ — that prefix is middleware's PUBLIC_PREFIXES bypass
// for pre-login routes. This one needs the opposite: it reads
// x-current-user-id, which middleware only sets after verifying a real
// session, so it must go through the normal auth gate like any other page.
export async function GET(req: NextRequest) {
  try {
    const userId = req.headers.get('x-current-user-id');
    if (!userId) return NextResponse.json({ shared: true });

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, name: true, telegramUsername: true, telegramFirstName: true, email: true },
    });
    if (!user) return NextResponse.json({ shared: true });
    return NextResponse.json({ shared: false, user });
  } catch (e) {
    console.error('[account/me GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
