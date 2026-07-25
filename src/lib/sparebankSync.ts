import { prisma } from '@/lib/prisma';
import { getTransactions, EnableBankingError } from '@/lib/enableBanking';
import { ingestTransaction } from '@/lib/sparebankIngest';

// The actual sync algorithm, shared by two callers with very different
// trust/PSU shapes: api/sparebank/sync (a real button click, has req.headers
// to source a genuine PSU IP from) and api/cron/sparebank-sync (a scheduled
// job with no end-user request behind it at all, psu is always null — see
// getTransactions' own comment on why that's an honest `null`, not a
// shortcut). Pulling this out stops those two routes from re-implementing
// the same pagination/watermark/floor/error-isolation logic twice, which is
// exactly the "two independent subsystems modeling the same real-world
// write" trap this project has hit before (Excel-plan import vs recurring
// templates both silently double-counting rent).
//
// Pull-only, same lesson as Monobank's sync: this app never relies on push
// delivery being complete or timely for financial data. Incremental, not a
// full-history re-scan every call: sbLastSyncedAt is the watermark (set to
// "now" at connect time, advanced after each successful sync), so a normal
// sync only asks for what's happened since last time. RECONCILIATION_OVERLAP_DAYS
// re-checks a few days behind the watermark on every sync (cheap — dedup
// skips anything already stored) to cover transactions that were still
// PDNG/settling at the previous sync. sbSyncFloor (see its own schema
// comment) is a hard lower bound that overlap can never cross, so a
// deliberately-deleted old transaction can't be resurrected by a later sync.
const FALLBACK_LOOKBACK_DAYS = 90; // only used if sbLastSyncedAt is somehow unset (pre-dates this fix)
const RECONCILIATION_OVERLAP_DAYS = 3;
const MAX_PAGES = 50; // safety cap — a 90-day personal account statement should never need this many pages

export interface SparebankUser {
  id: number;
  sbAccountUid: string;
  sbLastSyncedAt: Date | null;
  sbSyncFloor: Date | null;
}

export interface SyncResult {
  createdIds: number[];
  previousSyncedAt: Date | null;
  skippedPending: number;
  skippedExisting: number;
  skippedError: number;
  checked: number;
}

// Throws EnableBankingError on an ASPSP/gateway-level failure (rate limit,
// auth expired, etc.) — the caller decides how to surface that (an HTTP
// response for the manual route, a Telegram alert + failure counter for the
// cron route). Never partially advances the watermark: it only moves once
// every page has been fetched and ingested without an unrecovered error, so
// an early throw leaves sbLastSyncedAt exactly where it was and the next
// attempt re-covers the same gap instead of silently skipping it.
export async function syncSparebankUser(
  user: SparebankUser,
  householdId: number,
  psu: { ipAddress: string; userAgent?: string } | null,
): Promise<SyncResult> {
  let dateFrom = user.sbLastSyncedAt
    ? new Date(user.sbLastSyncedAt.getTime() - RECONCILIATION_OVERLAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (user.sbSyncFloor) {
    const floorStr = user.sbSyncFloor.toISOString().slice(0, 10);
    if (dateFrom < floorStr) dateFrom = floorStr;
  }

  const createdIds: number[] = [];
  let skippedPending = 0;
  let skippedExisting = 0;
  let skippedError = 0;
  let checked = 0;
  let continuationKey: string | undefined;

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const page = await getTransactions(user.sbAccountUid, psu, { dateFrom, continuationKey, transactionStatus: 'BOOK' });
    for (const item of page.transactions ?? []) {
      checked++;
      // One bad item must never abort the whole batch — a currency
      // conversion throw, or any other single-item failure, mustn't hide
      // every OTHER transaction in the page behind it.
      try {
        const outcome = await ingestTransaction(user.id, householdId, item);
        if (outcome.status === 'created' && outcome.id) createdIds.push(outcome.id);
        else if (outcome.status === 'skipped_pending') skippedPending++;
        else if (outcome.status === 'skipped_duplicate') skippedExisting++;
      } catch (e) {
        console.error('[sparebankSync] item failed, continuing with the rest', item.entry_reference, e);
        skippedError++;
      }
    }
    continuationKey = page.continuation_key;
    if (!continuationKey) break;
  }

  const previousSyncedAt = user.sbLastSyncedAt;
  await prisma.user.update({ where: { id: user.id }, data: { sbLastSyncedAt: new Date() } });

  return { createdIds, previousSyncedAt, skippedPending, skippedExisting, skippedError, checked };
}

export { EnableBankingError };
