import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { EnableBankingError } from '@/lib/enableBanking';
import { syncSparebankUser } from '@/lib/sparebankSync';
import { requireHouseholdId } from '@/lib/household';

// Manual (attended) sync — a real button click in a live browser. The actual
// pagination/watermark/dedup algorithm lives in lib/sparebankSync.ts, shared
// with api/cron/sparebank-sync's unattended path; this route's whole job is
// sourcing a genuine PSU (the person clicking the button) and translating
// the result into an HTTP response.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, householdId: true, sbSessionEnc: true, sbAccountUid: true, sbValidUntil: true, sbLastSyncedAt: true, sbSyncFloor: true },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.sbSessionEnc || !user.sbAccountUid) return badRequest('Не підключено');
    if (user.sbValidUntil && user.sbValidUntil.getTime() < Date.now()) {
      return badRequest('Доступ до банку прострочено — перепідключіть SpareBank 1');
    }

    // The PSU (Женя) is genuinely present — this route only ever runs from a
    // real button click in her live browser. Passing her real IP + user-agent
    // marks the fetch "attended", which exempts it from the ASPSP's strict
    // ~4/day UNATTENDED background-fetch cap (see getTransactions' own comment
    // and Enable Banking's FAQ). x-forwarded-for's first hop is the real
    // client IP on Vercel; fall back to a non-empty placeholder only if it's
    // somehow absent (the header must be present and syntactically an IP).
    const psuIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
    const psuUserAgent = req.headers.get('user-agent') || undefined;

    let result;
    try {
      result = await syncSparebankUser(
        { id: user.id, sbAccountUid: user.sbAccountUid, sbLastSyncedAt: user.sbLastSyncedAt, sbSyncFloor: user.sbSyncFloor },
        householdId,
        { ipAddress: psuIp, userAgent: psuUserAgent },
      );
    } catch (e) {
      if (e instanceof EnableBankingError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
      throw e;
    }

    return NextResponse.json({
      ok: true,
      created: result.createdIds.length,
      createdIds: result.createdIds,
      previousSyncedAt: result.previousSyncedAt,
      skippedPending: result.skippedPending,
      skippedExisting: result.skippedExisting,
      skippedError: result.skippedError,
      checked: result.checked,
    });
  } catch (e) {
    console.error('[sparebank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
