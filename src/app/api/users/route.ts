import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest } from '@/lib/validate';

// Household is capped at 2 — matches the /setup wizard's "1 or 2 people"
// model and the sidebar's quick-switch button layout, which isn't designed
// for an arbitrary-length list.
const MAX_USERS = 2;

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

// Adds a household member after initial /setup — e.g. Женя joins a day
// after Паша already ran setup with just herself/himself picked.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return badRequest("Вкажіть ім'я");

    const count = await prisma.user.count();
    if (count >= MAX_USERS) return badRequest(`Можна додати не більше ${MAX_USERS} користувачів`);

    const user = await prisma.user.create({ data: { name }, select: { id: true, name: true } });
    return NextResponse.json(user);
  } catch (e: any) {
    if (e?.code === 'P2002') return badRequest("Це ім'я вже використовується");
    console.error('[users POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
