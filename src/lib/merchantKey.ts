// The ONE merchant-key normalizer — every place that computes or looks up a
// MonoCategoryRule.merchantKey (mono/sparebank/voice ingest, categoryGuess
// tier 1 + brand, sweep helpers, PUT rule learning, the migration scripts)
// goes through this. No imports on purpose: pure string logic, safe to load
// from scripts and tests without pulling prisma/next.
//
// History: v1 was only trim+lowercase+collapse-spaces ("refine only if it
// actually fragments"). 2026-10 audit of the 70 real rules found 9 that could
// never match again — they embedded volatile bank noise that differs on every
// occurrence: "Betalt: 11.09.26" payment dates on Nettgiro rows, store-number
// prefixes ("143300 COOP PRIX"), booking refs ("BALESTRAND HO BY93MGPZ",
// "AIRBNB * HM3AZXCQ5Z"), digits glued to a name ("96682762Stbar"). Each rule
// was keyed to one occurrence, so the very next visit to the same merchant
// produced a different key. Only tokens that are PROVABLY per-occurrence are
// stripped (see each step); anything that could be part of a merchant's real
// name or location (a 3-digit branch number, "kiwi 582") is left alone,
// because over-normalizing merges different merchants — the entry_reference
// saga this project already paid for once.

// Bare payment-type phrases: they name a KIND of payment, not who was paid, so
// a rule learned on them would recategorize every bill/transfer of that kind.
// A key that is empty or only one of these has "no merchant" — no rule
// lookup, no learning, no sweep. Specific keys that merely START with a phrase
// ("nettgiro til: sogndal kommune") name a payee and stay valid.
const GENERIC_KEY =
  /^(nettgiro( (til|fra):?)?|avtalegiro|efaktura|mobilgiro( m\/kid)?(,? forfall i dag)?|overførsel mellom egne konti( i mobilbank)?(,? forfall i dag)?|(til|fra|від|переказ|поповнення):?)$/;

function normalizeOnce(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  // "Betalt: 11.09.26" / any standalone dd.mm.yy(yy) stamp. The lookarounds
  // keep Norwegian account numbers ("3705.68.62367") from being read as dates.
  s = s.replace(/\s*betalt:\s*\d{1,2}[./]\d{1,2}[./]\d{2,4}/g, '');
  s = s.replace(/(?<![\d.])\d{1,2}\.\d{1,2}\.\d{2,4}(?![\d.])/g, '');
  // Amounts inside the text ("Виведення кешбеку 170.69₴").
  s = s.replace(/\d+(?:[.,]\d+)?\s*[₴$€]/g, '');
  // Leading store/terminal number ("143300 coop prix balestra").
  s = s.replace(/^\d{4,}\s+/, '');
  // Digit runs of 5+ (phone numbers, terminal/booking numbers, also when glued
  // to a word: "96682762stbar"). Norwegian account numbers (dddd.dd.ddddd) are
  // a payee identity, not noise — kept intact.
  s = s.replace(/\d{4}\.\d{2}\.\d{5}|\+?\d{5,}/g, m => (m.includes('.') ? m : ''));
  s = s.replace(/\s+/g, ' ').trim();
  // Trailing booking reference: one alphanumeric token, 6+ chars, with at
  // least 2 digits and 3 letters ("by93mgpz", "hm3azxcq5z"), after a merchant
  // name. Plain words, 1-4 digit branch numbers and "fjord1" never qualify.
  const parts = s.split(' ');
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^[a-z0-9]{6,}$/.test(last) && (last.match(/\d/g)?.length ?? 0) >= 2 && (last.match(/[a-z]/g)?.length ?? 0) >= 3) {
    parts.pop();
    s = parts.join(' ');
  }
  // The dangling separator left by "airbnb * <ref>".
  return s.replace(/\s*\*$/, '').trim();
}

export function merchantKey(raw: string | null | undefined): string {
  let s = raw ?? '';
  // Fixed point, so the function is idempotent (a caller may normalize a text
  // that was already normalized, e.g. guessCategoryId given a ready key).
  for (let i = 0; i < 5; i++) {
    const next = normalizeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
}

export function isGenericKey(key: string): boolean {
  return key === '' || GENERIC_KEY.test(key);
}

// null = "no merchant here" (empty or a bare payment-type phrase).
export function usableMerchantKey(raw: string | null | undefined): string | null {
  const key = merchantKey(raw);
  return isGenericKey(key) ? null : key;
}
