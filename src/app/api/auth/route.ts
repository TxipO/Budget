import { NextRequest, NextResponse } from 'next/server';
import { createHash, createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';

const PIN_KEY = 'pinHash';

function hashPin(pin: string): string {
  return createHash('sha256').update(`budget-pin:${pin}`).digest('hex');
}

async function currentPinHash(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: PIN_KEY } });
  if (row) return row.value;
  // Fallback: PIN from .env until it is changed via Settings for the first time
  const envPin = process.env.APP_PIN;
  return envPin ? hashPin(envPin) : null;
}

function sessionToken(secret: string): string {
  return createHmac('sha256', secret).update('budget-session').digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.pin !== 'string' || hashPin(body.pin) !== stored) {
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set('budget-auth', sessionToken(secret), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 днів
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
    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.current !== 'string' || hashPin(body.current) !== stored) {
      return NextResponse.json({ error: 'Невірний поточний PIN' }, { status: 401 });
    }
    if (typeof body.next !== 'string' || !/^\d{4,8}$/.test(body.next)) {
      return NextResponse.json({ error: 'Новий PIN — від 4 до 8 цифр' }, { status: 400 });
    }

    await prisma.appSetting.upsert({
      where: { key: PIN_KEY },
      update: { value: hashPin(body.next) },
      create: { key: PIN_KEY, value: hashPin(body.next) },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('[auth PUT]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
