import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const PIN_KEY = 'pinHash';

export function hashPin(pin: string): string {
  return createHash('sha256').update(`budget-pin:${pin}`).digest('hex');
}

// Both inputs here are always fixed-length hex digests (sha256 output), so
// comparing .length first leaks nothing an attacker doesn't already know —
// this just guards Buffer.from()/timingSafeEqual, which throws on
// mismatched lengths rather than returning false.
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export async function currentPinHash(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: PIN_KEY } });
  if (row) return row.value;
  // Fallback: PIN from .env until it is changed via Settings for the first time
  const envPin = process.env.APP_PIN;
  return envPin ? hashPin(envPin) : null;
}

// Brute-force guard: a 4-digit PIN is only 10k combinations, so any endpoint
// that checks a PIN must not answer unlimited guesses. Deployed as Vercel
// serverless functions, so in-memory module state is NOT shared across
// invocations — state must live in the database instead. 5 straight
// failures => 30s lockout. Shared across every PIN-checking endpoint (login,
// change-PIN, Telegram-account-linking) so an attacker can't dodge the
// lockout by hammering a different route that also checks the PIN.
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

export async function registerPinFailure() {
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

export async function clearPinFailures() {
  await ensureLockoutRow();
  await prisma.authLockout.update({ where: { id: 1 }, data: { failCount: 0, lockedUntil: BigInt(0) } });
}

export async function pinLockoutResponse(): Promise<NextResponse | null> {
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
