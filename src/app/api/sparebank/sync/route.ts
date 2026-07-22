import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { getTransactions, EnableBankingError } from '@/lib/enableBanking';
import { ingestTransaction } from '@/lib/sparebankIngest';
import { requireHouseholdId } from '@/lib/household';

// Pull-only, same lesson as Monobank's sync route: this app never relies on
// push delivery being complete or timely for financial data — a manually
// triggered reconciliation against the ASPSP's own transaction list is the
// only thing treated as a source of truth. Enable Banking also has no
// webhook mechanism comparable to Monobank's for this restricted-mode setup,
// so pull is the ONLY path here, not just the safety net.
//
// Incremental, not a full-history re-scan every click: user.sbLastSyncedAt
// is the watermark (set to "now" at connect time, advanced after each
// successful sync — see api/sparebank/callback), so a normal sync only asks
// for what's happened since last time, mirroring what Monobank gets for
// free from its webhook firing only on new events. Found live 2026-07-22:
// without this, every sync re-scanned a fixed 90-day window and silently
// recreated anything the user had deleted in the meantime — same trap as
// the Monobank webhook-redelivery incident, just via re-scan instead of
// redelivery. RECONCILIATION_OVERLAP_DAYS re-checks a few days behind the
// watermark on every sync (cheap — dedup skips anything already stored) to
// cover transactions that were still PDNG/settling at the previous sync.
const FALLBACK_LOOKBACK_DAYS = 90; // only used if sbLastSyncedAt is somehow unset (pre-dates this fix)
const RECONCILIATION_OVERLAP_DAYS = 3;

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, householdId: true, sbSessionEnc: true, sbAccountUid: true, sbValidUntil: true, sbLastSyncedAt: true },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.sbSessionEnc || !user.sbAccountUid) return badRequest('Не підключено');
    if (user.sbValidUntil && user.sbValidUntil.getTime() < Date.now()) {
      return badRequest('Доступ до банку прострочено — перепідключіть SpareBank 1');
    }

    const dateFrom = user.sbLastSyncedAt
      ? new Date(user.sbLastSyncedAt.getTime() - RECONCILIATION_OVERLAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
      : new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);

    let created = 0;
    let skippedPending = 0;
    let skippedExisting = 0;
    let checked = 0;
    let continuationKey: string | undefined;
    const MAX_PAGES = 50; // safety cap — a 90-day personal account statement should never need this many pages

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      let page;
      try {
        page = await getTransactions(user.sbAccountUid, { dateFrom, continuationKey, transactionStatus: 'BOOK' });
      } catch (e) {
        if (e instanceof EnableBankingError) return NextResponse.json({ error: e.message }, { status: e.status === 429 ? 429 : 400 });
        throw e;
      }
      for (const item of page.transactions ?? []) {
        checked++;
        const result = await ingestTransaction(user.id, householdId, item);
        if (result === 'created') created++;
        else if (result === 'skipped_pending') skippedPending++;
        else if (result === 'skipped_duplicate') skippedExisting++;
      }
      continuationKey = page.continuation_key;
      if (!continuationKey) break;
    }

    // Only advance the watermark once every page has been fetched and
    // ingested without error — an early return above (rate limit, API
    // error) must leave it where it was, so the next sync re-covers the gap
    // instead of silently skipping it.
    await prisma.user.update({ where: { id: user.id }, data: { sbLastSyncedAt: new Date() } });

    return NextResponse.json({ ok: true, created, skippedPending, skippedExisting, checked });
  } catch (e) {
    console.error('[sparebank/sync POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
