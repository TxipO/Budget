// Voice-message transcription via Groq's Whisper API (free tier) — this
// project's first third-party AI dependency (see
// specs/001-voice-transaction-logging/research.md #2). Self-hosting Whisper
// was rejected because Vercel serverless can't run inference (no GPU,
// execution-time limits, no long-lived process).
const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Fails loudly on missing config (fail-closed, matching TELEGRAM_BOT_TOKEN/
// AUTH_SECRET elsewhere) — never silently skip transcription. Returns null
// only for a normal transcription failure (empty/unusable result), which the
// caller treats the same as an unparseable voice message (asks the sender to
// retry), not as a hard error.
export async function transcribe(audio: Buffer): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', 'whisper-large-v3');
  // No `language` hint — the household speaks Ukrainian, English, or
  // Russian interchangeably, and Whisper's auto-detection across these
  // three is reliable enough that forcing one would only hurt the other two.
  form.append('response_format', 'json');
  // Groq/Whisper's prompt param biases vocabulary and orthography, not
  // literal continuation — domain examples across all three languages,
  // in correct spelling, nudge the model away from misclassifying
  // Ukrainian as Russian (a documented Whisper weakness for close language
  // pairs) and toward recognizable finance vocabulary. Uses "крон"/"kr",
  // not "гривень" — the household's real spoken currency (everything is
  // tracked in NOK, see lib/monobank.ts's UAH->NOK conversion), confirmed
  // from an actual live transcript this session ("Потратив 200 крон на
  // категорію «Продукти»"). Biasing toward a currency word nobody actually
  // says doesn't help recognition of the one they do.
  form.append('prompt', 'Особистий бюджет. Потратив 200 крон на їжу. Отримав зарплату 15000. Купив продукти за 350 крон. I spent 50 kroner on coffee. Потратил 300 крон на бензин.');

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
