# Phase 0 Research: Voice Transaction Logging

All items below were open technical unknowns after `/speckit-specify`; FR-002's provider choice was already resolved in spec.md itself (Groq's Whisper API), so this file covers the remaining implementation-level unknowns needed before Phase 1 design.

## 1. Receiving a Telegram voice message via webhook

**Decision**: Telegram's Bot API delivers voice messages as a `message.voice` object on the webhook update, containing a `file_id` (not the audio itself). The handler must call `getFile` (`https://api.telegram.org/bot<TOKEN>/getFile?file_id=...`) to get a `file_path`, then download the actual OGG/Opus audio from `https://api.telegram.org/file/bot<TOKEN>/<file_path>`.

**Rationale**: This is how Telegram's Bot API works for all file types (photos, voice, documents) — there's no alternative; the webhook payload is always metadata + a fetchable id, never inline binary.

**Alternatives considered**: None — this is Telegram's only mechanism for file delivery via Bot API.

## 2. Groq Whisper API contract

**Decision**: `POST https://api.groq.com/openai/v1/audio/transcriptions`, `Authorization: Bearer $GROQ_API_KEY`, multipart form body with the audio file and `model=whisper-large-v3` (best multilingual accuracy of Groq's Whisper model options). No `language` hint — the household speaks Ukrainian, English, and Russian interchangeably, and forcing one would hurt Whisper's accuracy on the other two; its auto-detection across these three is reliable enough to rely on. Response is JSON with a `text` field containing the transcript. Confirmed live: a real Groq call against a test audio clip returned a correct transcript with the spoken number preserved as a digit.

**Rationale**: Groq's transcription endpoint is OpenAI-API-compatible (same shape as OpenAI's own Whisper endpoint), so it's a plain `fetch` with `FormData` — no SDK dependency needed, consistent with this project's existing pattern of avoiding heavyweight dependencies for single-purpose API calls (see `lib/monobank.ts`, `lib/crypto.ts` — thin wrappers, not SDKs).

**Alternatives considered**: `whisper-large-v3-turbo` (faster, slightly less accurate) — deferred; can be swapped later by changing one string if transcription latency becomes a real problem (SC-001's 15s budget is generous enough that this isn't needed for v1).

## 3. Idempotency against duplicate webhook delivery (FR-011)

**Decision**: Telegram includes a monotonically increasing `update_id` on every webhook delivery. Store the highest-processed `update_id` (or, more robustly, the specific voice message's Telegram `file_unique_id`) and skip processing if already seen. Given this project already has a proven idempotency pattern — Monobank's webhook dedupes via `monoStatementId String? @unique` on `Transaction` — the same approach applies here: add a unique constraint on a Telegram-message-identifying field and let the DB reject the duplicate insert, rather than a separate "seen updates" table.

**Rationale**: Matches Constitution Principle VI (no module-level mutable state — an in-memory "seen set" would not survive across serverless invocations and would not work at all under concurrent/retried delivery). A DB-level unique constraint is the same mechanism already proven correct for the Monobank case.

**Alternatives considered**: An in-memory dedupe cache — rejected outright per Constitution VI (serverless-unsafe, already learned the hard way once in this project). A separate `ProcessedTelegramUpdate` table — rejected as unnecessary; reusing `Transaction`'s existing dedupe-by-unique-field pattern is simpler and consistent (see Data Model).

## 4. Extracting amount and income/expense direction from transcribed text

**Decision**: Rule-based extraction, not a second AI/LLM call — regex for a numeric amount (Whisper reliably transcribes spoken numbers as digits regardless of language, e.g. spoken "двісті"/"двести"/"two hundred" → transcribed "200", so no number-word parsing is needed for any of the three), plus keyword lists to classify direction, covering Ukrainian, Russian, and English (expense: потратив/потратил/spent/bought/paid; income: отримав/получил/received/earned/salary). No amount found, or neither/both keyword sets match → low-confidence, triggers FR-004/FR-005's clarification path rather than a guess. Confirmed live against 10 real phrases across all three languages plus 2 edge cases (English "got paid" deliberately stays ambiguous — "paid" alone is also a valid expense signal — and a no-amount phrase), all resolving as designed.

**Rationale**: Consistent with this project's established categorization approach (Monobank categorization is explicitly rule-based: MCC → keyword → fallback, no LLM) and Constitution Principle IV (no over-engineering) — a second Groq LLM call to "interpret" the transcript would be a second new AI dependency for a problem two keyword lists and a regex already solve, given Whisper already does the hard part (speech → clean text with numerals).

**Alternatives considered**: A second Groq chat-completion call to extract structured `{amount, direction}` JSON from the transcript — rejected for this v1: real cost/latency for marginal benefit over regex + keywords on short, formulaic voice messages, and it would introduce a second place an "AI guessed wrong silently" failure mode could hide, working against FR-004/FR-005's core guarantee.

## 5. Category guessing from free text (vs. Monobank's merchant description)

**Decision**: Generalize the existing Monobank `resolveCategoryId` logic (rule → MCC → merchant keyword → fallback) into `lib/categoryGuess.ts`, taking a plain text string (works for both a Monobank merchant description and a voice transcript) and an optional MCC (only Monobank has this). Voice calls it with `mcc: undefined`, so it skips straight to the keyword/fallback tiers.

**Rationale**: This is the "two independent subsystems modeling the same concept" pattern already flagged as a real bug class in this project's `/deep-review` skill (the double-counted-transaction lesson) — but inverted: here it's the same *logic* needed by two features, so the fix is to share it, not duplicate it a second time.

**Alternatives considered**: Copy-pasting a second, voice-specific category guesser — rejected; this is exactly the kind of duplication the project's own `/deep-review` process exists to catch, better to not introduce it in the first place.

---

**Output check**: All unknowns from Technical Context resolved. No remaining NEEDS CLARIFICATION markers.
