import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PIN_HOUSEHOLD_ID } from '@/lib/pin';

// Public (see middleware.ts's /api/auth/ prefix) — reached during
// registration, before any session exists. Only ever returns {id, name}
// for accounts that don't have a telegramId yet, so a first-time Telegram
// login can offer "is this you?" instead of silently creating a duplicate
// account and splitting Паша/Женя's existing transaction history.
//
// householdId scoped to PIN_HOUSEHOLD_ID (not global) — MT Ф3/Ф4 found this:
// account-linking is gated on household #1's PIN (see telegram/register's
// linkToUserId branch), so it can only ever legitimately mean "is this
// household #1's member" — an unlinked user from any OTHER household must
// never appear here, or knowing household #1's PIN would be enough to
// hijack a stranger's household by "linking" a Telegram account to their
// unlinked user id. Was previously an unscoped findMany(); harmless only
// while a single household existed, became a real cross-tenant leak the
// moment MT Ф4's email signup could create a second one.
export async function GET() {
  try {
    const users = await prisma.user.findMany({
      where: { telegramId: null, householdId: PIN_HOUSEHOLD_ID },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users);
  } catch (e) {
    console.error('[auth/telegram/unlinked-users GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
