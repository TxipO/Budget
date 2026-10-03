// A savings-type transaction can be a deposit (money set aside — the ONLY
// meaning "savings" had before withdrawals were tracked, still the default)
// or a withdrawal (money coming back out of the pot into general spending
// money). Every place that sums "savings" must use this, not the bare
// amount column, or a withdrawal double-counts as an extra deduction on top
// of the deposit that put the money there in the first place — found live
// 2026-07-27 when a bank-learned category rule filed both directions of an
// internal transfer under the same savings category with no distinction.
export function savingsAmount(t: { amount: number; savingsWithdrawal: boolean }): number {
  return t.savingsWithdrawal ? -t.amount : t.amount;
}

// A transaction between two of the SAME person's own bank accounts (see
// SparebankAccount, lib/sparebankIngest.ts's detection) is not income, an
// expense, or new savings — the money didn't appear or disappear, it just
// moved. Every budget sum (stats.ts, analytics.ts) must exclude it entirely,
// regardless of what category.type it happens to be filed under. Found live
// 2026-07-31: a transfer INTO checking from a "pillow" savings account was
// filed as a savings category, whose type-based summing counted it as new
// money either way it was signed — an internal transfer needs to be excluded
// outright, not just correctly signed within one bucket.
//
// category.type === 'transfer' is a SECOND, independent path to the same
// exclusion — not redundant with isTransfer. Found live 2026-08-24: a pair
// of same-bank Monobank transfer legs (#938/#939) landed in the "Перекази"
// category via a learned MonoCategoryRule, but findMonoTransferMatch's
// exact-amount check missed the pair (each leg's UAH->NOK conversion hit a
// different 1h-TTL exchange-rate cache snapshot, 0.05% apart) — so isTransfer
// stayed false while the category already said "this is a transfer". Category
// type is the one place a manual re-categorization (or a learned rule) can
// assert "not budget activity" even when the automatic matcher's own
// isTransfer flag didn't fire, so both must be checked, not just one.
export function isBudgetRelevant(t: { isTransfer: boolean; category: { type: string } }): boolean {
  return !t.isTransfer && t.category.type !== 'transfer';
}

export function isCurrentMonth(year: number, month1: number, now: Date): boolean {
  return year === now.getUTCFullYear() && month1 === now.getUTCMonth() + 1;
}

// Inclusive last day-of-month to include when comparing the in-progress
// current month against an earlier month: a 3-day October against all of
// September always reads as a huge swing (found live 2026-10-03: "−100% до
// вересня"), so the earlier month is clipped to the same day-of-month.
export function comparableCutoffDay(prevYear: number, prevMonth1: number, now: Date): number {
  const daysInPrev = new Date(Date.UTC(prevYear, prevMonth1, 0)).getUTCDate();
  return Math.min(now.getUTCDate(), daysInPrev);
}
