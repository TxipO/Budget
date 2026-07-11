import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPendingEmailRegistration } from '@/lib/magicLink';
import { verifyTelegramAuth } from '@/lib/telegramAuth';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';
import { badRequest } from '@/lib/validate';

// Counterpart to email/register — for someone who already has an account
// (any household, linked via Telegram) and wants to ALSO be able to log in
// with an email they just proved ownership of via the magic-link click.
// Trust boundary: pendingToken proves inbox ownership of the email (already
// verified by magic-link/verify GET, short-lived), the Telegram widget's own
// HMAC proves the caller controls that Telegram account. Both together are
// required — neither alone is enough to attach an email to someone else's
// account.
export async function POST(req: NextRequest) {
  try {
    const authSecret = process.env.AUTH_SECRET;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!authSecret || !botToken) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const { pendingToken, ...telegramData } = body;
    if (typeof pendingToken !== 'string' || !pendingToken) return badRequest('Невалідний токен реєстрації');

    const email = verifyPendingEmailRegistration(authSecret, pendingToken);
    if (!email) {
      return NextResponse.json({ error: 'Токен реєстрації недійсний або протермінований — спробуйте увійти ще раз' }, { status: 401 });
    }

    const verified = verifyTelegramAuth(telegramData, botToken);
    if (!verified) return NextResponse.json({ error: 'Недійсний підпис Telegram' }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { telegramId: verified.id },
      select: { id: true, householdId: true, household: { select: { onboardedAt: true } } },
    });
    if (!user || !user.householdId) {
      return NextResponse.json({ error: 'Немає акаунту з цим Telegram — спершу увійдіть або зареєструйтесь через Telegram' }, { status: 400 });
    }

    try {
      await prisma.user.update({ where: { id: user.id }, data: { email, emailVerifiedAt: new Date() } });
    } catch (e: any) {
      // A different verified user already owns this email — magic-link/verify
      // GET already clears stale UNverified claims, so this only fires on a
      // genuine conflict (e.g. the email is verified on two Telegram accounts
      // via a race), which should just fail rather than silently reassign it.
      if (e?.code === 'P2002') return badRequest("Цей email вже прив'язано до іншого акаунту");
      throw e;
    }

    const res = NextResponse.json({ ok: true, onboarded: !!user.household?.onboardedAt });
    res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(user.householdId), String(user.id)), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[auth/email/link POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
