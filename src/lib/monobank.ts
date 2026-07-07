import { prisma } from '@/lib/prisma';

const BASE = 'https://api.monobank.ua';

export class MonobankError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'X-Token': token, ...(init?.headers ?? {}) },
  });
  if (res.status === 429) {
    throw new MonobankError('Забагато запитів до Monobank — спробуйте за хвилину', 429);
  }
  if (res.status === 403) {
    throw new MonobankError('Невалідний токен Monobank', 403);
  }
  if (!res.ok) {
    throw new MonobankError(`Monobank API помилка: ${res.status}`, res.status);
  }
  return res.json();
}

export interface MonoAccount {
  id: string;
  currencyCode: number; // ISO 4217 numeric, 980 = UAH
  type: string;         // 'black' | 'white' | 'platinum' | 'iron' | 'fop' | ...
  balance: number;      // kopecks
}

export interface MonoClientInfo {
  clientId: string;
  name: string;
  accounts: MonoAccount[];
}

export function getClientInfo(token: string): Promise<MonoClientInfo> {
  return call('/personal/client-info', token);
}

// Registers (or replaces) the webhook URL Monobank pushes new-transaction
// events to. Calling this again with a new URL overwrites the previous one —
// there's no separate "unregister"; disconnect.ts points it at a dead value.
export function setWebhook(token: string, webHookUrl: string): Promise<{ status: string }> {
  return call('/personal/webhook', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webHookUrl }),
  });
}

// Public endpoint, no token needed. Used to convert UAH statement amounts to
// the app's own currency (kr / NOK) at import time.
export async function getExchangeRate(fromCcy: number, toCcy: number): Promise<number | null> {
  const res = await fetch(`${BASE}/bank/currency`);
  if (!res.ok) return null;
  const rates: { currencyCodeA: number; currencyCodeB: number; rateCross?: number; rateBuy?: number; rateSell?: number }[] = await res.json();
  const direct = rates.find(r => r.currencyCodeA === fromCcy && r.currencyCodeB === toCcy);
  if (direct) return direct.rateCross ?? direct.rateBuy ?? direct.rateSell ?? null;
  const inverse = rates.find(r => r.currencyCodeA === toCcy && r.currencyCodeB === fromCcy);
  const inverseRate = inverse?.rateCross ?? inverse?.rateBuy ?? inverse?.rateSell;
  return inverseRate ? 1 / inverseRate : null;
}

export const ISO_4217 = { UAH: 980, NOK: 578 };
const FX_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Monobank's currency endpoint has no auth but is still a live network call
// on every webhook delivery if uncached — cache in AppSetting (already used
// for the PIN hash and auth lockout) keyed by currency pair, refreshed at
// most once an hour. A stale-by-an-hour FX rate is an acceptable trade for
// not hitting an external API on every single imported transaction.
export async function getCachedExchangeRate(fromCcy: number, toCcy: number): Promise<number | null> {
  const key = `fxRate:${fromCcy}:${toCcy}`;
  const cached = await prisma.appSetting.findUnique({ where: { key } });
  if (cached) {
    const parsed = JSON.parse(cached.value) as { rate: number; fetchedAt: number };
    if (Date.now() - parsed.fetchedAt < FX_CACHE_MAX_AGE_MS) return parsed.rate;
  }
  const rate = await getExchangeRate(fromCcy, toCcy);
  if (rate === null) return cached ? (JSON.parse(cached.value) as { rate: number }).rate : null; // serve stale rather than fail the import
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: JSON.stringify({ rate, fetchedAt: Date.now() }) },
    create: { key, value: JSON.stringify({ rate, fetchedAt: Date.now() }) },
  });
  return rate;
}

// First-pass category guess from the merchant category code Monobank already
// sends in the webhook payload — free, no network call. Deliberately small
// and only the unambiguous codes; Ф4 adds a Claude call as the real fallback
// for everything else, this just shortcuts the obvious ones.
const MCC_CATEGORY: Record<number, string> = {
  5411: 'Їжа',       // grocery stores/supermarkets
  5812: 'Їжа',       // restaurants
  5814: 'Їжа',       // fast food
  5912: 'Медицина',  // pharmacies
  4900: 'Комунальні', // utilities
};

export function guessCategoryByMcc(mcc: number | undefined): string | null {
  return mcc ? MCC_CATEGORY[mcc] ?? null : null;
}

// Consciously simple in v1 (lowercase + trim + collapse whitespace) — the
// same merchant can appear with slightly different formatting across
// transactions (extra spaces, trailing terminal IDs); refine only if that
// turns out to actually fragment MonoCategoryRule matches in practice.
export function normalizeMerchantKey(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, ' ');
}
