import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { encrypt } from '@/lib/crypto';
import { getAppOrigin } from '@/lib/monobank';
import { exchangeCode, verifyConnectState, EnableBankingError } from '@/lib/enableBanking';
import { requireHouseholdId } from '@/lib/household';

// Reached by the BANK's browser redirect after the account holder completes
// BankID — not a fetch call from our own frontend. Errors here can't return
// JSON to a caller that's expecting it; they redirect back to Settings with
// a query param the UI reads instead.
function toSettings(status: 'connected' | 'error'): NextResponse {
  return NextResponse.redirect(`${getAppOrigin()}/settings?sparebank=${status}`);
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

    await prisma.user.update({
      where: { id: user.id },
      data: {
        sbSessionEnc: encrypt(session.session_id),
        sbAccountUid: account.uid,
        sbIban: account.account_id?.iban ?? null,
        sbValidUntil: session.access?.valid_until ? new Date(session.access.valid_until) : null,
        // Watermark starts at connection time, not null — a fresh connect
        // should behave like Monobank's webhook (only new transactions from
        // here forward), never an automatic historical backfill. sync/route.ts
        // reads this to decide how far back to look.
        sbLastSyncedAt: new Date(),
      },
    });

    return toSettings('connected');
  } catch (e) {
    console.error('[sparebank/callback GET]', e);
    return toSettings('error');
  }
}
