import { NextResponse } from 'next/server';

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function isPositiveNumber(val: unknown): val is number {
  return typeof val === 'number' && isFinite(val) && val > 0;
}

export function isNonNegativeNumber(val: unknown): val is number {
  return typeof val === 'number' && isFinite(val) && val >= 0;
}

export function isPositiveInt(val: unknown): val is number {
  return Number.isInteger(val) && (val as number) > 0;
}

export function isValidDate(val: unknown): boolean {
  if (!val || typeof val !== 'string') return false;
  const d = new Date(val);
  return !isNaN(d.getTime());
}

export function isValidType(val: unknown): val is 'income' | 'expense' | 'savings' {
  return val === 'income' || val === 'expense' || val === 'savings';
}

export function isValidYear(val: unknown): val is number {
  return Number.isInteger(val) && (val as number) >= 2000 && (val as number) <= 2100;
}

export function isValidMonth(val: unknown): val is number {
  return Number.isInteger(val) && (val as number) >= 1 && (val as number) <= 12;
}

// Schema stores money as Float (Postgres double precision), so binary
// floating-point drift is still possible. Round to 2 decimals at every
// write boundary instead. Never store an unrounded float.
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

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
