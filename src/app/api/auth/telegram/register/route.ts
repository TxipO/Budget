import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPendingRegistration } from '@/lib/telegramAuth';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';
import { badRequest, isPositiveInt } from '@/lib/validate';

// Not verified in v1 (no email-sending service provisioned) — format-only,
// treats the value as a claimed identifier rather than a proven one.
function isValidEmailFormat(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export async function POST(req: NextRequest) {
  try {
    const authSecret = process.env.AUTH_SECRET;
    if (!authSecret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const body = await req.json();
    const { pendingToken, email, linkToUserId, name } = body;

    if (typeof pendingToken !== 'string' || !pendingToken) return badRequest('Невалідний токен реєстрації');
    const telegramData = verifyPendingRegistration(authSecret, pendingToken);
    if (!telegramData) {
      return NextResponse.json({ error: 'Токен реєстрації недійсний або протермінований — спробуйте увійти ще раз' }, { status: 401 });
    }

    let normalizedEmail: string | null = null;
    if (email !== undefined && email !== null && email !== '') {
      if (!isValidEmailFormat(email)) return badRequest('Невалідний email');
      normalizedEmail = email.trim().toLowerCase();
    }

    let user;
    if (linkToUserId !== undefined && linkToUserId !== null) {
      // Claiming an EXISTING account (Паша/Женя logging in via Telegram for
      // the first time) — never create a new row here, or their transaction
      // history would silently split across two User rows.
      if (!isPositiveInt(Number(linkToUserId))) return badRequest("Невалідний користувач для прив'язки");
      const existing = await prisma.user.findUnique({ where: { id: Number(linkToUserId) } });
      if (!existing) return badRequest('Користувача не знайдено');
      if (existing.telegramId) return badRequest('До цього акаунту вже прив’язано інший Telegram');

      try {
        // updateMany with telegramId: null in the WHERE, not update() by id
        // alone — closes a TOCTOU race where two concurrent requests could
        // both pass the `existing.telegramId` check above for the same
        // account and then both "succeed", the second silently overwriting
        // the first's link with no constraint violation (each sets a
        // different unique telegramId, so nothing at the DB level objects).
        const result = await prisma.user.updateMany({
          where: { id: existing.id, telegramId: null },
          data: {
            telegramId: telegramData.id,
            telegramUsername: telegramData.username ?? null,
            telegramFirstName: telegramData.first_name,
            telegramPhotoUrl: telegramData.photo_url ?? null,
            email: normalizedEmail ?? existing.email, // don't clobber an existing email with "not provided"
          },
        });
        if (result.count === 0) return badRequest('До цього акаунту вже прив’язано інший Telegram');
        user = { id: existing.id, name: existing.name };
      } catch (e: any) {
        if (e?.code === 'P2002') return badRequest('Цей Telegram або email вже використовується іншим акаунтом');
        throw e;
      }
    } else {
      const trimmedName = typeof name === 'string' ? name.trim() : '';
      if (!trimmedName) return badRequest("Вкажіть ім'я");

      try {
        user = await prisma.user.create({
          data: {
            name: trimmedName,
            telegramId: telegramData.id,
            telegramUsername: telegramData.username ?? null,
            telegramFirstName: telegramData.first_name,
            telegramPhotoUrl: telegramData.photo_url ?? null,
            email: normalizedEmail,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return badRequest("Це ім'я, Telegram або email вже використовується");
        throw e;
      }
    }

    const res = NextResponse.json({ ok: true, user: { id: user.id, name: user.name } });
    res.cookies.set('budget-auth', sessionCookieValue(authSecret, String(user.id)), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[auth/telegram/register POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
