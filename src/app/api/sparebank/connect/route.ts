import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt, isValidDate } from '@/lib/validate';
import { getAppOrigin } from '@/lib/monobank';
import { startAuth, signConnectState, SPAREBANK1_SOGN_OG_FJORDANE, EnableBankingError } from '@/lib/enableBanking';
import { requireHouseholdId } from '@/lib/household';

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId, syncFromDate } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    // Optional historical-backfill start date — the account's default is
    // "connect time forward, no backfill" (see callback's own comment), same
    // as Monobank's default before its own syncFromDate was added. Validated
    // here, not just trusted, before it rides along inside the signed OAuth
    // state all the way to the callback.
    let fromDate: string | undefined;
    if (syncFromDate !== undefined && syncFromDate !== '') {
      if (typeof syncFromDate !== 'string' || !isValidDate(syncFromDate) || new Date(syncFromDate).getTime() > Date.now()) {
        return badRequest('Невалідна дата початку синхронізації');
      }
      fromDate = syncFromDate;
    }

    // Ownership check — without it, any authenticated household could kick
    // off a connect flow that credits another household's user (same class
    // of gap already fixed for Monobank's connect route).
    const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { id: true, householdId: true } });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');

    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Internal server error' }, { status: 500 });

    const state = signConnectState(authSecret, String(householdId), String(user.id), fromDate);
    const redirectUrl = `${getAppOrigin()}/api/sparebank/callback`;
    // SpareBank 1 Sogn og Fjordane specifically requires this header (confirmed
    // live via GET /aspsps) — a placeholder IP would risk the bank rejecting
    // or flagging the auth request as suspicious.
    const psuIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';

    let result;
    try {
      result = await startAuth(SPAREBANK1_SOGN_OG_FJORDANE.name, SPAREBANK1_SOGN_OG_FJORDANE.country, redirectUrl, state, psuIp);
    } catch (e) {
      if (e instanceof EnableBankingError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
      throw e;
    }

    return NextResponse.json({ ok: true, url: result.url });
  } catch (e) {
    console.error('[sparebank/connect POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
