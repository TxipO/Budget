# Contract: Outbound Groq Transcription Call

`POST https://api.groq.com/openai/v1/audio/transcriptions`

**Headers**: `Authorization: Bearer ${GROQ_API_KEY}`

**Body** (multipart/form-data):
- `file`: the downloaded OGG/Opus audio bytes (from Telegram's `getFile` — see research.md #1)
- `model`: `whisper-large-v3`
- `response_format`: `json` (default; explicit for clarity)
- No `language` field — the household speaks Ukrainian, English, and Russian interchangeably; omitting it lets Whisper auto-detect rather than forcing one language and hurting accuracy on the other two.

**Response** (200):
```json
{ "text": "потратив 200 гривень на каву" }
```

**Failure modes to handle**:
- Non-200 (rate limit, auth failure, service error) → treat as a transcription failure (Edge Cases: "couldn't understand the message, try again"), never as a silent skip. `GROQ_API_KEY` misconfiguration should fail loudly at first use, matching the existing `TELEGRAM_BOT_TOKEN`/`AUTH_SECRET` "fail closed, not open" pattern (Constitution-adjacent: an unset required secret must produce a clear 500-class error, never silently degrade).
- Empty or whitespace-only `text` → same handling as an unparseable transcript (FR-004's clarification path), not a hard error.
