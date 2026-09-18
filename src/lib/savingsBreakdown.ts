import { savingsAmount, isBudgetRelevant } from '@/lib/validate';

export interface SavingsCategoryBalance { name: string; color: string; icon: string; balance: number }

// Running balance PER savings category — "скільки лежить у подушці, скільки
// в Dual Invest" is a running-total question, not a this-period-flow one,
// so callers must pass an ALL-TIME (or as-of-some-cutoff-date) transaction
// set, never one scoped to a single month/quarter — the aggregate
// "Збереження" stat card already covers the flow question, this covers the
// balance one. Found live 2026-09-18: the only savings number anywhere in
// the UI was one combined total across every pool, DB-only otherwise.
//
// Shared between analytics.ts (small footnote next to "Всього збереження")
// and any future caller — one implementation, not two that can drift, same
// reasoning guessCategoryId's own extraction comment gives.
//
// Same sign convention as savingsAmount() itself (a deposit grows the pool,
// a withdrawal shrinks it) — POSITIVE here, unlike a cumulative free-balance
// calculation that SUBTRACTS savings (money going into savings reduces free
// cash; this is the pool's own balance, the opposite side of that same
// movement).
export function computeSavingsByCategory(
  txs: { categoryId: number; amount: number; savingsWithdrawal: boolean; isTransfer: boolean; category: { name: string; color: string; icon: string; type: string } }[],
): SavingsCategoryBalance[] {
  const byCategory: Record<number, SavingsCategoryBalance> = {};
  for (const t of txs) {
    if (!isBudgetRelevant(t) || t.category.type !== 'savings') continue;
    if (!byCategory[t.categoryId]) {
      byCategory[t.categoryId] = { name: t.category.name, color: t.category.color, icon: t.category.icon, balance: 0 };
    }
    byCategory[t.categoryId].balance += savingsAmount(t);
  }
  return Object.values(byCategory).sort((a, b) => b.balance - a.balance);
}
