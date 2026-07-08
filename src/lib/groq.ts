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
  form.append('language', 'uk');
  form.append('response_format', 'json');

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
