import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encrypt } from '@/lib/crypto';
import { getAppOrigin } from '@/lib/monobank';
import { exchangeCode, verifyConnectState, getAccountDetails, EnableBankingError } from '@/lib/enableBanking';
import { syncSparebankAccount } from '@/lib/sparebankSync';
import { requireHouseholdId } from '@/lib/household';

// Reached by the BANK's browser redirect after the account holder completes
// BankID — not a fetch call from our own frontend. Errors here can't return
// JSON to a caller that's expecting it; they redirect back to Settings with
// a query param the UI reads instead.
function toSettings(status: 'connected' | 'error', created?: number): NextResponse {
  const createdQs = created !== undefined ? `&created=${created}` : '';
  return NextResponse.redirect(`${getAppOrigin()}/settings?sparebank=${status}${createdQs}`);
}

export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get('code');
    const state = req.nextUrl.searchParams.get('state');
    if (!code || !state) return toSettings('error');

    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return toSettings('error');

    const claimed = verifyConnectState(authSecret, state);
    if (!claimed) return toSettings('error');

    // Cross-check against the actual session cookie still attached to this
    // browser (SameSite=Lax survives the bank's top-level redirect) — the
    // signed state already proves who INITIATED the connect, this confirms
    // the SAME session is the one completing it, not a replayed/leaked state
    // value used from a different browser.
    const cookieHouseholdId = requireHouseholdId(req);
    if (!cookieHouseholdId || String(cookieHouseholdId) !== claimed.householdId) return toSettings('error');

    const user = await prisma.user.findUnique({ where: { id: Number(claimed.userId) }, select: { id: true, householdId: true } });
    if (!user || !user.householdId || user.householdId !== cookieHouseholdId) return toSettings('error');
    const householdId = user.householdId;

    let session;
    try {
      session = await exchangeCode(code);
    } catch (e) {
      console.error('[sparebank/callback] exchangeCode failed', e instanceof EnableBankingError ? e.message : e);
      return toSettings('error');
    }

    // One consent can cover MULTIPLE real accounts (confirmed live
    // 2026-08-01: a checking account AND a separately named savings
    // "pillow" account under the same SpareBank 1 login) — see
    // SparebankAccount's own comment. An earlier version only ever looked
    // at accounts[0], so any additional account was silently invisible.
    const discovered = session.accounts?.filter(a => a.uid) ?? [];
    if (discovered.length === 0) return toSettings('error');

    const validUntil = session.access?.valid_until ? new Date(session.access.valid_until) : null;
    await prisma.user.update({
      where: { id: user.id },
      data: { sbSessionEnc: encrypt(session.session_id), sbValidUntil: validUntil },
    });

    // Real PSU present — this request IS the account holder's own browser
    // completing BankID this instant, same attended-access reasoning as the
    // manual sync route's. GET /accounts/{uid}/details requires this header
    // (confirmed live: 429 without it), unlike balances.
    const psuIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
    const psuUserAgent = req.headers.get('user-agent') || undefined;
    const psu = { ipAddress: psuIp, userAgent: psuUserAgent };

    const existingAccounts = await prisma.sparebankAccount.findMany({ where: { userId: user.id }, select: { accountUid: true, syncEnabled: true } });
    const alreadyHasSyncEnabled = existingAccounts.some(a => a.syncEnabled);

    // claimed.fromDate is the user's chosen historical-backfill start date
    // (Settings' "Синхронізувати з дати" field on the connect form) —
    // applied only to whichever account ends up syncEnabled. Absent, the
    // watermark starts at connection time, same as always — only new
    // transactions from here forward, never an automatic historical backfill.
    const initialWatermark = claimed.fromDate ? new Date(`${claimed.fromDate}T00:00:00Z`) : new Date();

    let syncEnabledAccountRow: { id: number; userId: number; accountUid: string; lastSyncedAt: Date | null; syncFloor: Date | null } | null = null;

    for (let i = 0; i < discovered.length; i++) {
      const acc = discovered[i];
      let details;
      try {
        details = await getAccountDetails(acc.uid, psu);
      } catch (e) {
        console.error('[sparebank/callback] getAccountDetails failed for', acc.uid, e);
        details = null;
      }
      const existing = existingAccounts.find(a => a.accountUid === acc.uid);
      // First-discovered account gets syncEnabled=true by default — mirrors
      // the old single-account behavior exactly when there's only one
      // account. On a RE-connect, whichever account was already syncEnabled
      // stays that way instead of resetting to "first in the list", so
      // reconnecting never silently switches which account is the budget one.
      const shouldEnable = existing ? existing.syncEnabled : (!alreadyHasSyncEnabled && i === 0);

      const row = await prisma.sparebankAccount.upsert({
        where: { accountUid: acc.uid },
        update: {
          iban: details?.account_id?.iban ?? acc.account_id?.iban ?? undefined,
          identification: details?.account_id?.other?.identification ?? undefined,
        },
        create: {
          userId: user.id,
          accountUid: acc.uid,
          iban: details?.account_id?.iban ?? acc.account_id?.iban ?? null,
          identification: details?.account_id?.other?.identification ?? null,
          label: details?.details || details?.product || `Рахунок ${i + 1}`,
          syncEnabled: shouldEnable,
          lastSyncedAt: shouldEnable ? initialWatermark : null,
        },
        select: { id: true, userId: true, accountUid: true, lastSyncedAt: true, syncFloor: true, syncEnabled: true },
      });
      if (row.syncEnabled) syncEnabledAccountRow = row;
    }

    // A chosen start date means the user wants that history pulled in NOW,
    // not after a separate manual "Синхронізувати" click they might not know
    // to make.
    if (claimed.fromDate && syncEnabledAccountRow) {
      try {
        const result = await syncSparebankAccount(syncEnabledAccountRow, householdId, psu);
        return toSettings('connected', result.createdIds.length);
      } catch (e) {
        // The connection itself already succeeded and is fully usable via a
        // manual sync afterward — a failed initial backfill (rate limit,
        // transient error) must not undo that or block the redirect.
        console.error('[sparebank/callback] initial backfill sync failed, connection still saved', e);
      }
    }

    return toSettings('connected');
  } catch (e) {
    console.error('[sparebank/callback GET]', e);
    return toSettings('error');
  }
}
