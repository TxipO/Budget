// Rule-based extraction, not a second AI call — Whisper already transcribes
// spoken numbers as digits regardless of language (see
// specs/001-voice-transaction-logging/research.md #4), so a regex + keyword
// lists solve this without a second place an AI could guess wrong silently.
// The household speaks Ukrainian, English, and Russian interchangeably
// (matches lib/groq.ts's no-language-hint auto-detection) — keyword lists
// cover all three rather than picking one.

const EXPENSE_WORDS = [
  // Ukrainian
  'потратив', 'потратила', 'витратив', 'витратила', 'купив', 'купила', 'заплатив', 'заплатила', 'оплатив', 'оплатила',
  // Russian
  'потратил', 'потратила', 'купил', 'купила', 'заплатил', 'заплатила', 'оплатил', 'оплатила',
  // English
  'spent', 'bought', 'paid',
];
const INCOME_WORDS = [
  // Ukrainian
  'отримав', 'отримала', 'зарплата', 'зарплату', 'дохід', 'повернули', 'продав', 'продала',
  // Russian
  'получил', 'получила', 'зарплату', 'доход', 'вернули', 'продал', 'продала',
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

  const hasExpenseWord = EXPENSE_WORDS.some(w => normalized.includes(w));
  const hasIncomeWord = INCOME_WORDS.some(w => normalized.includes(w));
  // Ambiguous (both or neither) — do not guess a direction.
  if (hasExpenseWord === hasIncomeWord) return null;

  return { amount, direction: hasIncomeWord ? 'income' : 'expense' };
}
