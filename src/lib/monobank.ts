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
