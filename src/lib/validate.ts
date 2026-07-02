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

// SQLite has no true DECIMAL type (NUMERIC affinity stores fractions as
// binary REAL), so money is kept exact by rounding to 2 decimals at every
// write boundary instead. Never store an unrounded float.
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
