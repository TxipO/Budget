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
const byNumeric = new Map(CURRENCIES.map(c => [c.numeric, c]));

// Never throws on an unknown code (a stale/corrupted value should degrade to
// the historical NOK behavior, not break every page that formats money).
export function getCurrencyInfo(code: string | undefined | null): CurrencyInfo {
  return (code && byCode.get(code)) || byCode.get(DEFAULT_CODE)!;
}

export function numericForCurrency(code: string): number {
  return getCurrencyInfo(code).numeric;
}

export function currencyForNumeric(numeric: number): string | null {
  return byNumeric.get(numeric)?.code ?? null;
}

export function formatMoney(amount: number, currencyCode: string = DEFAULT_CODE): string {
  const info = getCurrencyInfo(currencyCode);
  return new Intl.NumberFormat(info.locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(amount)) + ' ' + info.suffix;
}

export function formatMoneySign(amount: number, currencyCode: string = DEFAULT_CODE): string {
  const info = getCurrencyInfo(currencyCode);
  const abs = new Intl.NumberFormat(info.locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.abs(amount));
  return (amount >= 0 ? '+' : '-') + abs + ' ' + info.suffix;
}
