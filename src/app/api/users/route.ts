import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const users = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    return NextResponse.json(users);
  } catch (e) {
    console.error('[users GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
