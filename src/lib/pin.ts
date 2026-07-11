import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// PIN login is deliberately staying exclusive to the original household —
// see project_product_direction: every NEW household created going forward
// (email/Telegram signup) never gets PIN auth, only this one legacy
// household does. Hardcoded rather than made generic on purpose; genericizing
// a login mechanism nobody asked to extend would be speculative complexity
// for a decision that's already been made the other way.
export const PIN_HOUSEHOLD_ID = 1;

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
  const household = await prisma.household.findUnique({ where: { id: PIN_HOUSEHOLD_ID }, select: { pinHash: true } });
  if (household?.pinHash) return household.pinHash;
  // Fallback: PIN from .env until it is changed via Settings for the first time
  const envPin = process.env.APP_PIN;
  return envPin ? hashPin(envPin) : null;
}

export async function setPinHash(hash: string): Promise<void> {
  await prisma.household.update({ where: { id: PIN_HOUSEHOLD_ID }, data: { pinHash: hash } });
}

// Brute-force guard: a 4-digit PIN is only 10k combinations, so any endpoint
// that checks a PIN must not answer unlimited guesses. Deployed as Vercel
// serverless functions, so in-memory module state is NOT shared across
// invocations — state must live in the database instead. 5 straight
// failures => 30s lockout. Shared across every PIN-checking endpoint (login,
// change-PIN, Telegram-account-linking) so an attacker can't dodge the
// lockout by hammering a different route that also checks the PIN. Scoped
// per-household (HouseholdLockout, not the old global AuthLockout singleton)
// so a future household's failed attempts — even though only household #1
// ever gets PIN auth today — can never affect a different one's lockout
// state if that assumption ever changes.
async function ensureLockoutRow() {
  // Concurrent cold-start requests can both attempt the create half of this
  // upsert before either commits, and Postgres/Prisma doesn't retry that as
  // an update — one wins, the other throws P2002. Harmless here (the goal is
  // just "the row exists"), so swallow it.
  try {
    await prisma.householdLockout.upsert({ where: { householdId: PIN_HOUSEHOLD_ID }, update: {}, create: { householdId: PIN_HOUSEHOLD_ID } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
}

export async function registerPinFailure() {
  await ensureLockoutRow();
  const [{ failCount }] = await prisma.$queryRaw<{ failCount: number }[]>`
    UPDATE "HouseholdLockout" SET "failCount" = "failCount" + 1 WHERE "householdId" = ${PIN_HOUSEHOLD_ID} RETURNING "failCount"
  `;
  if (failCount >= 5) {
    await prisma.householdLockout.update({
      where: { householdId: PIN_HOUSEHOLD_ID },
      data: { lockedUntil: BigInt(Date.now() + 30_000), failCount: 0 },
    });
  }
}

export async function clearPinFailures() {
  await ensureLockoutRow();
  await prisma.householdLockout.update({ where: { householdId: PIN_HOUSEHOLD_ID }, data: { failCount: 0, lockedUntil: BigInt(0) } });
}

export async function pinLockoutResponse(): Promise<NextResponse | null> {
  const row = await prisma.householdLockout.findUnique({ where: { householdId: PIN_HOUSEHOLD_ID } });
  const lockedUntil = row ? Number(row.lockedUntil) : 0;
  const left = lockedUntil - Date.now();
  const wait = left > 0 ? Math.ceil(left / 1000) : 0;
  if (!wait) return null;
  return NextResponse.json(
    { error: `Забагато спроб — зачекайте ${wait} с` },
    { status: 429, headers: { 'Retry-After': String(wait) } },
  );
}
