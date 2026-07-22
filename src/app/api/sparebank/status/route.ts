import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';

// Never touches Enable Banking's own API — just reports what's stored
// locally, same as monobank/status. sbSessionEnc itself never leaves this
// route; only whether it's set.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const users = await prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true, sbSessionEnc: true, sbAccountUid: true, sbIban: true, sbValidUntil: true },
      orderBy: { id: 'asc' },
    });
    return NextResponse.json(users.map(u => ({
      userId: u.id,
      name: u.name,
      connected: u.sbSessionEnc !== null && u.sbAccountUid !== null,
      iban: u.sbIban,
      validUntil: u.sbValidUntil,
      expired: u.sbValidUntil ? u.sbValidUntil.getTime() < Date.now() : false,
    })));
  } catch (e) {
    console.error('[sparebank/status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
