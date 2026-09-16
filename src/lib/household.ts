import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

// Household is capped at 2 members — matches the onboarding wizard's "1 or
// 2 people" step and the sidebar's quick-switch button layout, neither of
// which is designed for an arbitrary-length list. Enforced independently at
// every place a household can gain a member (api/users POST,
// api/onboarding/complete) — shared here so raising the cap later is a
// one-line change instead of two that have to be kept in sync by hand.
export const MAX_USERS = 2;

// The tenant-isolation boundary for every route touching household-owned
// data (User, Category, Transaction, MonthlyPlan).
// middleware.ts always sets this header itself from the verified session
// cookie for any request that reaches a non-public route — never a
// client-supplied value by the time a route handler sees it (same guarantee
// x-current-user-id already had). The null check here is defense-in-depth,
// not a normally-reachable path: middleware.ts's own auth gate means a
// route handler is never invoked without it for a protected path.
export function requireHouseholdId(req: NextRequest): number | null {
  const raw = req.headers.get('x-household-id');
  const id = raw ? Number(raw) : NaN;
  return Number.isFinite(id) && id > 0 ? id : null;
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
