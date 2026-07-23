'use client';
import { useEffect, useState } from 'react';
import { formatMoney as formatMoneyFor, formatMoneySign as formatMoneySignFor } from '@/lib/currencies';

// Module-level, not React state at the module scope — shared across every
// component that calls useCurrency() on the same page load, so N components
// mounting simultaneously (e.g. the dashboard + Sidebar) share one fetch
// instead of firing N redundant requests. A full page navigation (which is
// what happens right after onboarding sets the currency for the first time,
// via `window.location.href = '/'`) naturally clears this by resetting the
// whole JS module state — no manual invalidation needed for that path.
let cachedCurrency: string | null = null;
let inFlight: Promise<string | null> | null = null;

function fetchCurrency(): Promise<string | null> {
  if (cachedCurrency) return Promise.resolve(cachedCurrency);
  if (inFlight) return inFlight;
  inFlight = fetch('/api/account/me')
    .then(r => r.ok ? r.json() : null)
    .then(data => { cachedCurrency = data?.currency ?? null; return cachedCurrency; })
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}

// Every existing formatMoney(x) call site keeps its exact single-argument
// shape — only one line (this hook call) is added per component, instead of
// threading a currency prop/context through ~22 call sites. Brief NOK
// default on first paint until the fetch resolves is an accepted tradeoff
// (matches this app's existing pattern of each component independently
// fetching account/me — see Sidebar.tsx, settings/page.tsx — not a new
// convention invented for this feature).
export function useCurrency() {
  const [currency, setCurrency] = useState<string>(cachedCurrency ?? 'NOK');
  useEffect(() => {
    let cancelled = false;
    fetchCurrency().then(c => { if (!cancelled && c) setCurrency(c); });
    return () => { cancelled = true; };
  }, []);
  return {
    currency,
    formatMoney: (amount: number) => formatMoneyFor(amount, currency),
    formatMoneySign: (amount: number) => formatMoneySignFor(amount, currency),
  };
}
