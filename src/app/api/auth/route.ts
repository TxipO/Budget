import { NextRequest, NextResponse } from 'next/server';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';

const PIN_KEY = 'pinHash';
// Must match SESSION_MAX_AGE_MS in middleware.ts and the cookie's maxAge below.
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 днів

function hashPin(pin: string): string {
  return createHash('sha256').update(`budget-pin:${pin}`).digest('hex');
}

// Both inputs here are always fixed-length hex digests (sha256/hmac-sha256
// output), so comparing .length first leaks nothing an attacker doesn't
// already know — this just guards Buffer.from()/timingSafeEqual, which
// throws on mismatched lengths rather than returning false.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

async function currentPinHash(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: PIN_KEY } });
  if (row) return row.value;
  // Fallback: PIN from .env until it is changed via Settings for the first time
  const envPin = process.env.APP_PIN;
  return envPin ? hashPin(envPin) : null;
}

// issuedAt is embedded and signed so the server can enforce expiry itself
// (see middleware.ts's verifySession) instead of relying solely on the
// browser honoring the cookie's Max-Age — a raw copied cookie value used
// directly via curl/an API client ignores Max-Age entirely otherwise.
function sessionCookieValue(secret: string): string {
  const issuedAt = Date.now();
  const sig = createHmac('sha256', secret).update(`budget-session:${issuedAt}`).digest('hex');
  return `${issuedAt}.${sig}`;
}

// Brute-force guard: a 4-digit PIN is only 10k combinations, so the login
// endpoint must not answer unlimited guesses. Deployed as Vercel serverless
// functions, so in-memory module state is NOT shared across invocations —
// state must live in the database instead. 5 straight failures => 30s lockout.
//
// registerFailure() used to do a read-then-write on a JSON string: read
// state, mutate in JS, write back. Under concurrent requests (parallel
// wrong-PIN attempts — exactly how a real brute-force script behaves, not
// sequentially) multiple invocations could read the same stale count before
// any of them committed, undercounting real attempts. Verified live: 5
// parallel failures + a 6th only reached failCount=3 in the DB, no lockout
// triggered. Fixed by using a single atomic SQL increment on a dedicated
// integer column — Postgres serializes concurrent UPDATEs on the same row
// via a row-level lock, so every failure counts exactly once.
async function ensureLockoutRow() {
  // Concurrent cold-start requests can both attempt the create half of this
  // upsert before either commits, and Postgres/Prisma doesn't retry that as
  // an update — one wins, the other throws P2002. Harmless here (the goal is
  // just "the row exists"), so swallow it.
  try {
    await prisma.authLockout.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
}
async function registerFailure() {
  await ensureLockoutRow();
  const [{ failCount }] = await prisma.$queryRaw<{ failCount: number }[]>`
    UPDATE "AuthLockout" SET "failCount" = "failCount" + 1 WHERE id = 1 RETURNING "failCount"
  `;
  if (failCount >= 5) {
    await prisma.authLockout.update({
      where: { id: 1 },
      data: { lockedUntil: BigInt(Date.now() + 30_000), failCount: 0 },
    });
  }
}
async function clearFailures() {
  await ensureLockoutRow();
  await prisma.authLockout.update({ where: { id: 1 }, data: { failCount: 0, lockedUntil: BigInt(0) } });
}
async function tooManyAttempts(): Promise<NextResponse | null> {
  const row = await prisma.authLockout.findUnique({ where: { id: 1 } });
  const lockedUntil = row ? Number(row.lockedUntil) : 0;
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
