import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError, getCachedExchangeRate } from '@/lib/monobank';
import { MONO_CCY_NAMES, ingestStatementItem } from '@/lib/monoIngest';
import { requireHouseholdId } from '@/lib/household';
import { roundMoney } from '@/lib/validate';
import { numericForCurrency } from '@/lib/currencies';

// Reports holds for the dashboard's "Очікують підтвердження" block — holds
// themselves are provisional (see monoIngest.ts) and deliberately never
// recorded until settled. This exists purely so the dashboard can show
// "Balestrand Ho — 508 kr (очікує)" instead of a purchase silently vanishing
// from the user's view for a day, which is exactly the confusion that kept
// generating "Monobank isn't syncing" reports when the real answer was "it's
// still an unsettled hold, working as designed" — see
// project_monobank_integration memory.
//
// Also opportunistically ingests anything that just settled. Found live: a
// hold that flips to hold:false between page loads correctly disappears from
// this endpoint's hold list, but the webhook that's supposed to record the
// now-final transaction doesn't reliably arrive (same unreliable-delivery
// issue /monobank/sync exists for) — the purchase vanished from "Очікують"
// and never showed up in the transaction list either, with no path back
// except a manual "Синхронізувати" click. Since this route already pulls the
// full statement to compute the hold list, feeding the non-hold items
// through the same ingestStatementItem() the webhook/sync use closes that
// gap on the very next dashboard load a few minutes later, for free.
const CACHE_TTL_MS = 5 * 60 * 1000; // holds don't need to be fresher than this, and Monobank's statement endpoint is rate-limited to ~1 req/60s per token
// 14, not 3 — the original "holds settle within a few days" assumption held
// for domestic UAH card use but not for FOREIGN purchases: confirmed live
// 2026-07-31 that six NOK purchases made in Norway on 30.07 were still
// hold:true a full day later, and international settlement routinely takes
// several business days. At 3 days a foreign hold could silently drop out of
// this list while STILL not being in the transaction list (it only lands
// there once settled), leaving the purchase invisible in both places — the
// exact "чому не бачу транзакцій" confusion this route exists to prevent.
const LOOKBACK_DAYS = 14;

interface PendingItem {
  id: string;
  description: string;
  amount: number;
  currency: string;
  time: number;
}

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json([], { status: 401 });
    const userId = Number(req.nextUrl.searchParams.get('userId'));
    if (!Number.isFinite(userId) || userId <= 0) return NextResponse.json([]);

    // Ownership check before touching the cache — otherwise any household
    // could read another household's cached pending-holds list by passing
    // its userId in the query string.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { householdId: true, monoTokenEnc: true, monoAccountId: true, monoSyncFloor: true },
    });
    if (!user || user.householdId !== householdId) return NextResponse.json([]);

    // Household's own chosen currency (lib/currencies.ts), not hardcoded
    // NOK — see monoIngest.ts's matching fix.
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { currency: true } });
    const targetCcy = numericForCurrency(household?.currency ?? 'NOK');

    const floorMs = user.monoSyncFloor ? user.monoSyncFloor.getTime() : null;

    const cacheKey = `monoPending:${userId}`;
    const cached = await prisma.appSetting.findUnique({ where: { key: cacheKey } });
    if (cached) {
      const parsed = JSON.parse(cached.value) as { items: PendingItem[]; fetchedAt: number };
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return NextResponse.json(parsed.items);
    }

    if (!user.monoTokenEnc || !user.monoAccountId) return NextResponse.json([]);

    let statement: any[];
    try {
      const token = decrypt(user.monoTokenEnc);
      const to = Math.floor(Date.now() / 1000);
      // Deliberately NOT clamped to monoSyncFloor. The floor's job is to stop
      // sync from RE-CREATING rows the user deleted on purpose — it has no
      // business hiding what the bank is currently holding. Clamping the
      // fetch window here (as an earlier version did) made a real hold
      // invisible in both the pending list and the transaction list at the
      // same time. The floor is applied below, to the opportunistic INGEST
      // only, which is the part that actually writes rows.
      const from = to - LOOKBACK_DAYS * 24 * 3600;
      statement = await getStatement(token, user.monoAccountId, from, to);
    } catch (e) {
      // Serve stale cache rather than fail the dashboard over a transient
      // Monobank error or rate-limit — the dashboard showing yesterday's
      // pending list a few minutes late is fine; showing an error isn't.
      if (cached) return NextResponse.json((JSON.parse(cached.value) as { items: PendingItem[] }).items);
      if (e instanceof MonobankError) return NextResponse.json([]);
      throw e;
    }

    const holds: PendingItem[] = [];
    for (const i of statement) {
      if (i.hold) {
        // i.amount is ALWAYS in the connected account's own currency (UAH
        // here), not i.currencyCode's — i.operationAmount is the real amount
        // in i.currencyCode. Confirmed live 2026-07-11 against Monobank's raw
        // API: a NOK purchase reported amount=-105560 (the UAH-account-debited
        // figure, 1055.60) and operationAmount=-22900 (the real NOK charge,
        // 229.00) with currencyCode 578 (NOK) on both. Using i.amount here
        // showed pending holds ~4.6x too large, still labeled "kr" by the
        // dashboard's formatMoney(). See lib/monoIngest.ts's matching fix for
        // confirmed transactions (same underlying bug).
        const rawAmount = i.operationAmount ?? i.amount;
        let amountTarget = Math.abs(rawAmount) / 100;
        if (i.currencyCode !== targetCcy) {
          const rate = await getCachedExchangeRate(i.currencyCode, targetCcy);
          // No cached/live rate available (rare — this same lookup already
          // runs on every ingest) — skip this hold rather than show a
          // plausible-looking but wrong number; it reappears next refresh
          // once a rate is available, or once it settles for real.
          if (rate === null) continue;
          amountTarget = roundMoney(amountTarget * rate);
        }
        holds.push({
          id: i.id,
          description: i.description || '',
          amount: amountTarget,
          currency: MONO_CCY_NAMES[i.currencyCode] ?? String(i.currencyCode),
          time: i.time,
        });
      } else if (floorMs === null || i.time * 1000 >= floorMs) {
        // No-op for anything already recorded (idempotent via monoStatementId);
        // a failure here must never break the pending list this route exists
        // to serve. Gated on monoSyncFloor so this path can't resurrect a row
        // the user deliberately deleted before that date — the same guard
        // monobank/sync applies, but here it wraps only the write, leaving
        // the hold display above untouched.
        try { await ingestStatementItem(userId, householdId, i); } catch (e) { console.error('[monobank/pending] opportunistic ingest failed', e); }
      }
    }

    await prisma.appSetting.upsert({
      where: { key: cacheKey },
      update: { value: JSON.stringify({ items: holds, fetchedAt: Date.now() }) },
      create: { key: cacheKey, value: JSON.stringify({ items: holds, fetchedAt: Date.now() }) },
    });

    return NextResponse.json(holds);
  } catch (e) {
    console.error('[monobank/pending GET]', e);
    return NextResponse.json([]);
  }
}
