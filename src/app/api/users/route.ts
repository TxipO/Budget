import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest } from '@/lib/validate';
import { requireHouseholdId, MAX_USERS } from '@/lib/household';

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Explicit select — User now also carries monoTokenEnc/monoWebhookSecret
    // (Monobank integration). Never let those reach the client via a blanket
    // findMany(), even encrypted; this route is fetched from nearly every
    // page. householdId filter is the multi-tenant isolation boundary — a
    // bare findMany() here would show every OTHER household's member names
    // in this one's user picker.
    const users = await prisma.user.findMany({
      where: { householdId },
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
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return badRequest("Вкажіть ім'я");

    const count = await prisma.user.count({ where: { householdId } });
    if (count >= MAX_USERS) return badRequest(`Можна додати не більше ${MAX_USERS} користувачів`);

    const user = await prisma.user.create({ data: { name, householdId }, select: { id: true, name: true } });
    return NextResponse.json(user);
  } catch (e: any) {
    if (e?.code === 'P2002') return badRequest("Це ім'я вже використовується");
    console.error('[users POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
