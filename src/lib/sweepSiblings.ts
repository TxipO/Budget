import { prisma } from '@/lib/prisma';
import { normalizeMerchantKey } from '@/lib/monobank';

// Single implementation of "which OTHER rows of this merchant would a
// category correction sweep along" — used by PUT (does it), sweep-preview
// (counts it) and revert-sweep (re-verifies it), so the three can't drift.

export const SWEEPABLE_SOURCES = ['mono', 'sparebank', 'voice'];

type KeyRow = { source: string; monoMerchant: string | null; details: string };

// mono keys off the raw merchant description; sparebank/voice off `details`
// (same text their ingest paths derive merchantKey from) — mirrors
// categoryGuess.ts tier 1's lookup key.
export function merchantKeyOf(row: KeyRow): string | null {
  const raw = row.source === 'mono' ? row.monoMerchant
    : (row.source === 'voice' || row.source === 'sparebank') ? row.details
    : null;
  if (!raw) return null;
  // '' guard: an all-whitespace text would match every blank-details row.
  const key = normalizeMerchantKey(raw);
  return key === '' ? null : key;
}

export async function findSweepSiblings(args: {
  householdId: number; userId: number; categoryId: number; merchantKey: string; excludeId: number;
}): Promise<number[]> {
  const candidates = await prisma.transaction.findMany({
    where: {
      householdId: args.householdId, userId: args.userId, categoryId: args.categoryId,
      id: { not: args.excludeId }, source: { in: SWEEPABLE_SOURCES },
    },
    select: { id: true, source: true, monoMerchant: true, details: true, categorySource: true },
  });
  // 'manual' = the user set this row's category by hand as a one-off
  // exception — a later sweep must never undo that. Filtered in JS, not SQL:
  // `categorySource != 'manual'` in SQL silently drops the NULL rows too.
  return candidates
    .filter(c => c.categorySource !== 'manual' && merchantKeyOf(c) === args.merchantKey)
    .map(c => c.id);
}
