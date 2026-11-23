import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId, revokeSessions } from '@/lib/household';
import { issueAuthCookies } from '@/lib/session';
import { hasPinConfigured } from '@/lib/pin';

// Unlink Telegram from the logged-in user, falling them back to PIN-only
// login. Doesn't kill THIS device's session (they clicked "disconnect", not
// "log out") but does kill this user's sessions everywhere else — whoever
// held the old Telegram account must not keep a live session.
export async function DELETE(req: NextRequest) {
  try {
    const householdId = await requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = req.headers.get('x-current-user-id');
    if (!userId) return NextResponse.json({ error: 'Немає прив’язаного Telegram-акаунту' }, { status: 400 });

    // select — the result isn't returned to the client, but update() fetches
    // every column by default otherwise (monoTokenEnc included).
    await prisma.user.update({
      where: { id: Number(userId) },
      data: { telegramId: null, telegramUsername: null, telegramFirstName: null, telegramPhotoUrl: null },
      select: { id: true },
    });
    await revokeSessions({ userId: Number(userId) });
    const authSecret = process.env.AUTH_SECRET;
    const res = NextResponse.json({ ok: true });
    // Re-issue this device's cookie (issuedAt >= the stamp); unlock cookie untouched.
    if (authSecret) issueAuthCookies(res, authSecret, { householdId: String(householdId), userId, hasPin: await hasPinConfigured(householdId) });
    return res;
  } catch (e) {
    console.error('[account/telegram DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
