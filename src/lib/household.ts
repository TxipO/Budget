import { NextRequest } from 'next/server';

// The tenant-isolation boundary for every route touching household-owned
// data (User, Category, Transaction, RecurringTemplate, MonthlyPlan).
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
