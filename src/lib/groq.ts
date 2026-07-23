// Voice-message transcription via Groq's Whisper API (free tier) — this
// project's first third-party AI dependency (see
// specs/001-voice-transaction-logging/research.md #2). Self-hosting Whisper
// was rejected because Vercel serverless can't run inference (no GPU,
// execution-time limits, no long-lived process).
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Groq/Whisper's prompt param biases vocabulary and orthography, not literal
// continuation — domain examples across all three languages, in correct
// spelling, nudge the model away from misclassifying Ukrainian as Russian (a
// documented Whisper weakness for close language pairs) and toward
// recognizable finance vocabulary. Originally hardcoded "крон"/"kroner" for
// the one household this app was built for (everything tracked in NOK) —
// now built per the HOUSEHOLD's own chosen currency (lib/currencies.ts) so a
// PLN or EUR household gets biased toward the currency word THEY actually
// say, not one nobody in that household ever uses.
function buildPrompt(spokenUk: string, spokenEn: string): string {
  return `Особистий бюджет. Потратив 200 ${spokenUk} на їжу. Отримав зарплату 15000. Купив продукти за 350 ${spokenUk}. I spent 50 ${spokenEn} on coffee. Потратил 300 ${spokenUk} на бензин.`;
}

// Fails loudly on missing config (fail-closed, matching TELEGRAM_BOT_TOKEN/
// AUTH_SECRET elsewhere) — never silently skip transcription. Returns null
// only for a normal transcription failure (empty/unusable result), which the
// caller treats the same as an unparseable voice message (asks the sender to
// retry), not as a hard error.
export async function transcribe(audio: Buffer, currency: { spokenUk: string; spokenEn: string }): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-large-v3');
  // No `language` hint — the household speaks Ukrainian, English, or
  // Russian interchangeably, and Whisper's auto-detection across these
  // three is reliable enough that forcing one would only hurt the other two.
  form.append('response_format', 'json');
  form.append('prompt', buildPrompt(currency.spokenUk, currency.spokenEn));

  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return null; // rate limit, transient error — treated as "couldn't understand", not a crash

  const data = await res.json().catch(() => null);
  const text = typeof data?.text === 'string' ? data.text.trim() : '';
  return text || null;
}
