import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Unlink Telegram from the logged-in user, falling them back to PIN-only
// login. Doesn't kill the current session (they clicked "disconnect", not
// "log out") — it only stops a future Telegram login from resolving to this
// account until it's linked again.
export async function DELETE(req: NextRequest) {
  try {
    const userId = req.headers.get('x-current-user-id');
    if (!userId) return NextResponse.json({ error: 'Немає прив’язаного Telegram-акаунту' }, { status: 400 });

    // select — the result isn't returned to the client, but update() fetches
    // every column by default otherwise (monoTokenEnc included).
    await prisma.user.update({
      where: { id: Number(userId) },
      data: { telegramId: null, telegramUsername: null, telegramFirstName: null, telegramPhotoUrl: null },
      select: { id: true },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[account/telegram DELETE]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
