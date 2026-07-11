import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError } from '@/lib/monobank';
import { MONO_CCY_NAMES, ingestStatementItem } from '@/lib/monoIngest';
import { requireHouseholdId } from '@/lib/household';

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
const LOOKBACK_DAYS = 3; // holds settle within a few days in practice; no need to scan further back

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
      select: { householdId: true, monoTokenEnc: true, monoAccountId: true },
    });
    if (!user || user.householdId !== householdId) return NextResponse.json([]);

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
        holds.push({
          id: i.id,
          description: i.description || '',
          amount: Math.abs(i.amount) / 100,
          currency: MONO_CCY_NAMES[i.currencyCode] ?? String(i.currencyCode),
          time: i.time,
        });
      } else {
        // No-op for anything already recorded (idempotent via monoStatementId);
        // a failure here must never break the pending list this route exists
        // to serve.
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
