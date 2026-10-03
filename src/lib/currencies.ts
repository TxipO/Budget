// Household-facing currency metadata — the single source of truth for the
// onboarding currency picker, all money display (formatMoney/formatMoneySign),
// and the numeric ISO 4217 code Monobank ingestion converts TOWARD. Kept
// separate from lib/monobank.ts's own ISO_4217/MONO_CCY_NAMES (that pair
// exists for a narrower job — the UAH-pivot triangulation logic and raw
// statement-currency display — and was already fixed/verified for USD/EUR/PLN
// the same day this file was added; no reason to touch working code to
// "unify" two tables that serve different callers).
export interface CurrencyInfo {
  code: string;      // ISO 4217 alpha — what's stored on Household.currency
  numeric: number;   // ISO 4217 numeric — what Monobank's API speaks
  suffix: string;    // shown after the formatted amount, e.g. "123 kr"
  locale: string;    // Intl.NumberFormat locale, chosen for a native-feeling grouping style
  name: string;      // Ukrainian display name for the onboarding picker
  spokenUk: string;  // genitive-plural Ukrainian form for voice-prompt biasing, e.g. "200 крон"
  spokenEn: string;  // English plural form for the same, e.g. "kroner"
}

export const CURRENCIES: CurrencyInfo[] = [
  { code: 'NOK', numeric: 578, suffix: 'kr', locale: 'nb-NO', name: 'Норвезька крона (NOK)',      spokenUk: 'крон',    spokenEn: 'kroner' },
  { code: 'EUR', numeric: 978, suffix: '€',  locale: 'de-DE', name: 'Євро (EUR)',                  spokenUk: 'євро',    spokenEn: 'euros' },
  { code: 'PLN', numeric: 985, suffix: 'zł', locale: 'pl-PL', name: 'Польський злотий (PLN)',      spokenUk: 'злотих',  spokenEn: 'zloty' },
  { code: 'USD', numeric: 840, suffix: '$',  locale: 'en-US', name: 'Долар США (USD)',             spokenUk: 'доларів', spokenEn: 'dollars' },
  { code: 'UAH', numeric: 980, suffix: '₴',  locale: 'uk-UA', name: 'Гривня (UAH)',                spokenUk: 'гривень', spokenEn: 'hryvnias' },
  { code: 'GBP', numeric: 826, suffix: '£',  locale: 'en-GB', name: 'Фунт стерлінгів (GBP)',       spokenUk: 'фунтів',  spokenEn: 'pounds' },
  { code: 'SEK', numeric: 752, suffix: 'kr', locale: 'sv-SE', name: 'Шведська крона (SEK)',        spokenUk: 'крон',    spokenEn: 'kronor' },
  { code: 'DKK', numeric: 208, suffix: 'kr', locale: 'da-DK', name: 'Данська крона (DKK)',         spokenUk: 'крон',    spokenEn: 'kroner' },
];

const DEFAULT_CODE = 'NOK'; // matches Household.currency's own schema default — existing households never see a behavior change

const byCode = new Map(CURRENCIES.map(c => [c.code, c]));

// Never throws on an unknown code (a stale/corrupted value should degrade to
// the historical NOK behavior, not break every page that formats money).
export function getCurrencyInfo(code: string | undefined | null): CurrencyInfo {
  return (code && byCode.get(code)) || byCode.get(DEFAULT_CODE)!;
}

export function numericForCurrency(code: string): number {
  return getCurrencyInfo(code).numeric;
}

// U+00A0 between number and suffix: with a plain space "kr" wrapped alone onto
// the next line in narrow cells (found 2026-10 mobile audit).
export function formatMoney(amount: number, currencyCode: string = DEFAULT_CODE): string {
  const info = getCurrencyInfo(currencyCode);
  return new Intl.NumberFormat(info.locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(amount)) + ' ' + info.suffix;
}

export function formatMoneySign(amount: number, currencyCode: string = DEFAULT_CODE): string {
  const info = getCurrencyInfo(currencyCode);
  const abs = new Intl.NumberFormat(info.locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(amount));
  // Zero after rounding carries no sign ("+0 kr" / "-0 kr" both read as a lie).
  const sign = Math.round(Math.abs(amount)) === 0 ? '' : amount > 0 ? '+' : '-';
  return sign + abs + ' ' + info.suffix;
}

// Short axis/cell label shared by planning, analytics and the charts: the
// exact number below 1000 ("300"), one decimal of thousands above ("2,5к",
// "9,8к", "10к"), "М" for millions. The old Math.round(n / 1000) + 'к' turned
// 300 into "0к" and a 9 800 axis into "0к 3к 5к 8к 10к".
// The value formatCompact(n) actually displays, as a number — lets callers
// compare "what the user sees" (e.g. over/under-plan colouring) so two cells
// that read the same never get different colours.
export function roundCompact(n: number): number {
  const a = Math.abs(n);
  const step = a < 999.5 ? 1 : a < 1e7 ? 100 : 1e5;
  return Math.round(n / step) * step;
}

export function formatCompact(n: number): string {
  const a = Math.abs(n);
  if (Math.round(a) === 0) return '0';
  const sign = n < 0 ? '-' : '';
  const trim = (x: number) => String(Math.round(x * 10) / 10).replace('.', ',');
  if (a < 999.5) return sign + Math.round(a);
  if (Math.round(a / 100) < 10000) return sign + trim(a / 1000) + 'к';
  return sign + trim(a / 1e6) + 'М';
}
