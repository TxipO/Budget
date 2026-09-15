import { prisma } from '@/lib/prisma';
import { guessCategoryByMcc, guessCategoryByKeyword } from '@/lib/monobank';

// LLM guess tier — the natural extension point this project's own memory
// flagged when the free rule/MCC/keyword chain was built ("if they later
// want smarter guessing, adding a Claude call as a tier between MCC and
// keyword-match... is the natural extension point"). Reuses the same
// GROQ_API_KEY already provisioned for voice transcription (lib/voiceExtract.ts)
// — no new key, no new dependency. Deliberately the LAST tier before the
// safe fallback, not earlier: it's a network call with real (if small)
// latency/cost, so every free/instant tier gets first refusal. Best-effort
// like every sibling tier in this chain — any failure (no key, rate limit,
// bad JSON, no matching name) falls through to the safe fallback, never a
// crash and never blocks the write.
async function guessCategoryByLLM(merchantText: string, categoryNames: string[]): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || categoryNames.length === 0 || !merchantText.trim()) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // llama-3.3-70b-versatile was retired from Groq's catalog (404
        // "model_not_found") — silently broke this whole tier for an
        // unknown stretch of time, since every failure here falls through
        // to the next tier with no error surfaced anywhere. Found live
        // 2026-09-15 while investigating why obvious merchants (Vinmonopolet
        // — Norway's state alcohol monopoly) were landing in "Незрозуміло"
        // instead of reaching this tier's judgment at all. Replaced with
        // openai/gpt-oss-120b after comparing it live against gpt-oss-20b on
        // 5 real unclear merchants from this household's own data — 120b got
        // Vinmonopolet/Clas Ohlson right, 20b got both wrong. Re-verify
        // against Groq's current model list if this ever 404s again.
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: 'Ти визначаєш категорію особистого бюджету за описом банківської транзакції (назва мерчанта/отримувача — часто норвезькою, англійською чи обрізана/з кодами термінала). Поверни ЛИШЕ JSON: {"category": рядок або null}. "category" МАЄ бути точно одним із наданих варіантів, символ у символ, або null якщо жоден явно не підходить. Не вигадуй нову назву. Обирай null частіше, ніж здається правильним, якщо є хоч якийсь сумнів — краще не вгадувати, ніж вгадати неправильно.',
          },
          { role: 'user', content: `Категорії: ${categoryNames.join(', ')}\n\nОпис транзакції: "${merchantText}"` },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content);
    return typeof parsed?.category === 'string' && categoryNames.includes(parsed.category) ? parsed.category : null;
  } catch {
    return null;
  }
}

// Which tier of the chain below actually resolved a category — stored on
// Transaction.categorySource so a silent tier death (see this function's own
// LLM-tier incident, 2026-09-15) shows up as a measurable gap instead of
// nothing but the eventual "everything piles into Незрозуміло" symptom.
export type CategorySource = 'rule' | 'brand' | 'mcc' | 'keyword' | 'llm' | 'self-named' | 'fallback';

// Ф1b (classification overhaul, 2026-09-15) — reuses the user's OWN learned
// rules under a derived "brand" key (just the first word of the normalized
// merchantKey) when the exact key has no rule. Catches "same chain,
// different branch" — "joker balestrand" and "joker kyrkjeboe" are
// different EXACT merchantKeys (a location suffix makes one store's rule
// structurally unable to help at another branch of the same chain) but
// obviously the same brand. Deliberately does NOT touch how merchantKey
// itself is computed or matched (see normalizeMerchantKey's own "refine
// only if it actually fragments" comment, and the entry_reference saga this
// project already paid for once by normalizing a key too aggressively) —
// this is a separate, additional, lower-confidence signal, tried only after
// the exact key has already failed.
//
// Conservative on purpose: only fires when EVERY rule this user has already
// taught for that same first word agrees on one category. If a household
// uses one chain for two genuinely different real purposes (rare, but
// real — e.g. a gas-station brand that also sells groceries), this stays
// silent rather than guess wrong; the next tier gets a turn instead.
async function guessCategoryByBrand(userId: number, merchantKey: string): Promise<number | null> {
  const brand = merchantKey.split(' ')[0];
  // Length guard — a short first "word" ("nr", "kr", a lone digit) is far
  // more likely to coincidentally prefix-match something unrelated than to
  // mean anything as a brand.
  if (brand.length < 3) return null;
  const candidates = await prisma.monoCategoryRule.findMany({
    where: { userId, merchantKey: { startsWith: brand } }, // cheap DB-side prefilter
    select: { merchantKey: true, categoryId: true, category: { select: { isActive: true } } },
  });
  // The DB prefilter is a raw string startsWith, which would also match an
  // unrelated key that merely happens to start with the same characters
  // (e.g. brand "joker" prefix-matching a hypothetical "jokerapp ...") —
  // the real check is that the candidate's OWN first word equals brand
  // exactly, same word-boundary rule "joker balestrand" was built to need.
  const matches = candidates.filter(c => c.category.isActive && c.merchantKey.split(' ')[0] === brand);
  const categoryIds = new Set(matches.map(m => m.categoryId));
  return categoryIds.size === 1 ? matches[0].categoryId : null;
}

