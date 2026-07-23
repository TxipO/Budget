import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isPinHousehold as checkIsPinHousehold, hasPinForHousehold } from '@/lib/pin';
import { requireHouseholdId } from '@/lib/household';

// Not under /api/auth/ — that prefix is middleware's PUBLIC_PREFIXES bypass
// for pre-login routes. This one needs the opposite: it reads
// x-current-user-id, which middleware only sets after verifying a real
// session, so it must go through the normal auth gate like any other page.
export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Single source of truth for isPinHousehold/onboarded/hasPin — derived
    // from the household itself (via the session-carried householdId, never
    // a client-supplied value) rather than assumed from which branch below
    // runs, so it stays correct even for edge cases (e.g. a shared-PIN
    // session for a household that isn't #1, if that ever becomes possible).
    // One query for both onboardedAt and pinHash — hasPinForHousehold()
    // resolves the APP_PIN fallback locally instead of hasPinConfigured()
    // re-fetching the same row a second time.
    const household = await prisma.household.findUnique({ where: { id: householdId }, select: { onboardedAt: true, pinHash: true, currency: true } });
    const onboarded = !!household?.onboardedAt;
    const isPinHousehold = checkIsPinHousehold(householdId);
    // Settings' Security section reads this to decide "set" vs "change/
    // remove" PIN mode, and whether to ask for the current PIN at all.
    const hasPin = hasPinForHousehold(householdId, household?.pinHash ?? null);
    // Every page's useCurrency() hook (lib/useCurrency.ts) reads this one
    // field from this exact response — this route is already the one thing
    // every page hits on load, so it doubles as the currency bootstrap
    // instead of adding a second endpoint.
    const currency = household?.currency ?? 'NOK';

    const userId = req.headers.get('x-current-user-id');
    if (!userId) return NextResponse.json({ shared: true, isPinHousehold, onboarded, hasPin, currency });

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { id: true, name: true, telegramUsername: true, telegramFirstName: true, email: true },
    });
    if (!user) return NextResponse.json({ shared: true, isPinHousehold, onboarded, hasPin, currency });
    return NextResponse.json({ shared: false, user, isPinHousehold, onboarded, hasPin, currency });
  } catch (e) {
    console.error('[account/me GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
