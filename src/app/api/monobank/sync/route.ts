import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { requireHouseholdId } from '@/lib/household';
import { syncMonoUser } from '@/lib/monoSync';

// Manual "sync now" — the actual work lives in lib/monoSync.ts (shared with the cron).
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, householdId: true, monoTokenEnc: true, monoAccountId: true, monoSyncFloor: true },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.monoTokenEnc || !user.monoAccountId) return badRequest('Не підключено');

    const r = await syncMonoUser({ id: user.id, monoTokenEnc: user.monoTokenEnc, monoAccountId: user.monoAccountId, monoSyncFloor: user.monoSyncFloor }, householdId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status === 429 ? 429 : 400 });
    return NextResponse.json(r);
  } catch (e) {
    console.error('[monobank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
