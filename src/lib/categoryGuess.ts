import { prisma } from '@/lib/prisma';
import { guessCategoryByMcc, guessCategoryByKeyword } from '@/lib/monobank';

// Extracted out of the Monobank webhook route (was resolveCategoryId there) —
// voice-logged transactions need the exact same rule → MCC → keyword →
// fallback tiers, just called with mcc: undefined (a voice transcript has no
// MCC, only free text). Two callers now; sharing this instead of duplicating
// it is the fix for the "same concept, two independent implementations" bug
// class this project's /deep-review already watches for.
export async function guessCategoryId(userId: number, txType: 'expense' | 'income', merchantKey: string, mcc: number | undefined): Promise<number> {
  // 1. Learned rule from a manual correction — highest priority, no guessing.
  const rule = await prisma.monoCategoryRule.findUnique({
    where: { userId_merchantKey: { userId, merchantKey } },
  });
  if (rule) return rule.categoryId;

  // Tiers 2-5 (MCC guess, keyword guess, safe fallback, last resort) are all
  // just "find an active category of this type by name" against the same
  // set — one query instead of up to four separate round-trips.
  const categories = await prisma.category.findMany({ where: { type: txType, isActive: true }, orderBy: { id: 'asc' } });
  const idByName = new Map(categories.map(c => [c.name, c.id]));

  // 2. MCC guess — free, no external call (standard ISO 18245 codes). Skipped
  // entirely when mcc is undefined (voice transcripts have none).
  const mccGuess = guessCategoryByMcc(mcc);
  if (mccGuess && idByName.has(mccGuess)) return idByName.get(mccGuess)!;

  // 3. Keyword guess — also free. Works against a merchant description
  // (Monobank) or a voice transcript (voice logging) equally well.
  const keywordGuess = guessCategoryByKeyword(merchantKey);
  if (keywordGuess && idByName.has(keywordGuess)) return idByName.get(keywordGuess)!;

  // 4. Safe fallback — a bucket that always exists for the type.
  const fallbackName = txType === 'expense' ? 'Незрозуміло' : 'Додаткове';
  if (idByName.has(fallbackName)) return idByName.get(fallbackName)!;

  // 5. Absolute last resort — any active category of the right type, so a
  // write never crashes even if the expected fallback category was renamed
  // or deleted.
  if (categories[0]) return categories[0].id;
  throw new Error(`No active ${txType} category exists to file a transaction under`);
}
