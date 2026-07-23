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

// Monobank caps a single statement request to a 31-day span and rate-limits
// this endpoint to roughly 1 request per 60 seconds per token — fine for a
// manually-triggered reconciliation, not something to call on a timer.
export function getStatement(token: string, accountId: string, fromUnixSec: number, toUnixSec: number) {
  return call(`/personal/statement/${accountId}/${fromUnixSec}/${toUnixSec}`, token);
}

export const ISO_4217 = { UAH: 980, NOK: 578, USD: 840 };

// Public endpoint, no token needed. Used to convert a card purchase's own
// currency to the app's currency (kr / NOK) at import time.
export async function getExchangeRate(fromCcy: number, toCcy: number): Promise<number | null> {
  const res = await fetch(`${BASE}/bank/currency`);
  if (!res.ok) return null;
  const rates: { currencyCodeA: number; currencyCodeB: number; rateCross?: number; rateBuy?: number; rateSell?: number }[] = await res.json();

  function directOrInverse(a: number, b: number): number | null {
    const direct = rates.find(r => r.currencyCodeA === a && r.currencyCodeB === b);
    if (direct) return direct.rateCross ?? direct.rateBuy ?? direct.rateSell ?? null;
    const inverse = rates.find(r => r.currencyCodeA === b && r.currencyCodeB === a);
    const inverseRate = inverse?.rateCross ?? inverse?.rateBuy ?? inverse?.rateSell;
    return inverseRate ? 1 / inverseRate : null;
  }

  const direct = directOrInverse(fromCcy, toCcy);
  if (direct !== null) return direct;

  // Monobank's feed is UAH-centric — every currency pairs against UAH, but
  // two foreign currencies rarely pair with each other directly. Confirmed
  // live 2026-07-23: no USD<->NOK pair exists at all, despite both having
  // their own UAH pair (USD/UAH rateBuy/rateSell, NOK/UAH rateCross) — a real
  // foreign-currency card purchase (a USD-billed subscription) threw "No
  // exchange rate available" and 500'd the whole sync, silently never
  // recording that transaction via either the webhook or the sync safety
  // net. Triangulate through UAH whenever neither side already is UAH.
  if (fromCcy !== ISO_4217.UAH && toCcy !== ISO_4217.UAH) {
    const fromToUah = directOrInverse(fromCcy, ISO_4217.UAH);
    const toToUah = directOrInverse(toCcy, ISO_4217.UAH);
    if (fromToUah !== null && toToUah !== null && toToUah !== 0) return fromToUah / toToUah;
  }

  return null;
}
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
  // Їжа — grocery/food stores only (buying ingredients to cook at home)
  5411: 'Їжа', 5412: 'Їжа', 5422: 'Їжа', 5441: 'Їжа', 5451: 'Їжа',
  5462: 'Їжа', 5499: 'Їжа',
  // Балування — eating out (restaurants, bars, fast food, caterers), not
  // groceries. Was lumped into Їжа; moved out on request since "went to a
  // restaurant" and "bought groceries" are different budget categories.
  5811: 'Балування', 5812: 'Балування', 5813: 'Балування', 5814: 'Балування',
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
// Monobank rows: merchant/store names only, real generic category words
// ("продукти", "їжа") essentially never appear in a bank statement
// description. Voice-logged rows: the sender may say the category out loud
// instead of (or as well as) a merchant name — the generic-word additions
// below (укр/рос/eng) exist for that caller and are safe for Monobank too,
// since they're not realistic merchant-name substrings.
const KEYWORD_CATEGORY: [RegExp, string][] = [
  // Monobank's own format for an incoming P2P transfer is always "Від: <ім'я
  // відправника>" — deliberately matched on this prefix, not any particular
  // sender's name, since the sender varies month to month (different people
  // sending money, not a recurring counterparty). Filed under Паша because
  // this is specifically the household's Monobank-connected account; if
  // Женя's card is ever connected too, this would need to stop being a
  // blanket rule.
  [/^від: /i, 'Паша'],
  // apotek/legekontor/tannlege added 2026-07-22 — real Norwegian merchant
  // names from SpareBank 1's first sync (BALESTRAND LEGEKONTOR, SUNNFJORD
  // APOTE..., TANNLEGANE CLEM...), the Enable Banking integration's own
  // equivalent of the аптек/pharmacy tier below.
  // apotek?/tannleg (not "apotek"/"tannlege") deliberately loose — real
  // Norwegian card statements truncate to "APOTE" and inflect to
  // "TANNLEGANE" (definite plural), neither of which contains the
  // dictionary-form word as a literal substring. Confirmed against real
  // SpareBank 1 data (SUNNFJORD APOTE..., TANNLEGANE CLEM...).
  [/аптек|pharmacy|фармаці|ліки|лекарств|medicine|apotek?|legekontor|tannleg/i, 'Медицина'],
  // "їжа"/"еда" are Ukrainian/Russian nouns with grammatical case endings
  // (їжа/їжу/їжі/їжею, еда/еды/еде/едой) — a bare "їжа" substring match
  // missed "Потратив 200 крон на їжу" entirely, since "їжу" (accusative)
  // doesn't contain "їжа" as a substring. Same bug class as the earlier
  // exact-verb-form fix in voiceParse.ts, just in the category keywords.
  // joker/coop/kiwi added 2026-07-22 — the three grocery chains that
  // covered the bulk (>60 of 170) of SpareBank 1's first sync landing in
  // "Незрозуміло": Norwegian grocery brands, no overlap with the Ukrainian
  // chains above. Word-bounded since "coop"/"kiwi" are short common words.
  [/сільпо|silpo|атб|фора|ашан|novus|варус|ваш ?формат|вест ?лайн|кошик|продукт|їж(а|і|у|ею)|ед(а|ы|е|у|ой)|food|groceries|grocery|\bjoker\b|\bcoop\b|\bkiwi\b/i, 'Їжа'],
  // Eating out, not groceries — restaurants/cafes/bars/fast food.
  [/ресторан|restaurant|кафе|cafe|café|бар\b|bar\b|паб|pub\b|суші|sushi|піцер|pizza|kebab|кебаб|grill|гриль|бургер|burger|кав'?ярн|coffee ?shop|кофейн/i, 'Балування'],
  [/netflix|spotify|youtube ?premium|apple\.com\/bill|google ?(play|one)|playstation|xbox|patreon|подпис|підписк/i, 'Підписки'],
  [/coursera|udemy|prometheus|школа|курси|university|college|навчанн|учеба|education|study/i, 'Навчання'],
  [/vape|вейп|сигарет|tobacco|casino|казино|bet|parimatch|букмекер/i, 'Залежності'],
  [/квіти|flowers|подарун|подарок|gift/i, 'Подарунки'],
  [/zara|h&m|lc waikiki|epicentr|епіцентр|leroy merlin|ikea|одяг|взуття|одежда|clothes|clothing/i, 'Домашній хлам/одяг/etc'],
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
