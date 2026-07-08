# Implementation Plan: Voice Transaction Logging

**Branch**: `001-voice-transaction-logging` | **Date**: 2026-07-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-voice-transaction-logging/spec.md`

## Summary

A linked household member sends a voice message to the project's Telegram bot; the bot downloads the audio, transcribes it via Groq's Whisper API, extracts an amount and income/expense direction, guesses a category by reusing the existing Monobank rule→keyword→fallback logic (extracted into a shared function), creates a `Transaction` row attributed to that user, and replies with a confirmation. Unclear or unlinked-sender messages never create a transaction. This is a new webhook endpoint (`/api/webhooks/telegram`) plus a small amount extraction/parsing module — no new database tables, no new UI.

## Technical Context

**Language/Version**: TypeScript, Next.js 14 App Router (matches the rest of the codebase)

**Primary Dependencies**: Existing: Prisma 5 + Postgres (Neon, pooled). New: Groq API (Whisper transcription) via plain `fetch` — no SDK needed, it's a single multipart POST. Telegram Bot API (`getFile` + file download) — already partially used in the codebase's `TELEGRAM_BOT_TOKEN`-based auth work, same token, different API surface (Bot API methods vs. Login Widget verification).

**Storage**: Postgres via Prisma — no schema changes. Reuses `Transaction` (new `source: 'voice'` value, same field already used to distinguish manual/import/recurring/mono) and `User.telegramId` (already exists from the Telegram-auth work) to resolve sender → household member.

**Testing**: No test framework in this repo (verified live via real runtime, per Constitution Principle III) — verification is a simulated Telegram webhook payload posted to the local/deployed endpoint, mirroring the exact pattern already used to verify the Monobank webhook and the Telegram Login Widget flow this session (locally-signed/constructed test payloads, live DB checks before/after, cleanup).

**Target Platform**: Vercel serverless (Node.js runtime, not Edge — this route needs `fetch` to two external services plus a Prisma call, same runtime class as the existing Monobank webhook route)

**Project Type**: Web service (single Next.js app — no frontend/backend split, no new project)

**Performance Goals**: Telegram webhooks must be acknowledged quickly (Telegram retries if a webhook doesn't respond); the transcription round-trip (download audio + Groq call) is the slow part. No hard latency budget stated in the spec beyond SC-001 (under 15s end-to-end), which is generous for a webhook handler.

**Constraints**: Must not create a transaction on low-confidence parses or unlinked senders (FR-004, FR-005, FR-008 — hard correctness/security constraints, not performance ones). Must be idempotent against duplicate webhook delivery (FR-011).

**Scale/Scope**: 2 household members, occasional voice messages — no scale concerns; this is a low-QPS webhook, same class as the Monobank one.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Fix Confirmed Bugs Immediately** — N/A at planning time; applies during implementation/review.
- **II. Security Review Gates** — ✅ applicable and acknowledged: this touches auth (sender→user resolution), a new external integration (Groq), and a new webhook — MUST go through `/selfcheck` and `/deep-review` before being considered done, per the constitution. Tracked as a task in Phase 2.
- **III. Verify Live, Not Just Types** — ✅ plan's Testing strategy (above) and quickstart.md commit to live verification via simulated webhook payloads, matching established project practice.
- **IV. No Over-Engineering** — ✅ no new tables, no new abstraction layer beyond extracting the *already-duplicated-in-spirit* category-guessing logic into one shared function (which two features now need — not a speculative abstraction, an actual second caller).
- **V. Money and Fallbacks Fail Loudly** — ✅ directly encoded in FR-004/FR-005: an unparseable amount or unclear direction MUST NOT default to a guess, MUST ask for clarification instead. No `?? 0`-style fallback anywhere in the amount-parsing path.
- **VI. Environment-Independent Correctness** — ✅ no local-timezone date math introduced (transaction `date` will use `new Date()` at webhook-receipt time, UTC under the hood, consistent with existing manual-entry transactions); no module-level mutable state (idempotency check will be DB-backed — see Data Model — not an in-memory set, which would not survive across serverless invocations); pooled Neon endpoint already configured project-wide.
- **VII. Explicit Data-Exposure Boundaries** — ✅ the sender→user lookup (`prisma.user.findUnique({ where: { telegramId } })`) will use an explicit `select` for only `id`/`name`, matching the existing pattern in `api/auth/telegram/route.ts`.

**Result**: PASS, no violations to justify. Complexity Tracking section left empty.

**Post-Phase-1 re-check**: Design added one schema change (`Transaction.telegramMessageId`, nullable+unique — same additive shape already used for `monoStatementId`) and one new trust-boundary detail (Telegram's `secret_token` header, discovered while writing `contracts/telegram-webhook.md` — the Monobank webhook's per-user-secret-path trick doesn't carry over to Telegram's webhook model). Neither introduces a violation: the schema change follows Principle IV/VI precedent exactly, and the secret-token requirement *strengthens* Principle VII-adjacent trust-boundary discipline rather than weakening it. PASS confirmed post-design.

## Project Structure

### Documentation (this feature)

```text
specs/001-voice-transaction-logging/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/            # Phase 1 output
└── tasks.md              # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

Single Next.js project — no new top-level directory, following this repo's existing `src/app/api/**` + `src/lib/**` layout exactly as the Monobank and Telegram-auth features did.

```text
src/
├── app/
│   └── api/
│       └── webhooks/
│           └── telegram/
│               └── route.ts          # NEW — receives Telegram Bot API webhook updates, handles voice messages
├── lib/
│   ├── categoryGuess.ts               # NEW — extracted from webhooks/monobank/[secret]/route.ts's resolveCategoryId,
│   │                                   #        generalized to work from free text (voice transcript) as well as
│   │                                   #        merchant description (Monobank); both callers migrate to this
│   ├── voiceParse.ts                  # NEW — amount + income/expense extraction from transcribed Ukrainian text
│   ├── groq.ts                        # NEW — thin wrapper around Groq's Whisper transcription endpoint
│   └── telegramBot.ts                 # NEW — thin wrapper around Telegram Bot API's getFile + sendMessage methods
└── app/api/webhooks/monobank/[secret]/route.ts  # EXISTING — resolveCategoryId call site migrates to lib/categoryGuess.ts
```

**Structure Decision**: Single project, matches the existing codebase exactly — a new webhook route plus four small `lib/` modules (transcription client, Telegram Bot API client, text-based amount/direction parsing, and the generalized category guesser). No new database migration, no new frontend surface.

## Complexity Tracking

*No Constitution Check violations — table intentionally left empty.*
