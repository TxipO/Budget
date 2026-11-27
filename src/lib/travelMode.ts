import type { Trip } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { FALLBACK_CATEGORIES } from '@/lib/defaultCategories';
import { merchantKeyOf, SWEEPABLE_SOURCES } from '@/lib/sweepSiblings';

// Travel mode: while a trip is active, an UNKNOWN merchant on one of its accounts
// is filed under the trip's category (categorySource 'travel'). One rule, used by
// live ingest (travelOverride) and by the retroactive preview/apply
// (tripCandidates) so the two can never disagree. See specs/002-travel-mode.

export const TRAVEL_CATEGORY_NAME = 'Подорожі';

// Only these tiers are guesses; rule/brand/history/manual/intent/reversal are the
// household's own decisions and are never overridden. null (legacy rows) is not weak.
const WEAK_SOURCES = ['mcc', 'keyword', 'llm', 'fallback', 'self-named'];
// Sparebank books card purchases 2-3 days after the purchase.
const SPAREBANK_BOOKING_LAG_DAYS = 3;
const KNOWN_LOOKBACK_DAYS = 365;
const DAY_MS = 86_400_000;

export type Bank = 'mono' | 'sparebank';
export type TripRule = Pick<Trip, 'id' | 'householdId' | 'startDate' | 'endDate' | 'accounts' | 'categoryId'>;
const TRIP_RULE_SELECT = { id: true, householdId: true, startDate: true, endDate: true, accounts: true, categoryId: true } as const;

export function utcToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

// A stored row's account key. Sparebank rows carry no account column, but their
// sbTransactionId always starts "sb<SparebankAccount.id>|" (buildSbContentKeyBase).
export function accountOf(row: { source: string; userId: number | null; sbTransactionId: string | null }): string | null {
  if (row.source === 'mono') return row.userId ? `mono:${row.userId}` : null;
  if (row.source === 'sparebank') {
    const m = row.sbTransactionId?.match(/^sb(\d+)\|/);
    return m ? `sb:${m[1]}` : null;
  }
  return null;
}

function lastDay(trip: Pick<TripRule, 'endDate'>, bank: Bank): Date | null {
  return trip.endDate ? new Date(trip.endDate.getTime() + (bank === 'sparebank' ? SPAREBANK_BOOKING_LAG_DAYS : 0) * DAY_MS) : null;
}
function inWindow(trip: TripRule, date: Date, bank: Bank): boolean {
  const end = lastDay(trip, bank);
  return date >= trip.startDate && (end === null || date <= end);
}

export async function findActiveTripFor(householdId: number, account: string, date: Date, bank: Bank): Promise<TripRule | null> {
  const trips = await prisma.trip.findMany({
    where: { householdId, accounts: { has: account }, startDate: { lte: date } },
    select: TRIP_RULE_SELECT,
    orderBy: { startDate: 'desc' },
  });
  return trips.find(t => inWindow(t, date, bank)) ?? null;
}

export interface TravelTx {
  account: string; bank: Bank; date: Date;
  key: string | null;                 // merchantKey; null = no usable merchant text
  categoryId: number; categorySource: string | null; categoryType: string; categoryLocked: boolean;
  isTransfer: boolean;
}

// Everything except "is the merchant already known" (needs a DB read) — cheap gate.
export function tripRuleHolds(trip: TripRule, tx: TravelTx): boolean {
  return trip.accounts.includes(tx.account)
    && inWindow(trip, tx.date, tx.bank)
    && !tx.isTransfer && tx.categoryType === 'expense'
    && tx.categoryId !== trip.categoryId
    && tx.categorySource !== null && WEAK_SOURCES.includes(tx.categorySource)
    && !tx.categoryLocked
    // No usable merchant (bare "nettgiro"-style text) is a bill, not a purchase.
    // «Поповнення «…»» = Monobank jar top-ups, i.e. gifts/donations, not trip spending.
    && tx.key !== null && !tx.key.startsWith('поповнення');
}

// The decision. `known` = keys the household already filed before the trip.
export function decideTravel(trip: TripRule, tx: TravelTx, known: Set<string>): boolean {
  return tripRuleHolds(trip, tx) && !known.has(tx.key!);
}

// Merchants the household already knows: seen in the 365 days before the trip
// under a real category (not the fallback, not the trip category, not a previous
// 'travel' move), or taught a rule by anyone in the household.
export async function knownMerchantKeys(trip: TripRule): Promise<Set<string>> {
  const [rows, rules] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        householdId: trip.householdId, source: { in: SWEEPABLE_SOURCES },
        date: { gte: new Date(trip.startDate.getTime() - KNOWN_LOOKBACK_DAYS * DAY_MS), lt: trip.startDate },
        categoryId: { not: trip.categoryId },
        category: { NOT: { type: 'expense', name: FALLBACK_CATEGORIES.expense.name } },
        OR: [{ categorySource: null }, { categorySource: { not: 'travel' } }],
      },
      select: { source: true, monoMerchant: true, details: true, merchantText: true, categorySource: true },
    }),
    prisma.monoCategoryRule.findMany({ where: { user: { householdId: trip.householdId } }, select: { merchantKey: true } }),
  ]);
  const known = new Set(rules.map(r => r.merchantKey));
  for (const r of rows) { const k = merchantKeyOf(r); if (k) known.add(k); }
  return known;
}

