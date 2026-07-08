# Tasks: Voice Transaction Logging

**Input**: Design documents from `specs/001-voice-transaction-logging/` (plan.md, research.md, data-model.md, contracts/, quickstart.md)

**Tests**: Not requested — this repo has no test framework; verification is live, via `quickstart.md`'s simulated-webhook scenarios (per Constitution Principle III).

**Organization**: Grouped by user story from spec.md, in priority order.

## Phase 1: Setup

- [ ] T001 Add `telegramMessageId String? @unique` to the `Transaction` model in `prisma/schema.prisma`; run `npx prisma db push --accept-data-loss` (safe — nullable unique column, same precedent as `monoStatementId`)
- [ ] T002 Add `GROQ_API_KEY` and `TELEGRAM_WEBHOOK_SECRET` (a new random value for Telegram's `secret_token`) to local `.env` — **manual**: real values must come from the user (Groq account signup; webhook secret can be any locally-generated random string)
- [ ] T003 [P] Confirm `TELEGRAM_BOT_TOKEN` is already present (reused from the Ф1–Ф6 Telegram-auth work) — no new value needed, just confirm it's set

## Phase 2: Foundational (blocking prerequisites)

**⚠️ No user story can be completed until this phase is done — these are the shared building blocks every story's webhook path calls into.**

- [ ] T004 [P] Create `src/lib/groq.ts` — `transcribe(audioBuffer: Buffer): Promise<string | null>`, per `contracts/groq-transcription.md` (returns `null` on failure or empty transcript, never throws for a normal transcription failure — only throws if `GROQ_API_KEY` is unset, per the fail-closed pattern in that contract)
- [ ] T005 [P] Create `src/lib/telegramBot.ts` — `getVoiceFileUrl(fileId: string): Promise<string>` (calls `getFile`, builds the download URL) and `sendMessage(chatId: number, text: string): Promise<void>`, per `contracts/telegram-webhook.md`
- [ ] T006 [P] Create `src/lib/voiceParse.ts` — `parseVoiceTransaction(text: string): { amount: number; direction: 'income' | 'expense' } | null`, per research.md #4 (regex for a numeric amount + expense/income keyword lists; returns `null` on low confidence, no fallback guess)
- [ ] T007 Create `src/lib/categoryGuess.ts` by extracting and generalizing `resolveCategoryId` out of `src/app/api/webhooks/monobank/[secret]/route.ts` (per research.md #5) — signature `guessCategoryId(text: string, mcc?: number): Promise<number>`, MCC tier skipped when `mcc` is `undefined`; update the Monobank webhook route to call this instead of its inline version
- [ ] T008 Create `src/app/api/webhooks/telegram/route.ts` skeleton: verify `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (200 no-op on mismatch, per `contracts/telegram-webhook.md`'s trust-boundary section); parse the update body; 200 no-op on anything that isn't `message.voice`; 200 no-op if a `Transaction` with this `telegramMessageId` already exists (idempotency, per FR-011)

**Checkpoint**: Foundation ready — webhook receives voice messages safely and no-ops correctly, but doesn't yet create transactions.

## Phase 3: User Story 1 - Log an expense by voice (Priority: P1) 🎯 MVP

**Goal**: A linked sender's clear voice message creates an attributed, categorized expense transaction and gets a confirmation reply.

**Independent Test**: `quickstart.md` step 1.

- [ ] T009 [US1] In `src/app/api/webhooks/telegram/route.ts`, wire the full happy path: download voice via `telegramBot.getVoiceFileUrl` → fetch audio bytes → `groq.transcribe` → `voiceParse.parseVoiceTransaction` → resolve sender via `prisma.user.findUnique({ where: { telegramId: String(message.from.id) }, select: { id: true, name: true } })` → `categoryGuess.guessCategoryId(text)` → `prisma.transaction.create` with `source: 'voice'`, `telegramMessageId`, `amount` via `roundMoney()`, `details` = raw transcript → `telegramBot.sendMessage` confirming amount/category/name
- [ ] T010 [US1] Verify live per `quickstart.md` step 1 — simulated webhook POST with a real short test audio clip, confirm the `Transaction` row and the confirmation reply, clean up the test row

**Checkpoint**: MVP — expense logging by voice works end-to-end (short of a real bot being registered; see T022).

## Phase 4: User Story 3 - Bot asks instead of guessing when unsure (Priority: P1)

**Goal**: Low-confidence transcriptions never create a transaction.

**Independent Test**: `quickstart.md` step 2.

- [ ] T011 [US3] In the T009 happy path, branch before transaction creation: `voiceParse` returning `null` → `sendMessage` asking for the amount; amount present but direction ambiguous → `sendMessage` asking spent-or-received — neither path calls `prisma.transaction.create`
- [ ] T012 [US3] Verify live per `quickstart.md` step 2 — audio with no parseable amount, confirm no `Transaction` row and the clarification reply

**Checkpoint**: Guessing-is-worse-than-asking guarantee (FR-004/FR-005) is enforced.

## Phase 5: User Story 4 - Unlinked sender cannot log a transaction (Priority: P1)

**Goal**: An unrecognized Telegram sender can never create a transaction, under any household member.

**Independent Test**: `quickstart.md` step 3.

- [ ] T013 [US4] In the webhook route, move the `User.telegramId` lookup (from T009) to run *before* transcription/parsing — on no match, `sendMessage` with link-account instructions and return, without calling Groq or creating any row
- [ ] T014 [US4] Verify live per `quickstart.md` step 3 — voice message from an untracked `telegramId`, confirm zero `Transaction` rows created and the correct reply

**Checkpoint**: Hard security boundary (FR-008/FR-009) enforced independently of parse quality.

## Phase 6: User Story 2 - Log income by voice (Priority: P2)

**Goal**: Income-direction messages create income transactions, not expenses.

**Independent Test**: quickstart-equivalent scenario — voice stating money received (e.g. "отримав зарплату 15000").

- [ ] T015 [US2] Confirm `voiceParse.ts` (T006)'s income-keyword branch is exercised by the T009 happy path with no route-level changes needed — direction already flows into the created `Transaction` the same way for both directions (income transactions in this app are not a separate code path from expenses — same table, same `amount`, direction is implied by `Category.type`, matching how manual entry already works)
- [ ] T016 [US2] Verify live — simulated webhook with income-phrased test audio, confirm an income-categorized `Transaction`

**Checkpoint**: All four user stories independently verified.

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T017 [P] Verify idempotency per `quickstart.md` step 4 — same `file_unique_id` posted twice, confirm exactly one `Transaction` row
- [ ] T018 [P] Verify secret-token rejection per `quickstart.md` step 5 — missing/wrong header, confirm 200 with no row and no Telegram reply sent
- [ ] T019 Run `/selfcheck` against all new files (`src/lib/groq.ts`, `src/lib/telegramBot.ts`, `src/lib/voiceParse.ts`, `src/lib/categoryGuess.ts`, `src/app/api/webhooks/telegram/route.ts`) per Constitution Principle II
- [ ] T020 Run `/deep-review` against the same surface — pay particular attention to Category 9 (external push/webhook state modeling — is a Telegram webhook update always a "final" event, same question already asked of Monobank's `hold` field) and Category 5 (concurrency — two voice messages from the same sender in quick succession)
- [ ] T021 Run `node scripts/verify-data-integrity.mjs`, confirm 0 FAIL / 0 WARN after all test-data cleanup
- [ ] T022 **Blocked on Ф7**: register the production webhook via Telegram's `setWebhook` API with the `secret_token` set to `TELEGRAM_WEBHOOK_SECRET` — cannot happen until a real bot exists; everything else in this feature can be built and verified without it (per `quickstart.md`'s "what can be verified before Ф7" section)

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
