import { NextResponse } from 'next/server';

// Retired as part of the multi-tenant migration (MT Ф3) — this used to be a
// one-time "name your household members" step for a fresh deployment,
// guarded by a global User.count()===0 check. That check conflated "no
// users yet" with "no households yet": it was already permanently blocked
// in practice (household #1 has had 2 users since the phase-A backfill,
// and users/[id]/route.ts refuses to delete the last user of a household),
// and it created users with no householdId, which is unsafe now that every
// query is household-scoped. New households are created directly by the
// email/magic-link signup flow (MT Ф4), not through this route.
export async function POST() {
  return NextResponse.json({ error: 'Налаштування вже виконано' }, { status: 410 });
}
