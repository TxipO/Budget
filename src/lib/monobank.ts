import { prisma } from '@/lib/prisma';

const BASE = 'https://api.monobank.ua';

// The webhook URL we hand to Monobank must NOT be built from req.nextUrl.origin
// (or any Host/X-Forwarded-Host-derived value) — those reflect whatever the
// caller's HTTP client sent and aren't guaranteed to match the real deployment
// domain. An authenticated session tricked into calling /api/monobank/connect
// with a spoofed Host header could register the webhook against an
// attacker-controlled domain, leaking every future transaction (merchant,
// amount, category) to it indefinitely. Vercel's own system env vars are
// injected at the platform level, not derived from any request, so they
// can't be spoofed the same way.
export function getAppOrigin(): string {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000'; // local dev only — Monobank can't reach this regardless
}

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
// sends in the webhook payload — free, no network call, no external API.
// Standard ISO 18245 MCC codes mapped to whatever this app's own category
// names happen to be; only codes with an unambiguous, confident match to an
// existing category are included — an uncertain guess is worse than none
// (it falls through to keyword matching, then the safe fallback instead).
const MCC_CATEGORY: Record<number, string> = {
  // Їжа
  5411: 'Їжа', 5412: 'Їжа', 5422: 'Їжа', 5441: 'Їжа', 5451: 'Їжа',
  5462: 'Їжа', 5499: 'Їжа', 5812: 'Їжа', 5813: 'Їжа', 5814: 'Їжа',
  // Медицина
  5912: 'Медицина', 8011: 'Медицина', 8021: 'Медицина', 8031: 'Медицина',
  8042: 'Медицина', 8049: 'Медицина', 8062: 'Медицина', 8071: 'Медицина', 8099: 'Медицина',
  // Комунальні
  4900: 'Комунальні', 4814: 'Комунальні',
  // Домашній хлам/одяг/etc
  5200: 'Домашній хлам/одяг/etc', 5211: 'Домашній хлам/одяг/etc', 5251: 'Домашній хлам/одяг/etc',
  5399: 'Домашній хлам/одяг/etc', 5651: 'Домашній хлам/одяг/etc', 5661: 'Домашній хлам/одяг/etc',
  5697: 'Домашній хлам/одяг/etc', 5732: 'Домашній хлам/одяг/etc',
  // Підписки
  5815: 'Підписки', 5968: 'Підписки', 4899: 'Підписки',
  // Навчання
  8211: 'Навчання', 8220: 'Навчання', 8241: 'Навчання', 8244: 'Навчання',
  8249: 'Навчання', 8299: 'Навчання',
  // Кредит
  6012: 'Кредит', 6051: 'Кредит',
  // Залежності (алкоголь/тютюн/азартні ігри)
  5921: 'Залежності', 5993: 'Залежності', 7995: 'Залежності',
  // Подарунки
  5947: 'Подарунки', 5992: 'Подарунки',
};

export function guessCategoryByMcc(mcc: number | undefined): string | null {
  return mcc ? MCC_CATEGORY[mcc] ?? null : null;
}

// Second-pass free guess: substring match against the merchant description
// Monobank sends. Deliberately conservative — only patterns that map
// confidently onto an EXISTING category name, grounded in common Ukrainian
// merchant naming (grocery chains, pharmacy chains, well-known subscription
// services). An unmatched merchant falls through to the safe fallback
// rather than getting a low-confidence guess.
const KEYWORD_CATEGORY: [RegExp, string][] = [
  [/аптек|pharmacy|фармаці/i, 'Медицина'],
  [/сільпо|silpo|атб|фора|ашан|novus|варус|ваш ?формат|вест ?лайн|кошик/i, 'Їжа'],
  [/netflix|spotify|youtube ?premium|apple\.com\/bill|google ?(play|one)|playstation|xbox|patreon|подпис|підписк/i, 'Підписки'],
  [/coursera|udemy|prometheus|школа|курси|university|college|навчанн/i, 'Навчання'],
  [/vape|вейп|сигарет|tobacco|casino|казино|bet|parimatch|букмекер/i, 'Залежності'],
  [/квіти|flowers|подарун|gift/i, 'Подарунки'],
  [/zara|h&m|lc waikiki|epicentr|епіцентр|leroy merlin|ikea|одяг|взуття/i, 'Домашній хлам/одяг/etc'],
];

export function guessCategoryByKeyword(description: string): string | null {
  const text = description.toLowerCase();
  for (const [pattern, category] of KEYWORD_CATEGORY) {
    if (pattern.test(text)) return category;
  }
  return null;
}

// Consciously simple in v1 (lowercase + trim + collapse whitespace) — the
// same merchant can appear with slightly different formatting across
// transactions (extra spaces, trailing terminal IDs); refine only if that
// turns out to actually fragment MonoCategoryRule matches in practice.
export function normalizeMerchantKey(description: string): string {
  return description.trim().toLowerCase().replace(/\s+/g, ' ');
}
