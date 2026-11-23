import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSessionRevoked } from '@/lib/sessionRevocation';

// Household is capped at 2 members — matches the onboarding wizard's "1 or
// 2 people" step and the sidebar's quick-switch button layout, neither of
// which is designed for an arbitrary-length list. Enforced independently at
// every place a household can gain a member (api/users POST,
// api/onboarding/complete) — shared here so raising the cap later is a
// one-line change instead of two that have to be kept in sync by hand.
export const MAX_USERS = 2;

// shortcut: per-instance cache of the revocation stamps, 30s TTL — a revoke
// can lag up to 30s on every OTHER warm serverless instance (the instance that
// performs the revoke drops its own cache at once via invalidateSessionCache).
// Upgrade to a shared store / no cache if "instant everywhere" ever matters.
const STAMP_TTL_MS = 30_000;
type Stamps = { household: number | null; user: 'shared' | null | { validAfter: number | null } };
const stampCache = new Map<string, { at: number; stamps: Stamps | null }>();

export function invalidateSessionCache() {
  stampCache.clear();
}

async function loadStamps(householdId: number, userId: string | null): Promise<Stamps | null> {
  const key = `${householdId}:${userId ?? 'shared'}`;
  const hit = stampCache.get(key);
  if (hit && Date.now() - hit.at < STAMP_TTL_MS) return hit.stamps;
  const uid = userId === null ? null : Number(userId);
  const h = await prisma.household.findUnique({
    where: { id: householdId },
    select: {
      sessionsValidAfter: true,
      // Scoped to the household, so a user row that moved/never belonged reads as "gone".
      users: uid && Number.isInteger(uid) ? { where: { id: uid }, select: { sessionsValidAfter: true } } : false,
    },
  });
  let stamps: Stamps | null = null;
  if (h) {
    const u = 'users' in h ? h.users[0] : undefined;
    stamps = {
      household: h.sessionsValidAfter?.getTime() ?? null,
      user: userId === null ? 'shared' : u ? { validAfter: u.sessionsValidAfter?.getTime() ?? null } : null,
    };
  }
  stampCache.set(key, { at: Date.now(), stamps });
  return stamps;
}

// Kill sessions issued before now: every session of a household, or every
// session of one user. Any cookie re-issued AFTER this call (same request) has
// issuedAt >= the stamp and survives — that's how "this device stays in" works.
// updateMany for the user case: the row may already be gone (then its sessions
// are rejected anyway, see loadStamps).
export async function revokeSessions(scope: { householdId: number } | { userId: number }): Promise<void> {
  const data = { sessionsValidAfter: new Date() };
  if ('householdId' in scope) await prisma.household.update({ where: { id: scope.householdId }, data, select: { id: true } });
  else await prisma.user.updateMany({ where: { id: scope.userId }, data });
  invalidateSessionCache();
}

// The tenant-isolation boundary for every route touching household-owned
// data (User, Category, Transaction, MonthlyPlan) — AND the single place a
// session's revocation is enforced: every authenticated API route must start
// with `await requireHouseholdId(req)` (null -> 401 Unauthorized, which
// SessionGuard turns into a redirect to /login and a cookie clear).
// middleware.ts always sets the x-household-id / x-current-user-id /
// x-session-issued-at headers itself from the verified session cookie for any
// request that reaches a non-public route — never a client-supplied value by
// the time a route handler sees it. A missing/invalid header means "no valid
// session" (defense-in-depth; unreachable for a protected path).
export async function requireHouseholdId(req: NextRequest): Promise<number | null> {
  const raw = req.headers.get('x-household-id');
  const id = raw ? Number(raw) : NaN;
  const rawIssued = req.headers.get('x-session-issued-at');
  const issuedAt = rawIssued ? Number(rawIssued) : NaN; // Number(null) would be 0 — must fail closed
  if (!(Number.isFinite(id) && id > 0 && Number.isFinite(issuedAt))) return null;
  const stamps = await loadStamps(id, req.headers.get('x-current-user-id'));
  if (!stamps || isSessionRevoked(issuedAt, stamps.household, stamps.user)) return null;
  return id;
}

// Shared shape for "does this client-supplied id actually belong to the
// caller's household" — a write route referencing a categoryId/userId in its
// body must re-check this before using it (the created/updated row would
// otherwise silently link to and expose a foreign household's category name/
// type or user name via its own `include`). Previously each of ~9 call sites
// across transactions/recurring/plans hand-rolled the same
// findFirst({id, householdId}) + null-check; centralizing it here means a
// future route reaches for this instead of re-deriving the pattern (and
// risking a subtly wrong copy — e.g. checking `id` alone).
export async function isOwnedCategory(householdId: number, categoryId: number): Promise<boolean> {
  const cat = await prisma.category.findFirst({ where: { id: categoryId, householdId }, select: { id: true } });
  return !!cat;
}

export async function isOwnedUser(householdId: number, userId: number): Promise<boolean> {
  const u = await prisma.user.findFirst({ where: { id: userId, householdId }, select: { id: true } });
  return !!u;
}
