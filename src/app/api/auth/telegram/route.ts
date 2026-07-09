import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyTelegramAuth, signPendingRegistration } from '@/lib/telegramAuth';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';

export async function POST(req: NextRequest) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const authSecret = process.env.AUTH_SECRET;
    if (!botToken || !authSecret) {
      return NextResponse.json({ error: 'Telegram-автентифікацію не налаштовано' }, { status: 500 });
    }

    const body = await req.json();
    const verified = verifyTelegramAuth(body, botToken);
    if (!verified) return NextResponse.json({ error: 'Недійсний підпис Telegram' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { telegramId: verified.id }, select: { id: true } });

    if (!user) {
      // First-time login — don't auto-create a row here. It might be a
      // genuinely new account, or it might be Паша/Женя logging in via
      // Telegram for the first time and needing to link to their EXISTING
      // account (auto-creating would silently split their transaction
      // history across two User rows). The registration-complete step
      // decides which.
      return NextResponse.json({
        ok: true,
        needsRegistration: true,
        pendingToken: signPendingRegistration(authSecret, verified),
        telegramFirstName: verified.first_name,
        telegramUsername: verified.username ?? null,
      });
    }

    const res = NextResponse.json({ ok: true, needsRegistration: false });
    res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(user.id)), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[auth/telegram POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
