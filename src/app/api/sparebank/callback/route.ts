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

    const existingAccounts = await prisma.sparebankAccount.findMany({ where: { userId: user.id }, select: { id: true, accountUid: true, iban: true, identification: true, syncEnabled: true } });
    const alreadyHasSyncEnabled = existingAccounts.some(a => a.syncEnabled);

    // claimed.fromDate is the user's chosen historical-backfill start date
    // (Settings' "Синхронізувати з дати" field on the connect form) —
    // applied only to whichever account ends up syncEnabled. Absent, the
    // watermark starts at connection time, same as always — only new
    // transactions from here forward, never an automatic historical backfill.
    const initialWatermark = claimed.fromDate ? new Date(`${claimed.fromDate}T00:00:00Z`) : new Date();

    let syncEnabledAccountRow: { id: number; userId: number; accountUid: string; lastSyncedAt: Date | null; syncFloor: Date | null } | null = null;

    const matchedIds = new Set<number>();
    for (let i = 0; i < discovered.length; i++) {
      const acc = discovered[i];
      let details;
      try {
        details = await getAccountDetails(acc.uid, psu);
      } catch (e) {
        console.error('[sparebank/callback] getAccountDetails failed for', acc.uid, e);
        details = null;
      }
      const iban = details?.account_id?.iban ?? acc.account_id?.iban ?? null;
      const identification = details?.account_id?.other?.identification ?? null;
      // Enable Banking issues NEW account uids for every new session (confirmed
      // live 2026-10-20: reconnecting after the consent expired returned fresh
      // uids for the same two accounts, and the old upsert-by-uid created
      // duplicate rows — sync off, no category — while the real rows kept dead
      // uids). So an unknown uid is matched to this user's existing row by
      // IBAN (fallback: BBAN identification) and that row's uid is rotated in
      // place: row ids must stay stable, sbTransactionId keys are prefixed
      // `sb<accountId>|` and transfer detection compares account ids.
      const existing = existingAccounts.find(a => a.accountUid === acc.uid)
        ?? existingAccounts.find(a => !matchedIds.has(a.id) && ((iban && a.iban === iban) || (identification && a.identification === identification)));
      if (existing) matchedIds.add(existing.id);
      // First-discovered account gets syncEnabled=true by default — mirrors
      // the old single-account behavior exactly when there's only one
      // account. On a RE-connect, whichever account was already syncEnabled
      // stays that way instead of resetting to "first in the list", so
      // reconnecting never silently switches which account is the budget one.
      const shouldEnable = existing ? existing.syncEnabled : (!alreadyHasSyncEnabled && i === 0);

      const select = { id: true, userId: true, accountUid: true, lastSyncedAt: true, syncFloor: true, syncEnabled: true } as const;
      let row;
      if (existing) {
        // accountUid is @unique: if some other row (shouldn't exist) already
        // holds the new uid, keep the old one rather than crash the whole connect.
        const holder = existing.accountUid === acc.uid ? null : await prisma.sparebankAccount.findUnique({ where: { accountUid: acc.uid }, select: { id: true } });
        if (holder) console.error('[sparebank/callback] uid already held by row', holder.id, '- not rotating row', existing.id);
        row = await prisma.sparebankAccount.update({
          where: { id: existing.id },
          data: { accountUid: holder ? undefined : acc.uid, iban: iban ?? undefined, identification: identification ?? undefined },
          select,
        });
      } else {
        row = await prisma.sparebankAccount.create({
          data: {
            userId: user.id,
            accountUid: acc.uid,
            iban,
            identification,
            label: details?.details || details?.product || `Рахунок ${i + 1}`,
            syncEnabled: shouldEnable,
            lastSyncedAt: shouldEnable ? initialWatermark : null,
          },
          select,
        });
      }
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
