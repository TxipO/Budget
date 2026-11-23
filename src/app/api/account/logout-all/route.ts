import { NextRequest, NextResponse } from 'next/server';
import { requireHouseholdId, revokeSessions } from '@/lib/household';
import { issueAuthCookies } from '@/lib/session';
import { hasPinConfigured } from '@/lib/pin';

// "Вийти на всіх пристроях": kills every session of the caller's household
// (all members, all devices) and re-issues THIS device's cookie so it stays in.
// The unlock cookie is left as is (it isn't tied to a session's issuedAt).
export async function POST(req: NextRequest) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    await revokeSessions({ householdId });

    const res = NextResponse.json({ ok: true });
    issueAuthCookies(res, authSecret, {
      householdId: String(householdId),
      userId: req.headers.get('x-current-user-id') ?? 'shared',
      hasPin: await hasPinConfigured(householdId),
    });
    return res;
  } catch (e) {
    console.error('[account/logout-all POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
