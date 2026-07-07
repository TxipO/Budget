import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Never touches Monobank's own API (no rate-limit cost) — just reports what's
// stored locally. monoTokenEnc itself never leaves this route; only whether
// it's set.
export async function GET() {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, monoAccountId: true, monoTokenEnc: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users.map(u => ({
      userId: u.id,
      name: u.name,
      connected: u.monoTokenEnc !== null,
      accountId: u.monoAccountId,
    })));
  } catch (e) {
    console.error('[monobank/status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
