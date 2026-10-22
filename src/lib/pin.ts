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

// Named guard for "is this the PIN household", not a bare `=== PIN_HOUSEHOLD_ID`
// comparison inline at each call site — centralizing it here matches
// currentPinHash/hasPinConfigured's existing convention of never letting
// callers touch the constant directly. This exact class of gap (a route
// that should have compared against PIN_HOUSEHOLD_ID but didn't) already
// caused a real cross-household leak this session (unlinked-users GET).
export function isPinHousehold(householdId: number): boolean {
  return householdId === PIN_HOUSEHOLD_ID;
}

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

// The APP_PIN-env-fallback rule, factored out as a pure function of an
// already-fetched pinHash — lets a caller that's already querying the
// Household row for something else (e.g. onboardedAt) resolve the PIN state
// without a second round trip. currentPinHash()/hasPinConfigured() below are
// just this plus the fetch, for callers that don't already have the row.
function resolvePinHash(householdId: number, pinHash: string | null): string | null {
  if (pinHash) return pinHash;
  // Fallback: PIN from .env until it is changed via Settings for the first
  // time — household #1 only. APP_PIN is a single global value; falling
  // back to it for an arbitrary OTHER household would mean every household
  // with no PIN configured shares the exact same PIN, which defeats the
  // entire point of a per-household lock.
  if (isPinHousehold(householdId)) {
    const envPin = process.env.APP_PIN;
    return envPin ? hashPin(envPin) : null;
  }
  return null;
}

export async function currentPinHash(householdId: number): Promise<string | null> {
  const household = await prisma.household.findUnique({ where: { id: householdId }, select: { pinHash: true } });
  return resolvePinHash(householdId, household?.pinHash ?? null);
}

// Single source of truth for "does this household currently have a working
// PIN" — used to decide the session cookie's hasPin bit at issuance time.
// Goes through resolvePinHash() (not a raw pinHash-column check) so it
// correctly reports true for household #1 even when it's still running on
// the APP_PIN env fallback and has never touched Settings.
export async function hasPinConfigured(householdId: number): Promise<boolean> {
  return !!(await currentPinHash(householdId));
}

// Sync variant for a caller that already has the Household row's pinHash in
// hand (avoids the redundant findUnique currentPinHash() would otherwise do
// for a row already fetched one line above it).
export function hasPinForHousehold(householdId: number, pinHash: string | null): boolean {
  return !!resolvePinHash(householdId, pinHash);
}

// hash === null removes the PIN entirely (Settings' "Прибрати PIN").
export async function setPinHash(householdId: number, hash: string | null): Promise<void> {
  await prisma.household.update({ where: { id: householdId }, data: { pinHash: hash } });
}

// Brute-force guard: a 4-digit PIN is only 10k combinations, so any endpoint
// that checks a PIN must not answer unlimited guesses. Deployed as Vercel
// serverless functions, so in-memory module state is NOT shared across
// invocations — state must live in the database instead. Every 5th straight
// attempt locks the household out, escalating 30s -> 2min -> 10min (cap); only
// a correct PIN (clearPinFailures) resets the escalation. Shared across every
// PIN-checking endpoint (login, unlock, change-PIN, Telegram-account-linking)
// so an attacker can't dodge the lockout by hammering a different route that
// also checks the PIN. Scoped per-household (HouseholdLockout) so one
// household's failed attempts never affect another's lockout state.
// Trade-off: the lock is per household, not per client, so anyone who can reach
// the endpoint can keep the owner locked out by guessing. Accepted.
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

// Kept only so existing callers still compile: the attempt is already charged
// (atomically, BEFORE the compare) by pinLockoutResponse, so there is nothing
// left to record on a wrong guess.
export async function registerPinFailure(_householdId: number) {}

export async function clearPinFailures(householdId: number) {
  await ensureLockoutRow(householdId);
  await prisma.householdLockout.update({ where: { householdId }, data: { failCount: 0, lockedUntil: BigInt(0) } });
}

// Atomic check + charge: ONE UPDATE both refuses a locked household and counts
// this attempt (and sets the lock on every 5th). A separate check-then-record
// let a parallel burst all pass the check before the first failure landed.
// Postgres serializes concurrent UPDATEs on the row, so at most 5 attempts per
// lock cycle ever get past this. Call it right before comparing the PIN; a
// correct PIN must then call clearPinFailures.
export async function pinLockoutResponse(householdId: number): Promise<NextResponse | null> {
  await ensureLockoutRow(householdId);
  const now = BigInt(Date.now());
  const claimed = await prisma.$queryRaw<{ failCount: number }[]>`
    UPDATE "HouseholdLockout" SET
      "failCount" = "failCount" + 1,
      "lockedUntil" = CASE WHEN ("failCount" + 1) % 5 = 0
        THEN ${now}::bigint + (CASE WHEN "failCount" + 1 >= 15 THEN 600000 WHEN "failCount" + 1 >= 10 THEN 120000 ELSE 30000 END)
        ELSE "lockedUntil" END
    WHERE "householdId" = ${householdId} AND "lockedUntil" <= ${now}::bigint
    RETURNING "failCount"
  `;
  if (claimed.length) return null;
  const row = await prisma.householdLockout.findUnique({ where: { householdId } });
  const wait = Math.max(1, Math.ceil((Number(row?.lockedUntil ?? 0) - Date.now()) / 1000));
  return NextResponse.json(
    { error: `Забагато спроб — зачекайте ${wait} с` },
    { status: 429, headers: { 'Retry-After': String(wait) } },
  );
}
