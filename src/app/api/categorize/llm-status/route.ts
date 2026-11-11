import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId } from '@/lib/household';
import { llmTierStatus } from '@/lib/llmStatus';

// Exposed for the Settings page — the LLM tier (Groq) sat completely dead for
// an unknown stretch of time on 2026-09-15 (retired model id + empty prod API
// key, both failing open with zero visible error). This surfaces that class of
// failure to the household directly instead of only a script someone has to
// remember to run.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json(await llmTierStatus(householdId));
  } catch (e) {
    console.error('[categorize/llm-status GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
