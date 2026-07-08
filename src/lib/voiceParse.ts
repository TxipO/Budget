// Rule-based extraction, not a second AI call — Whisper already transcribes
// spoken numbers as digits regardless of language (see
// specs/001-voice-transaction-logging/research.md #4), so a regex + keyword
// lists solve this without a second place an AI could guess wrong silently.
// The household speaks Ukrainian, English, and Russian interchangeably
// (matches lib/groq.ts's no-language-hint auto-detection).
//
// STEMS, not full words — a real failure case: without a language hint,
// Whisper sometimes blends Ukrainian and Russian mid-word (heard "Вытраты"
// — not a real word in either language, a hybrid of укр. "витрати" and
// рос. "траты"/"расходы"). Matching the exact verb forms
// ("потратив"/"витратив") missed this entirely, since the actual utterance
// was a noun ("expenses"), not "I spent". A short stem ("трат") is a
// substring of nearly every inflection AND survives this kind of
// language-mixing garble, since the blended word still contains the
// shared root.
const EXPENSE_STEMS = [
  'трат',   // ви[трат]ив, по[трат]ила, [трат]а/[трат]и, вы[трат]ы — укр+рос root for "spend"
  'куп',    // куп(ив/ила/ити/ил/ить) — "buy"
  'заплат', // заплат(ив/ила/ил) — "paid"
  'оплат',  // оплат(ив/ила/ил/а) — "payment"
  'расход', // расход(ы/ов) — рос. "expenses" (no трат root)
  'spent', 'bought', 'paid', 'expense',
];
const INCOME_STEMS = [
  'отрима', // отрима(в/ла/ти) — укр. "receive"
  'получ',  // получ(ил/ила/ить) — рос. "receive"
  'зарплат', // зарплат(а/у) — same word both languages
  'дохід', 'доход', // "income" — different spelling per language, both kept
  'верну',  // верну(ли/в) / повернули — "returned"/"refunded"
  'продал', 'продав', // "sold"
  // English — bare "got"/"paid" are too ambiguous alone ("got a coffee for
  // 200" is an expense; "got paid" is income) — require an unambiguous verb.
  'received', 'got paid', 'earned', 'salary', 'income',
];

export interface ParsedVoiceTransaction {
  amount: number;
  direction: 'income' | 'expense';
}

// Returns null on any low-confidence signal (FR-004/FR-005) — the caller
// asks the sender to clarify rather than guessing and logging something
// wrong. Never returns a default/guessed amount or direction.
export function parseVoiceTransaction(text: string): ParsedVoiceTransaction | null {
  const normalized = text.toLowerCase();

  const amountMatch = normalized.match(/\d+([.,]\d+)?/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[0].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const hasExpenseStem = EXPENSE_STEMS.some(w => normalized.includes(w));
  const hasIncomeStem = INCOME_STEMS.some(w => normalized.includes(w));
  // Ambiguous (both or neither) — do not guess a direction.
  if (hasExpenseStem === hasIncomeStem) return null;

  return { amount, direction: hasIncomeStem ? 'income' : 'expense' };
}
