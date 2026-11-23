import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { getTransactions, type Psu } from '@/lib/enableBanking';
import { sbDescription } from '@/lib/sparebankIngest';
import { getCachedExchangeRate, ISO_4217 } from '@/lib/monobank';
import { numericForCurrency } from '@/lib/currencies';
import { roundMoney } from '@/lib/validate';

// Card reservations ("Reservert" in the SpareBank app) for the dashboard's
// «Очікують підтвердження» card — DISPLAY ONLY, never ingested (the booked row
// arrives through the normal BOOK sync and the reservation just disappears from
// PEND). Unlike the cron/sync, this is fetched ONLY with a real PSU (the person
// opening the dashboard), i.e. in Enable Banking's ATTENDED bucket, so it can't
// eat the ~4/day unattended quota the cron lives on (see getTransactions' comment).
// Bank calls happen only when the cache below is older than CACHE_TTL_MS.
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_CACHE_MAX_MS = 24 * 3600 * 1000; // same cut-off as monoPending: older than this is worse than nothing
const LOOKBACK_DAYS = 14;
const MAX_PAGES = 3;
const INTENT_GRACE_MS = 2 * 24 * 3600 * 1000; // same as monoPending

export interface SbPendingItem {
  id: string; // display key only
  description: string;
  amount: number;
  currency: string;
  time: number; // unix seconds (date only — midnight UTC), same unit as PendingItem.time
}

type Cache = { items: SbPendingItem[]; fetchedAt: number; error?: boolean };

// The cached list only — NEVER a bank call (the intent route validates against what the user sees).
export async function readSparebankPendingCache(userId: number): Promise<Cache | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: `sbPending:${userId}` } });
  const c: Cache | null = row ? JSON.parse(row.value) : null;
  return c && !c.error && Date.now() - c.fetchedAt < STALE_CACHE_MAX_MS ? c : null;
}

export async function loadSparebankPending(userId: number, householdId: number, psu: NonNullable<Psu>): Promise<SbPendingItem[]> {
  // Ownership first — before the cache is read, same as loadPending.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      householdId: true, sbSessionEnc: true, sbValidUntil: true,
      // Reservations sit on the card account; a savings-pool account has none.
      sparebankAccounts: { where: { syncEnabled: true, categoryId: null }, select: { accountUid: true } },
    },
  });
  if (!user || user.householdId !== householdId || !user.sbSessionEnc || user.sparebankAccounts.length === 0) return [];
  if (user.sbValidUntil && user.sbValidUntil.getTime() < Date.now()) return [];

  const cacheKey = `sbPending:${userId}`;
  const row = await prisma.appSetting.findUnique({ where: { key: cacheKey } });
  const cached: Cache | null = row ? JSON.parse(row.value) : null;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.items;

  try {
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { currency: true } });
    const currency = household?.currency ?? 'NOK';
    const targetCcy = numericForCurrency(currency);
    const rate = targetCcy === ISO_4217.NOK ? 1 : await getCachedExchangeRate(ISO_4217.NOK, targetCcy);
    const dateFrom = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);

    const items: SbPendingItem[] = [];
    let complete = rate !== null; // an unconverted/skipped/truncated list must not prune intents
    const seen = new Map<string, number>();
    for (const { accountUid } of user.sparebankAccounts) {
      let continuationKey: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await getTransactions(accountUid, psu, { dateFrom, continuationKey, transactionStatus: 'PDNG' });
        for (const item of res.transactions ?? []) {
          // Expenses only; PDNG/HOLD count as pending, anything else (BOOK/CNCL/RJCT/...) is not a reservation.
          if (item.credit_debit_indicator !== 'DBIT' || (item.status && item.status !== 'PDNG' && item.status !== 'HOLD')) continue;
          const raw = Number(item.transaction_amount?.amount);
          // Non-NOK or unconvertible: skipped rather than shown with a wrong number.
          if (!Number.isFinite(raw)) complete = false;
          if (!Number.isFinite(raw) || item.transaction_amount.currency !== 'NOK' || rate === null) continue;
          const dateStr = item.transaction_date || item.value_date || item.booking_date || new Date().toISOString().slice(0, 10);
          const time = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
          if (!Number.isFinite(time)) { complete = false; continue; }
          const { details } = sbDescription(item, 'expense');
          const amount = roundMoney(Math.abs(raw) * rate);
          const base = createHash('sha1').update(`${accountUid}|${item.entry_reference || item.transaction_id || `${dateStr}|${raw}|${details}`}`).digest('hex').slice(0, 12);
          const n = (seen.get(base) ?? 0) + 1;
          seen.set(base, n);
          items.push({ id: `sb:${base}${n > 1 ? `-${n}` : ''}`, description: details, amount, currency, time });
        }
        continuationKey = res.continuation_key;
        if (!continuationKey) break;
        if (page === MAX_PAGES - 1) complete = false;
      }
    }

    // Category choices whose reservation is gone from a COMPLETE fresh list and were not
    // consumed by the booking ingest (declined/expired). Never on a failed fetch (catch below).
    if (complete) {
      await prisma.pendingCategoryIntent.deleteMany({
        where: { userId, bank: 'sparebank', holdId: { notIn: items.map(i => i.id) }, createdAt: { lt: new Date(Date.now() - INTENT_GRACE_MS) } },
      }).catch((e) => console.error('[sparebankPending] intent prune failed', e));
    }

    await prisma.appSetting.upsert({
      where: { key: cacheKey },
      update: { value: JSON.stringify({ items, fetchedAt: Date.now() }) },
      create: { key: cacheKey, value: JSON.stringify({ items, fetchedAt: Date.now() }) },
    });
    return items;
  } catch (e) {
    // 429 / expired consent / 400 (PEND unsupported) / network: a decorative card must never
    // error and this is not a real sync, so nothing is recorded or alerted — just the cache while recent.
    console.error('[sparebankPending]', e instanceof Error ? e.message : e);
    if (cached && cached.items.length > 0 && Date.now() - cached.fetchedAt < STALE_CACHE_MAX_MS) return cached.items;
    // Negative cache: no usable older list, so don't let every dashboard load within TTL retry the bank.
    const value = JSON.stringify({ items: [], fetchedAt: Date.now(), error: true });
    await prisma.appSetting.upsert({ where: { key: cacheKey }, update: { value }, create: { key: cacheKey, value } }).catch(() => {});
    return [];
  }
}
