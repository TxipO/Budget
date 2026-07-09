// LLM-based extraction — the rule-based approach (voiceParse.ts's stems +
// categoryGuess.ts's keyword regexes) kept failing on real spoken
// Ukrainian/Russian/English: grammatical cases, mid-word language mixing,
// generic category words a person actually says, multi-number phrases.
// Each live-testing round fixed one specific failure and immediately
// surfaced the next — that pattern itself is the signal that regex/stem
// matching is the wrong tool for free-form natural language, not that the
// next patch will finally be the last one. This asks Groq's Llama model
// (same GROQ_API_KEY, no new dependency) to do what it's actually built
// for, with the real category list from the DB so it can only pick a
// category that exists. Falls back to the rule-based path if this call
// fails, returns invalid JSON, or the model itself reports low confidence
// — never a single point of failure for the whole feature.

interface LLMExtraction {
  amount: number;
  direction: 'income' | 'expense';
  // null = the model's category guess didn't match one of the provided
  // names exactly — the caller falls back to guessCategoryId()'s own
  // rule/MCC/keyword/safe-fallback chain for the category only, keeping
  // the LLM's amount/direction (see the validation note below for why
  // amount/direction and category must fail independently).
  categoryName: string | null;
}

function buildSystemPrompt(senderName: string): string {
  return `Ти витягуєш дані транзакції особистого бюджету з голосового повідомлення (українською, російською або англійською, іноді змішаними). Повідомлення надіслав ${senderName}.

Поверни ЛИШЕ JSON, без пояснень: {"amount": число, "direction": "expense" або "income", "category": рядок, "confident": true або false}.

Правила:
- "confident" стосується ЛИШЕ суми і напрямку (витрата/дохід) — НЕ категорії. Категорія майже завжди має хоч якийсь розумний варіант (є категорія "Незрозуміло" саме для цього), тому непевність щодо категорії НІКОЛИ сама по собі не повинна знижувати "confident".
- "category" МАЄ бути точно одним із наданих варіантів, символ у символ. Якщо жодна не підходить явно — вибери "Незрозуміло" (для витрат) чи найбільш нейтральну з дохідних, це нормально і не впливає на "confident".
- Деякі категорії доходу названі на честь конкретної людини в домогосподарстві (наприклад, іменем самого відправника або іншого його члена). Якщо повідомлення не називає явно ІНШУ людину, а йдеться про дохід самого відправника (напр. "отримав зарплату") — обирай категорію з іменем ${senderName}, якщо така є серед наданих варіантів. НІКОЛИ не вгадуй категорію з іменем іншої людини, якщо відправник не сказав явно, що це стосується неї.
- Якщо в повідомленні кілька чисел і НЕЗРОЗУМІЛО яке з них сума (а не, наприклад, очевидна кількість×ціна) — постав "confident": false.
- Якщо НЕЗРОЗУМІЛО, витрата це чи дохід — постав "confident": false.
- Якщо сума взагалі не названа — постав "confident": false.
- Ніколи не вигадуй суму чи напрямок — краще "confident": false, ніж здогадка. Категорію вгадувати можна завжди.`;
}

// Returns null on any failure or low-confidence signal — same contract as
// voiceParse.ts's parseVoiceTransaction, so the webhook route can try this
// first and fall back to the rule-based path transparently.
export async function extractWithLLM(
  transcript: string,
  expenseCategories: string[],
  incomeCategories: string[],
  senderName: string,
): Promise<LLMExtraction | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const userPrompt = `Витратні категорії: ${expenseCategories.join(', ')}\nДохідні категорії: ${incomeCategories.join(', ')}\n\nПовідомлення: "${transcript}"`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: buildSystemPrompt(senderName) },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  });
  if (!res.ok) return null; // rate limit, transient error — falls back to rule-based, not a crash

  const data = await res.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (parsed?.confident !== true) return null;
  if (typeof parsed.amount !== 'number' || !Number.isFinite(parsed.amount) || parsed.amount <= 0) return null;
  if (parsed.direction !== 'income' && parsed.direction !== 'expense') return null;

  // Category mismatch must NOT invalidate amount/direction. Found live: the
  // system prompt says "confident" governs amount/direction only and a
  // category is always guessable, but the code here previously nulled out
  // the WHOLE result — including a correctly, confidently extracted
  // amount/direction — the moment the model's category string didn't match
  // the provided list character-for-character. temperature:0 + explicit
  // "exact copy" instructions make an exact match likely, not guaranteed
  // (trailing punctuation, a grammatically-inflected variant, a
  // near-miss on a long Cyrillic list are all real LLM failure modes).
  // Losing amount/direction over that sends a case the LLM actually solved
  // (the grammatical-case/language-mixing problem this whole redesign
  // exists for) back through the weaker rule-based parser instead — of all
  // outcomes, that's the one this feature was rebuilt to avoid.
  const validCategories = parsed.direction === 'income' ? incomeCategories : expenseCategories;
  const categoryName = typeof parsed.category === 'string' && validCategories.includes(parsed.category) ? parsed.category : null;

  return { amount: parsed.amount, direction: parsed.direction, categoryName };
}
