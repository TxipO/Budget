import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    // Explicit select — User now also carries monoTokenEnc/monoWebhookSecret
    // (Monobank integration). Never let those reach the client via a blanket
    // findMany(), even encrypted; this route is fetched from nearly every page.
    const users = await prisma.user.findMany({
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users);
  } catch (e) {
    console.error('[users GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
