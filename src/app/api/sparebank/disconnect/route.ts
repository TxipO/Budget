import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { decrypt } from '@/lib/crypto';
import { deleteSession } from '@/lib/enableBanking';
import { requireHouseholdId } from '@/lib/household';

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { householdId: true, sbSessionEnc: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.sbSessionEnc) return badRequest('Не підключено');

    // Best-effort: explicitly close the PSU's bank consent, same "continue
    // even if this fails" approach as monobank/disconnect's webhook
    // unregister — the local fields get cleared below regardless.
    try {
      await deleteSession(decrypt(user.sbSessionEnc));
    } catch (e) {
      console.error('[sparebank/disconnect] session revoke failed, continuing', e);
    }

    // The whole consent is revoked above, so every account under it goes
    // with it — not just the one that happened to be syncEnabled.
    await prisma.$transaction([
      prisma.sparebankAccount.deleteMany({ where: { userId: Number(userId) } }),
      prisma.user.update({
        where: { id: Number(userId) },
        data: { sbSessionEnc: null, sbValidUntil: null, sbAutoSync: false, sbLastAutoSyncAt: null, sbSyncFailCount: 0 },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[sparebank/disconnect POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
