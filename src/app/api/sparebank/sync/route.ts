import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { EnableBankingError } from '@/lib/enableBanking';
import { syncSparebankAccount } from '@/lib/sparebankSync';
import { requireHouseholdId } from '@/lib/household';

// Manual (attended) sync — a real button click in a live browser. The actual
// pagination/watermark/dedup algorithm lives in lib/sparebankSync.ts, shared
// with api/cron/sparebank-sync's unattended path; this route's whole job is
// sourcing a genuine PSU (the person clicking the button) and running it for
// every one of this user's syncEnabled accounts (a household member can own
// several real accounts under one consent — see SparebankAccount's own
// comment), aggregating the results into one response.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: {
        id: true, householdId: true, sbSessionEnc: true, sbValidUntil: true,
        sparebankAccounts: { where: { syncEnabled: true }, select: { id: true, userId: true, accountUid: true, lastSyncedAt: true, syncFloor: true } },
      },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.sbSessionEnc || user.sparebankAccounts.length === 0) return badRequest('Не підключено');
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

    let createdIds: number[] = [];
    let reconciledIds: number[] = [];
    let skippedPending = 0, skippedExisting = 0, skippedError = 0, checked = 0;
    // previousSyncedAt/accountId only make sense for a single account's undo
    // — with multiple accounts synced in one click, "Скасувати" would need
    // to name every account's own watermark, so it's reported per-account
    // and the client only offers undo when exactly one account was synced.
    const perAccount: Array<{ accountId: number; created: number; previousSyncedAt: string | null }> = [];

    for (const account of user.sparebankAccounts) {
      try {
        const result = await syncSparebankAccount(account, householdId, { ipAddress: psuIp, userAgent: psuUserAgent });
        createdIds = createdIds.concat(result.createdIds);
        reconciledIds = reconciledIds.concat(result.reconciledIds);
        skippedPending += result.skippedPending;
        skippedExisting += result.skippedExisting;
        skippedError += result.skippedError;
        checked += result.checked;
        perAccount.push({ accountId: account.id, created: result.createdIds.length, previousSyncedAt: result.previousSyncedAt?.toISOString() ?? null });
      } catch (e) {
        if (e instanceof EnableBankingError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
        throw e;
      }
    }

    return NextResponse.json({
      ok: true,
      created: createdIds.length,
      createdIds,
      // Rows that already existed (a same-day dedup hit) but got
      // retroactively recategorized/flagged now that the bank finished
      // enriching them — see ingestTransaction's `needsReconciliation`
      // comment. Distinct from `created`: these aren't new rows, so they
      // must never feed the undo-sync "Скасувати" delete set.
      reconciled: reconciledIds.length,
      perAccount,
      skippedPending,
      skippedExisting,
      skippedError,
      checked,
    });
  } catch (e) {
    console.error('[sparebank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
