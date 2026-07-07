import { NextRequest, NextResponse } from 'next/server';
import { createHash, createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';

const PIN_KEY = 'pinHash';
const LOCKOUT_KEY = 'authLockout';

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

// Brute-force guard: a 4-digit PIN is only 10k combinations, so the login
// endpoint must not answer unlimited guesses. Deployed as Vercel serverless
// functions, so in-memory module state is NOT shared across invocations —
// state must live in the database instead. 5 straight failures => 30s lockout.
interface LockoutState { failCount: number; lockedUntil: number }

async function readLockout(): Promise<LockoutState> {
  const row = await prisma.appSetting.findUnique({ where: { key: LOCKOUT_KEY } });
  if (!row) return { failCount: 0, lockedUntil: 0 };
  try { return JSON.parse(row.value); } catch { return { failCount: 0, lockedUntil: 0 }; }
}
async function writeLockout(state: LockoutState) {
  await prisma.appSetting.upsert({
    where: { key: LOCKOUT_KEY },
    update: { value: JSON.stringify(state) },
    create: { key: LOCKOUT_KEY, value: JSON.stringify(state) },
  });
}
async function registerFailure() {
  const state = await readLockout();
  state.failCount++;
  if (state.failCount >= 5) {
    state.lockedUntil = Date.now() + 30_000;
    state.failCount = 0;
  }
  await writeLockout(state);
}
async function clearFailures() {
  await writeLockout({ failCount: 0, lockedUntil: 0 });
}
async function tooManyAttempts(): Promise<NextResponse | null> {
  const { lockedUntil } = await readLockout();
  const left = lockedUntil - Date.now();
  const wait = left > 0 ? Math.ceil(left / 1000) : 0;
  if (!wait) return null;
  return NextResponse.json(
    { error: `Забагато спроб — зачекайте ${wait} с` },
    { status: 429, headers: { 'Retry-After': String(wait) } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.AUTH_SECRET;
    if (!secret) return NextResponse.json({ error: 'Автентифікацію не налаштовано' }, { status: 500 });

    const blocked = await tooManyAttempts();
    if (blocked) return blocked;

    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.pin !== 'string' || hashPin(body.pin) !== stored) {
      await registerFailure();
      return NextResponse.json({ error: 'Невірний PIN' }, { status: 401 });
    }
    await clearFailures();

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
    const blocked = await tooManyAttempts();
    if (blocked) return blocked;

    const stored = await currentPinHash();
    if (!stored) return NextResponse.json({ error: 'PIN не налаштовано' }, { status: 500 });

    const body = await req.json();
    if (typeof body.current !== 'string' || hashPin(body.current) !== stored) {
      await registerFailure();
      return NextResponse.json({ error: 'Невірний поточний PIN' }, { status: 401 });
    }
    await clearFailures();
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
