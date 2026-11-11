import { prisma } from '@/lib/prisma';

// Same read as verify-data-integrity.mjs's step 4h — shared by the Settings
// status route and the weekly server-side check. Reads stored categorySource
// stats, never calls Groq itself, so it has no latency/cost.
const LOOKBACK_DAYS = 30;

export async function llmTierStatus(householdId: number) {
  const windowStart = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const recent = await prisma.transaction.findMany({
    where: { householdId, categorySource: { not: null }, date: { gte: windowStart } },
    select: { categorySource: true },
  });
  const llmCount = recent.filter(t => t.categorySource === 'llm').length;
  const fallbackCount = recent.filter(t => t.categorySource === 'fallback').length;

  // Same three-way verdict as the script: not enough data to judge, a
  // live incident (fallback rows piling up with zero LLM decisions), or
  // healthy (either the LLM is firing, or the free tiers cover
  // everything and nothing ever needed it).
  const status = recent.length === 0 ? 'unknown' : fallbackCount > 0 && llmCount === 0 ? 'dead' : 'alive';
  return { status, llmCount, fallbackCount, lookbackDays: LOOKBACK_DAYS };
}
