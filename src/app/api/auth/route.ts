import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sessionCookieValue, SESSION_MAX_AGE_S } from '@/lib/session';
import { hashPin, safeEqual, currentPinHash, registerPinFailure as registerFailure, clearPinFailures as clearFailures, pinLockoutResponse as tooManyAttempts } from '@/lib/pin';

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const blocked = await tooManyAttempts();
    if (blocked) return blocked;

    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.pin !== 'string' || !safeEqual(hashPin(body.pin), stored)) {
      await registerFailure();
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }
    await clearFailures();

    const res = NextResponse.json({ ok: true });
    res.cookies.set('budget-auth', sessionCookieValue(secret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return res;
  } catch (e) {
    console.error('[auth POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Change PIN: requires the current PIN, applies immediately (no restart)
export async function PUT(req: NextRequest) {
  try {
    const blocked = await tooManyAttempts();
    if (blocked) return blocked;

    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.current !== 'string' || !safeEqual(hashPin(body.current), stored)) {
      await registerFailure();
      return NextResponse.json({ error: 'Невірний поточний PIN' }, { status: 401 });
    }
    await clearFailures();
    if (typeof body.next !== 'string' || !/^\d{4,8}$/.test(body.next)) {
      return NextResponse.json({ error: 'Новий PIN — від 4 до 8 цифр' }, { status: 400 });
    }

    await prisma.appSetting.upsert({
      where: { key: 'pinHash' },
      update: { value: hashPin(body.next) },
      create: { key: 'pinHash', value: hashPin(body.next) },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[auth PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
