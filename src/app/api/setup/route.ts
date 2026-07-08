import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest } from '@/lib/validate';

// One-time household setup for a fresh deployment — lets whoever runs this
// instance name their own household members instead of being stuck with
// this app's original hardcoded "Паша"/"Женя". Guarded by the User table
// being empty so it can't be replayed later to spam-create accounts once
// real data (and real transactions tied to real users) exists.
export async function POST(req: NextRequest) {
  try {
    const existing = await prisma.user.count();
    if (existing > 0) return NextResponse.json({ error: 'Налаштування вже виконано' }, { status: 409 });

    const body = await req.json();
    const names: unknown = body?.names;
    if (!Array.isArray(names) || names.length < 1 || names.length > 2) return badRequest('Потрібно 1 або 2 імені');

    const trimmed = names.map(n => typeof n === 'string' ? n.trim() : '');
    if (trimmed.some(n => !n)) return badRequest("Кожен користувач повинен мати ім'я");
    if (new Set(trimmed).size !== trimmed.length) return badRequest('Імена мають бути унікальними');

    const created = [];
    for (const name of trimmed) {
      created.push(await prisma.user.create({ data: { name }, select: { id: true, name: true } }));
    }
    return NextResponse.json({ ok: true, users: created });
  } catch (e) {
    console.error('[setup POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
