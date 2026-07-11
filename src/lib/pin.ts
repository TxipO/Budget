import { createHash, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// PIN LOGIN (typing a PIN instead of email/Telegram to establish identity)
// is deliberately staying exclusive to the original household — see
// project_product_direction. Every other function in this file is
// household-scoped and works for any household: the PIN *lock* (an extra
// "unlock the already-open session" step, see lib/session.ts's hasPin bit
// and middleware.ts) is available to everyone as of the onboarding wizard
// (MT/P4), it's just never the way a NEW household establishes identity in
// the first place.
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

export async function currentPinHash(householdId: number): Promise<string | null> {
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { pinHash: true } });
  if (household?.pinHash) return household.pinHash;
  // Fallback: PIN from .env until it is changed via Settings for the first
  // time — household #1 only. APP_PIN is a single global value; falling
  // back to it for an arbitrary OTHER household would mean every household
  // with no PIN configured shares the exact same PIN, which defeats the
  // entire point of a per-household lock.
  if (householdId === PIN_HOUSEHOLD_ID) {
    const envPin = process.env.APP_PIN;
    return envPin ? hashPin(envPin) : null;
  }
  return null;
}

// Single source of truth for "does this household currently have a working
// PIN" — used to decide the session cookie's hasPin bit at issuance time.
// Goes through currentPinHash() (not a raw pinHash-column check) so it
// correctly reports true for household #1 even when it's still running on
// the APP_PIN env fallback and has never touched Settings.
export async function hasPinConfigured(householdId: number): Promise<boolean> {
  return !!(await currentPinHash(householdId));
}

// hash === null removes the PIN entirely (Settings' "Прибрати PIN").
export async function setPinHash(householdId: number, hash: string | null): Promise<void> {
  await prisma.household.update({ where: { id: householdId }, data: { pinHash: hash } });
}

// Brute-force guard: a 4-digit PIN is only 10k combinations, so any endpoint
// that checks a PIN must not answer unlimited guesses. Deployed as Vercel
// serverless functions, so in-memory module state is NOT shared across
// invocations — state must live in the database instead. 5 straight
// failures => 30s lockout. Shared across every PIN-checking endpoint (login,
// unlock, change-PIN, Telegram-account-linking) so an attacker can't dodge
// the lockout by hammering a different route that also checks the PIN.
// Scoped per-household (HouseholdLockout) so one household's failed
// attempts never affect another's lockout state.
async function ensureLockoutRow(householdId: number) {
  // Concurrent cold-start requests can both attempt the create half of this
  // upsert before either commits, and Postgres/Prisma doesn't retry that as
  // an update — one wins, the other throws P2002. Harmless here (the goal is
  // just "the row exists"), so swallow it.
  try {
    await prisma.householdLockout.upsert({ where: { householdId }, update: {}, create: { householdId } });
  } catch (e: any) {
    if (e?.code !== 'P2002') throw e;
  }
}

export async function registerPinFailure(householdId: number) {
  await ensureLockoutRow(householdId);
  const [{ failCount }] = await prisma.$queryRaw<{ failCount: number }[]>`
    UPDATE "HouseholdLockout" SET "failCount" = "failCount" + 1 WHERE "householdId" = ${householdId} RETURNING "failCount"
  `;
  if (failCount >= 5) {
    await prisma.householdLockout.update({
      where: { householdId },
      data: { lockedUntil: BigInt(Date.now() + 30_000), failCount: 0 },
    });
  }
}

export async function clearPinFailures(householdId: number) {
  await ensureLockoutRow(householdId);
  await prisma.householdLockout.update({ where: { householdId }, data: { failCount: 0, lockedUntil: BigInt(0) } });
}

export async function pinLockoutResponse(householdId: number): Promise<NextResponse | null> {
  const row = await prisma.householdLockout.findUnique({ where: { householdId } });
  const lockedUntil = row ? Number(row.lockedUntil) : 0;
  const left = lockedUntil - Date.now();
  const wait = left > 0 ? Math.ceil(left / 1000) : 0;
  if (!wait) return null;
  return NextResponse.json(
    { error: `Забагато спроб — зачекайте ${wait} с` },
    { status: 429, headers: { 'Retry-After': String(wait) } },
  );
}
