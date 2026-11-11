import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { decrypt } from '@/lib/crypto';
import { getClientInfoCached, MonobankError } from '@/lib/monobank';
import { refreshMonoBalance } from '@/lib/monoBalance';
import { requireHouseholdId } from '@/lib/household';

// Explicit choice of which of the token's accounts is tracked — the connect
// route only guesses a default. The webhook is per token, not per account, so
// it is deliberately not re-registered here.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { userId, accountId } = await req.json();
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');
    if (typeof accountId !== 'string' || !accountId.trim()) return badRequest('Невалідна картка');

    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { householdId: true, monoTokenEnc: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.monoTokenEnc) return badRequest('Не підключено');

    // Never trust the client: the id must be one of this token's own accounts.
    let info;
    try {
      info = await getClientInfoCached(Number(userId), decrypt(user.monoTokenEnc));
    } catch (e) {
      if (e instanceof MonobankError) {
        return NextResponse.json({ error: e.status === 429 ? 'Monobank обмежує запити — спробуйте за хвилину' : e.message }, { status: e.status === 429 ? 429 : 400 });
      }
      throw e;
    }
    if (!(info.accounts ?? []).some(a => a.id === accountId)) return badRequest('Картку не знайдено серед рахунків цього токена');

    await prisma.user.update({
      where: { id: Number(userId) },
      data: { monoAccountId: accountId, monoLastSyncError: null, monoSyncFailCount: 0 },
    });
    // Drop caches/markers tied to the old card: pending holds of the old account,
    // the "card missing" alert dedup, and the client-info snapshot.
    await prisma.appSetting.deleteMany({ where: { key: { in: [`monoPending:${userId}`, `monoAccountMissing:${userId}`, `monoClientInfo:${userId}`] } } });
    // Reuses the snapshot we just verified against (a second client-info call would hit the 1/60s limit).
    await refreshMonoBalance(Number(userId), info);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[monobank/account POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
