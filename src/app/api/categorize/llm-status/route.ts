import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';

// Same read as verify-data-integrity.mjs's step 4h, exposed for the
// Settings page — the LLM tier (Groq) sat completely dead for an unknown
// stretch of time on 2026-09-15 (retired model id + empty prod API key,
// both failing open with zero visible error). This surfaces that class of
// failure to the household directly instead of only a script someone has
// to remember to run. Reads stored categorySource stats — never calls
// Groq itself, so checking this status has no latency/cost.
const LOOKBACK_DAYS = 30;

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

    return NextResponse.json({ status, llmCount, fallbackCount, lookbackDays: LOOKBACK_DAYS });
  } catch (e) {
    console.error('[categorize/llm-status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
