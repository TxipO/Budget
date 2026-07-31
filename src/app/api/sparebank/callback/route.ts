import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encrypt } from '@/lib/crypto';
import { getAppOrigin } from '@/lib/monobank';
import { exchangeCode, verifyConnectState, EnableBankingError } from '@/lib/enableBanking';
import { syncSparebankUser } from '@/lib/sparebankSync';
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
    if (!user || user.householdId !== cookieHouseholdId) return toSettings('error');

    let session;
    try {
      session = await exchangeCode(code);
    } catch (e) {
      console.error('[sparebank/callback] exchangeCode failed', e instanceof EnableBankingError ? e.message : e);
      return toSettings('error');
    }

    const account = session.accounts?.[0];
    if (!account?.uid) return toSettings('error');

    // claimed.fromDate is the user's chosen historical-backfill start date
    // (Settings' "Синхронізувати з дати" field on the connect form),
    // verified/signed at api/sparebank/connect and echoed back verbatim by
    // Enable Banking in `state`. Absent, the watermark starts at connection
    // time, same as always — only new transactions from here forward, never
    // an automatic historical backfill.
    const initialWatermark = claimed.fromDate ? new Date(`${claimed.fromDate}T00:00:00Z`) : new Date();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        sbSessionEnc: encrypt(session.session_id),
        sbAccountUid: account.uid,
        sbIban: account.account_id?.iban ?? null,
        sbValidUntil: session.access?.valid_until ? new Date(session.access.valid_until) : null,
        sbLastSyncedAt: initialWatermark,
      },
    });

    // A chosen start date means the user wants that history pulled in NOW,
    // not after a separate manual "Синхронізувати" click they might not know
    // to make. This request is the account holder's own browser completing
    // BankID this instant, so a real PSU IP/user-agent is genuinely present —
    // same attended-access reasoning as the manual sync route's.
    if (claimed.fromDate) {
      const psuIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
      const psuUserAgent = req.headers.get('user-agent') || undefined;
      try {
        const result = await syncSparebankUser(
          { id: user.id, sbAccountUid: account.uid, sbLastSyncedAt: initialWatermark, sbSyncFloor: null },
          user.householdId!,
          { ipAddress: psuIp, userAgent: psuUserAgent },
        );
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
