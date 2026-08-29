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
// Operates on ONE SparebankAccount row — a user can own several real
// accounts under one consent (see that model's own comment), each with its
// own independent watermark/floor, so "sync the user" now means calling this
// once per syncEnabled account, not once per user.
//
// Pull-only, same lesson as Monobank's sync: this app never relies on push
// delivery being complete or timely for financial data. Incremental, not a
// full-history re-scan every call: lastSyncedAt is the watermark (set to
// "now" at connect time, advanced after each successful sync), so a normal
// sync only asks for what's happened since last time. RECONCILIATION_OVERLAP_DAYS
// re-checks a few days behind the watermark on every sync (cheap — dedup
// skips anything already stored) to cover transactions that were still
// PDNG/settling at the previous sync. syncFloor (see its own schema comment)
// is a hard lower bound that overlap can never cross, so a deliberately-
// deleted old transaction can't be resurrected by a later sync.
const FALLBACK_LOOKBACK_DAYS = 90; // only used if lastSyncedAt is somehow unset (pre-dates this fix)
const RECONCILIATION_OVERLAP_DAYS = 3;
const MAX_PAGES = 50; // safety cap — a 90-day personal account statement should never need this many pages

export interface SyncableAccount {
  id: number; // SparebankAccount row id — the watermark this call advances
  userId: number; // the account's owner — who ingested transactions get attributed to
  accountUid: string;
  lastSyncedAt: Date | null;
  syncFloor: Date | null;
}

export interface SyncResult {
  createdIds: number[];
  reconciledIds: number[];
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
// an early throw leaves lastSyncedAt exactly where it was and the next
// attempt re-covers the same gap instead of silently skipping it.
export async function syncSparebankAccount(
  account: SyncableAccount,
  householdId: number,
  psu: { ipAddress: string; userAgent?: string } | null,
): Promise<SyncResult> {
  let dateFrom = account.lastSyncedAt
    ? new Date(account.lastSyncedAt.getTime() - RECONCILIATION_OVERLAP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
    : new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (account.syncFloor) {
    const floorStr = account.syncFloor.toISOString().slice(0, 10);
    if (dateFrom < floorStr) dateFrom = floorStr;
  }

  const createdIds: number[] = [];
  const reconciledIds: number[] = [];
  let skippedPending = 0;
  let skippedExisting = 0;
  let skippedError = 0;
  let checked = 0;
  let continuationKey: string | undefined;
  // Fresh per sync call, shared across every page — see
  // buildSbContentKeyBase's own comment in sparebankIngest.ts for why the
  // ordinal-suffix dedup needs one shared counter for the whole fetch.
  const occurrenceCounts = new Map<string, number>();

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    const page = await getTransactions(account.accountUid, psu, { dateFrom, continuationKey, transactionStatus: 'BOOK' });
    for (const item of page.transactions ?? []) {
      checked++;
      // One bad item must never abort the whole batch — a currency
      // conversion throw, or any other single-item failure, mustn't hide
      // every OTHER transaction in the page behind it.
      try {
        const outcome = await ingestTransaction(account.userId, householdId, item, account.id, occurrenceCounts);
        if (outcome.status === 'created' && outcome.id) createdIds.push(outcome.id);
        else if (outcome.status === 'reconciled' && outcome.id) reconciledIds.push(outcome.id);
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

  const previousSyncedAt = account.lastSyncedAt;
  await prisma.sparebankAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });

  return { createdIds, reconciledIds, previousSyncedAt, skippedPending, skippedExisting, skippedError, checked };
}

export { EnableBankingError };
