// Single source of truth for the "Планування" sheet's multi-year column
// layout — shared by api/export/route.ts (writes it) and api/import/route.ts
// (reads it back). Extracted 2026-08-30 (/fullreview deep) after finding
// import/route.ts had its OWN hardcoded YEAR_COL=5/MONTHS=12 loop that only
// ever read the FIRST year block (2026) and silently ignored every later
// year's columns — a re-import of a real multi-year-edited export would
// discard 2027+ figures with no error. Two independent implementations of
// "which column is month M of year Y" is exactly the bug class this
// project's own /fullreview watches for (Stage 2 point 8) — this file is
// the fix, not a patched second copy.
//
// 2026: cols E-Q (indices 5-17), 2027: S-AE (19-31), etc. — 14-column step,
// 12 month columns + a 13th sum column per year block.
export const PLANNING_YEARS = [2026, 2027, 2028, 2029, 2030];

export function planningMonthCol(year: number, month: number): number {
  return 5 + (year - 2026) * 14 + (month - 1); // 1-based col index
}
export function planningSumCol(year: number): number {
  return 5 + (year - 2026) * 14 + 12; // 13th col in block (sum)
}