// Extracted out of the Monobank webhook route (was resolveCategoryId there) —
// voice-logged transactions need the exact same rule → MCC → keyword →
// fallback tiers, just called with mcc: undefined (a voice transcript has no
// MCC, only free text). Two callers now; sharing this instead of duplicating
// it is the fix for the "same concept, two independent implementations" bug
// class this project's /fullreview already watches for.
export async function guessCategoryId(householdId: number, userId: number, txType: 'expense' | 'income', merchantKey: string, mcc: number | undefined): Promise<{ categoryId: number; source: CategorySource }> {
  // 1. Learned rule from a manual correction — highest priority, no guessing.
  // Checked against the category's current isActive, not just that the rule
  // exists — a category can be soft-deleted after a rule was learned against
  // it (e.g. household cleanup in Settings), and filing new transactions
  // under an inactive category makes them invisible to category-filtered
  // pickers even though they still count in stats. Falls through to the
  // normal guess tiers (which already filter isActive) instead. Found
  // during deep-review 2026-07-11.
  const rule = await prisma.monoCategoryRule.findUnique({
    where: { userId_merchantKey: { userId, merchantKey } },
    select: { categoryId: true, category: { select: { isActive: true } } },
  });
  if (rule?.category.isActive) return { categoryId: rule.categoryId, source: 'rule' };

  // 1b. Brand-key guess — see guessCategoryByBrand's own comment. Still part
  // of the "rule" family (reuses only this user's own taught corrections,
  // nothing generic), so it stays right after the exact rule and before
  // MCC/keyword/LLM — a derived signal from the user's own history beats a
  // generic ISO code or global keyword list.
  const brandGuess = await guessCategoryByBrand(userId, merchantKey);
  if (brandGuess !== null) return { categoryId: brandGuess, source: 'brand' };

  // Tiers 2-6 (MCC guess, keyword guess, LLM guess, safe fallback, last
  // resort) are all just "find an active category of this type by name"
  // against the same set — one query instead of up to five separate
  // round-trips. householdId scoped so one household's voice/Monobank/
  // sparebank transactions never resolve to another household's category ids.
  const categories = await prisma.category.findMany({ where: { householdId, type: txType, isActive: true }, orderBy: { id: 'asc' } });
  const idByName = new Map(categories.map(c => [c.name, c.id]));

  // 2. MCC guess — free, no external call (standard ISO 18245 codes). Skipped
  // entirely when mcc is undefined (voice transcripts have none).
  const mccGuess = guessCategoryByMcc(mcc);
  if (mccGuess && idByName.has(mccGuess)) return { categoryId: idByName.get(mccGuess)!, source: 'mcc' };

  // 3. Keyword guess — also free. Works against a merchant description
  // (Monobank) or a voice transcript (voice logging) equally well.
  const keywordGuess = guessCategoryByKeyword(merchantKey);
  if (keywordGuess && idByName.has(keywordGuess)) return { categoryId: idByName.get(keywordGuess)!, source: 'keyword' };

  // 4. LLM guess — only reached once every free/instant tier above has
  // already refused. Handles merchant text no keyword list will ever fully
  // cover (foreign-language stores, one-off purchases, truncated terminal
  // codes) without hardcoding an ever-growing list of brand names.
  const llmGuess = await guessCategoryByLLM(merchantKey, categories.map(c => c.name));
  if (llmGuess && idByName.has(llmGuess)) return { categoryId: idByName.get(llmGuess)!, source: 'llm' };

  // 5. Self-named category — for unclear INCOME only, if the household has
  // a category literally named after the account that actually received
  // the money (e.g. "Женя"/"Паша", each person's own personal-income
  // bucket), prefer that over the generic fallback below. Replaces a
  // hardcoded keyword rule that used to blanket-file every Monobank "Від:
  // X" transfer under a fixed name regardless of whose account it landed
  // on — correct back when only one household member had Monobank
  // connected, silently wrong the moment a second one did (confirmed live
  // 2026-08-17: three of Женя's own incoming transfers filed under
  // "Паша", including a recurring self top-up from her Norwegian card).
  // Attributing unclear income to whoever actually received it is the
  // principled version of what that rule was trying to do.
  if (txType === 'income') {
    const owner = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    if (owner?.name && idByName.has(owner.name)) return { categoryId: idByName.get(owner.name)!, source: 'self-named' };
  }

  // 6. Safe fallback — a bucket that always exists for the type.
  const fallbackName = txType === 'expense' ? 'Незрозуміло' : 'Додаткове';
  if (idByName.has(fallbackName)) return { categoryId: idByName.get(fallbackName)!, source: 'fallback' };

  // 7. Absolute last resort — any active category of the right type, so a
  // write never crashes even if the expected fallback category was renamed
  // or deleted.
  if (categories[0]) return { categoryId: categories[0].id, source: 'fallback' };
  throw new Error(`No active ${txType} category exists to file a transaction under`);
}
