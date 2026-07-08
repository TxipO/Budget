import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Public (see middleware.ts's /api/auth/ prefix) — reached during
// registration, before any session exists. Only ever returns {id, name}
// for accounts that don't have a telegramId yet, so a first-time Telegram
// login can offer "is this you?" instead of silently creating a duplicate
// account and splitting Паша/Женя's existing transaction history. Not a
// meaningful information leak: these are the same two names already
// visible anywhere in the app's UI unauthenticated (login page branding,
// etc. don't show them, but they're not secret in the way a token is).
export async function GET() {
  try {
    const users = await prisma.user.findMany({
      where: { telegramId: null },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users);
  } catch (e) {
    console.error('[auth/telegram/unlinked-users GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