// Live ingest, called right after guessCategoryId. null = leave the guess alone.
export async function travelOverride(a: {
  householdId: number; account: string; bank: Bank; date: Date; key: string;
  guess: { categoryId: number; source: string };
}): Promise<{ categoryId: number; tripId: number; prevCategoryId: number; prevSource: string } | null> {
  if (!WEAK_SOURCES.includes(a.guess.source)) return null;
  const trip = await findActiveTripFor(a.householdId, a.account, a.date, a.bank);
  if (!trip) return null;
  const cat = await prisma.category.findUnique({ where: { id: a.guess.categoryId }, select: { type: true, lockedFromModes: true } });
  if (!cat) return null;
  const tx: TravelTx = {
    account: a.account, bank: a.bank, date: a.date, key: a.key || null,
    categoryId: a.guess.categoryId, categorySource: a.guess.source, categoryType: cat.type, categoryLocked: cat.lockedFromModes, isTransfer: false,
  };
  if (!tripRuleHolds(trip, tx) || !decideTravel(trip, tx, await knownMerchantKeys(trip))) return null;
  return { categoryId: trip.categoryId, tripId: trip.id, prevCategoryId: a.guess.categoryId, prevSource: a.guess.source };
}

export async function ensureTravelCategory(householdId: number): Promise<number> {
  // Revives a soft-deleted one, same as categoryGuess's fallback upsert.
  const { id } = await prisma.category.upsert({
    where: { householdId_name_type: { householdId, name: TRAVEL_CATEGORY_NAME, type: 'expense' } },
    update: { isActive: true },
    create: { householdId, name: TRAVEL_CATEGORY_NAME, type: 'expense', color: '#0EA5E9', icon: 'plane' },
    select: { id: true },
  });
  return id;
}

export interface TravelCandidate {
  id: number; date: Date; amount: number; merchant: string;
  account: string; categoryId: number; categoryName: string; categorySource: string;
}

// Stored rows the rule would move into the trip right now (preview + apply).
export async function tripCandidates(trip: TripRule): Promise<TravelCandidate[]> {
  const end = lastDay(trip, 'sparebank'); // widest window; each row is re-checked against its own bank's
  const rows = await prisma.transaction.findMany({
    where: {
      householdId: trip.householdId, source: { in: ['mono', 'sparebank'] }, isTransfer: false,
      date: { gte: trip.startDate, ...(end ? { lte: end } : {}) },
      categoryId: { not: trip.categoryId }, categorySource: { in: WEAK_SOURCES },
      category: { type: 'expense', lockedFromModes: false },
    },
    select: {
      id: true, date: true, amount: true, source: true, userId: true, sbTransactionId: true,
      monoMerchant: true, merchantText: true, details: true, categoryId: true, categorySource: true,
      category: { select: { name: true, type: true, lockedFromModes: true } },
    },
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  const known = await knownMerchantKeys(trip);
  const out: TravelCandidate[] = [];
  for (const r of rows) {
    const account = accountOf(r);
    if (!account) continue;
    const tx: TravelTx = {
      account, bank: r.source === 'mono' ? 'mono' : 'sparebank', date: r.date, key: merchantKeyOf(r),
      categoryId: r.categoryId, categorySource: r.categorySource, categoryType: r.category.type, categoryLocked: r.category.lockedFromModes,
      isTransfer: false,
    };
    if (!decideTravel(trip, tx, known)) continue;
    out.push({
      id: r.id, date: r.date, amount: r.amount, merchant: (r.monoMerchant ?? r.merchantText ?? r.details).replace(/\s+/g, ' ').trim(),
      account, categoryId: r.categoryId, categoryName: r.category.name, categorySource: r.categorySource!,
    });
  }
  return out;
}

// Accounts a trip may cover: each household member with Monobank connected (monoAccountId is set on connect, cleared on disconnect), every
// SpareBank account. `pool` = tracked savings pool, shown but unchecked by default.
export async function tripAccountOptions(householdId: number): Promise<{ key: string; label: string; pool: boolean }[]> {
  const [users, sb] = await Promise.all([
    prisma.user.findMany({ where: { householdId, monoAccountId: { not: null } }, select: { id: true, name: true }, orderBy: { id: 'asc' } }),
    prisma.sparebankAccount.findMany({ where: { user: { householdId } }, select: { id: true, label: true, categoryId: true }, orderBy: { id: 'asc' } }),
  ]);
  return [
    ...users.map(u => ({ key: `mono:${u.id}`, label: `Mono · ${u.name}`, pool: false })),
    ...sb.map(a => ({ key: `sb:${a.id}`, label: `SpareBank · ${a.label}`, pool: a.categoryId !== null })),
  ];
}
