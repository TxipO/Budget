// Session revocation predicate — pure (no imports) so scripts/check-session-
// revocation.mts can run it. The session cookie is stateless and signed, so
// "log out everywhere" works by stamping Household/User.sessionsValidAfter and
// rejecting any cookie issued before that instant (lib/household.ts applies it
// to every authenticated API route).
//
// user: 'shared' = PIN session with no identity (only the household stamp
// applies); null = the session's user row no longer exists (deleted) -> dead;
// otherwise the user's own stamp (null = never revoked). A stamp equal to
// issuedAt does NOT revoke, so a cookie re-issued in the same ms as the stamp
// (the "stay logged in on this device" flow) survives.
export function isSessionRevoked(
  issuedAt: number,
  householdValidAfter: number | null,
  user: 'shared' | null | { validAfter: number | null },
): boolean {
  if (householdValidAfter !== null && issuedAt < householdValidAfter) return true;
  if (user === 'shared') return false;
  if (user === null) return true;
  return user.validAfter !== null && issuedAt < user.validAfter;
}
