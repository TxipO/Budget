import { prisma } from '@/lib/prisma';
import { usableMerchantKey } from '@/lib/merchantKey';

// Single implementation of "which OTHER rows of this merchant would a
// category correction sweep along" — used by PUT (does it), sweep-preview
// (counts it) and revert-sweep (re-verifies it), so the three can't drift.

export const SWEEPABLE_SOURCES = ['mono', 'sparebank', 'voice'];

type KeyRow = { source: string; monoMerchant: string | null; details: string; merchantText: string | null; categorySource: string | null };

// mono keys off the raw merchant description (monoMerchant); sparebank/voice
// off merchantText — the text their ingest paths derive the key from, kept
// apart from `details` because details is also the user's editable comment
// (editing it used to change the row's key). Fallback to details ONLY for a
// row ingested before merchantText existed AND never hand-edited: a 'manual'
// row's details may be a user comment, never a merchant.
// null = no usable merchant (blank, or only a payment-type phrase like
// "nettgiro") — nothing to learn, look up or sweep.
export function merchantKeyOf(row: KeyRow): string | null {
  const raw = row.source === 'mono' ? row.monoMerchant
    : (row.source === 'voice' || row.source === 'sparebank') ? (row.merchantText ?? (row.categorySource !== 'manual' ? row.details : null))
    : null;
  return usableMerchantKey(raw);
}

export async function findSweepSiblings(args: {
  householdId: number; userId: number; categoryId: number; merchantKey: string; excludeId: number;
}): Promise<number[]> {
  const candidates = await prisma.transaction.findMany({
    where: {
      householdId: args.householdId, userId: args.userId, categoryId: args.categoryId,
      id: { not: args.excludeId }, source: { in: SWEEPABLE_SOURCES },
    },
    select: { id: true, source: true, monoMerchant: true, details: true, merchantText: true, categorySource: true },
  });
  // 'manual' = the user set this row's category by hand as a one-off
  // exception — a later sweep must never undo that. Filtered in JS, not SQL:
  // `categorySource != 'manual'` in SQL silently drops the NULL rows too.
  return candidates
    .filter(c => c.categorySource !== 'manual' && merchantKeyOf(c) === args.merchantKey)
    .map(c => c.id);
}
