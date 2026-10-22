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

// Strict calendar date: YYYY-MM-DD, or a full ISO datetime (no timezone = UTC,
// never server-local). Round-trips the calendar day, so 2026-02-30 is rejected
// instead of silently rolling into March. Returns the parsed instant.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
export function parseDate(val: unknown): Date | null {
  if (typeof val !== 'string') return null;
  const m = ISO_DATE_RE.exec(val);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  if (m[4] === undefined) return day;
  if (+m[4] > 23 || +m[5] > 59 || +(m[6] ?? 0) > 59) return null;
  const out = new Date(m[7] ? val : val + 'Z');
  return isNaN(out.getTime()) ? null : out;
}

export function isValidDate(val: unknown): boolean {
  return parseDate(val) !== null;
}

// Parse a client-supplied money amount ONCE and use the returned value for
// the write: a number or a plain decimal string only (no hex/exponent/boolean/
// array coercion), finite, <= MAX_AMOUNT, rounded to cents and > 0 (so
// 0.004 / 1e-7 are rejected rather than stored as 0). allowZero for plans.
const MAX_AMOUNT = 1e9;
export function parseAmount(val: unknown, allowZero = false): number | null {
  if (typeof val === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(val)) return null;
  if (typeof val !== 'number' && typeof val !== 'string') return null;
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null;
  const r = roundMoney(n);
  return r > 0 || (allowZero && r === 0) ? r : null;
}

// Parse a client-supplied row id (integer, or a string of digits) ONCE and
// use that value for both the ownership check and the write — Number('1e2')
// would pass a check as 100 while parseInt('1e2') stores 1. Postgres Int cap.
export function parseId(val: unknown): number | null {
  const n = typeof val === 'string' ? (/^\d{1,10}$/.test(val) ? Number(val) : NaN) : val;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

export function isValidType(val: unknown): val is 'income' | 'expense' | 'savings' | 'transfer' {
  return val === 'income' || val === 'expense' || val === 'savings' || val === 'transfer';
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

// Client pages can't import this file (next/server) — the rules live in
// budgetRules.ts; re-exported so server call sites keep working.
export { savingsAmount, isBudgetRelevant } from './budgetRules';
