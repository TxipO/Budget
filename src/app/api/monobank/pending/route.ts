import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError } from '@/lib/monobank';
import { MONO_CCY_NAMES } from '@/lib/monoIngest';

// Read-only, never writes a Transaction — holds are provisional (see
// monoIngest.ts) and deliberately never recorded until settled. This exists
// purely so the dashboard can show "Balestrand Ho — 508 kr (очікує)" instead
// of a purchase silently vanishing from the user's view for a day, which is
// exactly the confusion that kept generating "Monobank isn't syncing" reports
// when the real answer was "it's still an unsettled hold, working as
// designed" — see project_monobank_integration memory.
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
    const userId = Number(req.nextUrl.searchParams.get('userId'));
    if (!Number.isFinite(userId) || userId <= 0) return NextResponse.json([]);

    const cacheKey = `monoPending:${userId}`;
    const cached = await prisma.appSetting.findUnique({ where: { key: cacheKey } });
    if (cached) {
      const parsed = JSON.parse(cached.value) as { items: PendingItem[]; fetchedAt: number };
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return NextResponse.json(parsed.items);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { monoTokenEnc: true, monoAccountId: true },
    });
    if (!user || !user.monoTokenEnc || !user.monoAccountId) return NextResponse.json([]);

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

    const holds: PendingItem[] = statement
      .filter(i => i.hold)
      .map(i => ({
        id: i.id,
        description: i.description || '',
        amount: Math.abs(i.amount) / 100,
        currency: MONO_CCY_NAMES[i.currencyCode] ?? String(i.currencyCode),
        time: i.time,
      }));

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
