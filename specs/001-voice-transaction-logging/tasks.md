# Tasks: Voice Transaction Logging

**Input**: Design documents from `specs/001-voice-transaction-logging/` (plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Not requested — this repo has no test framework; verification is live, via `quickstart.md`'s simulated-webhook scenarios (per Constitution Principle III).

**Organization**: Grouped by user story from spec.md, in priority order.

## Phase 1: Setup

- [x] T001 Add `telegramMessageId String? @unique` to the `Transaction` model in `prisma/schema.prisma`; run `npx prisma db push --accept-data-loss` (safe — nullable unique column, same precedent as `monoStatementId`)
- [x] T002 `TELEGRAM_WEBHOOK_SECRET` and `GROQ_API_KEY` both set (local `.env` + Vercel production). Key verified valid via a real Groq API call before use
- [x] T003 [P] Confirmed `TELEGRAM_BOT_TOKEN` already present and working (real bot `@BudgetVoiceHandler_bot`, verified end-to-end during Ф7)

## Phase 2: Foundational (blocking prerequisites)

**⚠️ No user story can be completed until this phase is done — these are the shared building blocks every story's webhook path calls into.**

- [x] T004 [P] `src/lib/groq.ts` — `transcribe()`, per `contracts/groq-transcription.md`. Verified live against the real Groq endpoint with a real audio clip — transcription came back correct, spoken number preserved as a digit. No `language` hint (dropped in favor of auto-detection across uk/en/ru — see research.md #2)
- [x] T005 [P] `src/lib/telegramBot.ts` — `downloadVoice()` (getFile + download) and `sendMessage()`, per `contracts/telegram-webhook.md`. `sendMessage`'s fire-and-forget error handling exercised live (unlinked-sender test called it against a fake token, confirmed it doesn't throw)
- [x] T006 [P] `src/lib/voiceParse.ts` — extended to cover Ukrainian, English, and Russian keyword sets (the household's actual usage, not Ukrainian-only). Verified against 10 real phrases across all three languages plus 2 edge cases (English "got paid" deliberately stays ambiguous, a no-amount phrase) — all resolve as designed
- [x] T007 `src/lib/categoryGuess.ts` extracted from the Monobank webhook's inline `resolveCategoryId`; Monobank route updated to call it. Verified live against the real DB post-extraction: an MCC 5411 (grocery) guess still resolves to "Їжа", a no-match text still falls back to "Незрозуміло" — same behavior as before the extraction
- [x] T008 `src/app/api/webhooks/telegram/route.ts` skeleton. Verified live on both local dev and real production: wrong `secret_token` → 200 no-op, non-voice update → 200 no-op, duplicate `telegramMessageId` → 200 no-op with exactly one row surviving

**Checkpoint**: Foundation ready — webhook receives voice messages safely and no-ops correctly, but doesn't yet create transactions.

## Phase 3: User Story 1 - Log an expense by voice (Priority: P1) 🎯 MVP

**Goal**: A linked sender's clear voice message creates an attributed, categorized expense transaction and gets a confirmation reply.

**Independent Test**: `quickstart.md` step 1.

- [x] T009 [US1] Full happy path wired in `src/app/api/webhooks/telegram/route.ts`, matching this description exactly
- [x] T010 [US1] Verified live: a real audio clip ("spent 200 on coffee") through the real Groq endpoint transcribed correctly, parsed correctly, resolved a category, created a `Transaction`, all against a disposable test user (cleaned up after). The one piece not exercised with a *real* Telegram `file_id` is `downloadVoice`'s `getFile` call — fundamentally requires a real voice message sent to the real bot, which only the user can do; the route's graceful "couldn't download" fallback covers a failure here regardless

**Checkpoint**: MVP — expense logging by voice works end-to-end (short of a real bot being registered; see T022).

## Phase 4: User Story 3 - Bot asks instead of guessing when unsure (Priority: P1)

**Goal**: Low-confidence transcriptions never create a transaction.

**Independent Test**: `quickstart.md` step 2.

- [x] T011 [US3] Clarification branches wired (no-amount and ambiguous-direction, both bypass `prisma.transaction.create`)
- [x] T012 [US3] Verified — `voiceParse` returns `null` for both trigger cases (no amount, ambiguous direction) directly against real phrases, matching FR-004/FR-005's ask-don't-guess requirement

**Checkpoint**: Guessing-is-worse-than-asking guarantee (FR-004/FR-005) is enforced.

## Phase 5: User Story 4 - Unlinked sender cannot log a transaction (Priority: P1)

**Goal**: An unrecognized Telegram sender can never create a transaction, under any household member.

**Independent Test**: `quickstart.md` step 3.

- [x] T013 [US4] Sender lookup runs before `downloadVoice`/`transcribe` in the route, exactly as designed
- [x] T014 [US4] Verified live on local dev: voice message from an untracked `telegramId` → zero `Transaction` rows before and after, 200 response

**Checkpoint**: Hard security boundary (FR-008/FR-009) enforced independently of parse quality.

## Phase 6: User Story 2 - Log income by voice (Priority: P2)

**Goal**: Income-direction messages create income transactions, not expenses.

**Independent Test**: quickstart-equivalent scenario — voice stating money received (e.g. "отримав зарплату 15000").

- [x] T015 [US2] Confirmed — `voiceParse("отримав зарплату 15000")` returns `{amount: 15000, direction: 'income'}` (verified directly), and the route has no expense/income branch split, so no route-level change was needed
- [x] T016 [US2] Covered by T010's E2E test methodology (same code path, direction is data not a branch) — a dedicated income-phrased audio clip wasn't separately generated, but `voiceParse`'s income detection is already verified (T015) and nothing downstream branches on direction differently

**Checkpoint**: All four user stories independently verified.

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T017 [P] Verified — seeded a real row with a known `telegramMessageId`, replayed the same id through the route, confirmed exactly 1 row survives
- [x] T018 [P] Verified on both local dev and real production — wrong `secret_token` → 200, no row, no reply
- [x] T019 `/selfcheck` run against all 5 new files — clean (no unhandled fetches, no `console.log`, no `as any`, no module-level state, explicit `select` on the `User` lookup)
- [x] T020 `/deep-review` reasoning applied during design (see research.md and inline comments): Category 9 doesn't add a new concern beyond FR-011's idempotency — a delivered Telegram voice message is a final event, unlike Monobank's `hold`, so no additional "is this provisional" check was needed. Category 5 — the unlinked-sender and duplicate-delivery races were the two real concurrency concerns and both are handled (guard order, unique constraint + P2002 catch)
- [x] T021 `verify-data-integrity.mjs` — 0 FAIL / 0 WARN, checked after every round of test-data cleanup and again after the production deploy
- [x] T022 Registered live via `setWebhook` (real bot token, `secret_token` = `TELEGRAM_WEBHOOK_SECRET`), confirmed via `getWebhookInfo` that the URL and `allowed_updates` are correct. **The bot is now fully live** — a real voice message sent to `@BudgetVoiceHandler_bot` by a linked household member will create a real transaction. Not yet done by an actual human speaking to the actual bot (only the user can do that) — everything the code can be responsible for has been verified

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational)**: strictly sequential, both block every user story.
- **Phase 3 (US1)** should be built first — it's the MVP and the happy-path skeleton that Phases 4–6 branch off of.
- **Phase 4 (US3)** and **Phase 5 (US4)** both modify the same route as Phase 3 and are easiest done in sequence after it, even though their *guarantees* are logically independent of each other.
- **Phase 6 (US2)** has no new implementation once Phase 3 is done correctly (T015 is a verification-only task) — lowest-effort phase, can trail last despite being P2 in the spec.
- **Phase 7 (Polish)** requires Phases 3–6 complete. T022 is independently blocked on an external dependency (Ф7) and can be done whenever that unblocks, regardless of the rest of Phase 7's status.

## Parallel Execution Opportunities

- T004, T005, T006 (Phase 2) touch different new files with no interdependency — parallelizable.
- T017 and T018 (Phase 7) are independent verification scenarios — parallelizable.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (T001–T010).** This alone delivers a working "speak an expense, it gets logged" flow and is independently demoable via `quickstart.md` step 1, even before the safety-guarantee stories (US3/US4) are layered on. Given US3 and US4 are both P1 correctness/security guarantees rather than optional polish, they should immediately follow in the same work session rather than actually shipping as a separate increment — the phase split exists for independent testability, not because it's safe to deploy Phase 3 alone to production.
