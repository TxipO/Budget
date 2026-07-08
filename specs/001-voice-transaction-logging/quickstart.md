# Quickstart: Verifying Voice Transaction Logging

Mirrors the exact live-verification pattern already used this session for the Monobank webhook and the Telegram Login Widget — simulated payloads against the real DB, not a mocked test suite (this repo has no test framework; see plan.md's Testing strategy).

## Prerequisites

- `GROQ_API_KEY` set (local `.env` for dev verification; Vercel env var for production — never committed, same discipline as `TELEGRAM_BOT_TOKEN`).
- `TELEGRAM_BOT_TOKEN` already set (from the Ф1–Ф6 Telegram-auth work).
- A test `User` row with a known `telegramId` linked (the same disposable-test-user pattern used throughout this session — create, test, delete, verify no residue via `verify-data-integrity.mjs`).

## Steps this feature's implementation must be able to pass

1. **Full happy path (US1/US2)**: POST a simulated Telegram webhook update to `/api/webhooks/telegram` with a `voice` object pointing at a short pre-recorded test audio file saying a clear amount and direction (e.g. "потратив 200 гривень на каву"). Expect: a `Transaction` row created with `amount: 200`, correct `userId`, a plausible `categoryId`, `source: 'voice'`, and a Telegram `sendMessage` call confirming it.
2. **Clarification path (US3)**: same, but with audio that says something with no parseable amount. Expect: no `Transaction` row created, a `sendMessage` reply asking for the amount.
3. **Unlinked sender (US4)**: same voice audio as step 1, but `message.from.id` is a Telegram id with no matching `User.telegramId`. Expect: no `Transaction` row created anywhere in the table (not even unattributed), a `sendMessage` reply directing them to link their account.
4. **Duplicate delivery (FR-011)**: POST the exact same webhook update twice (same `file_unique_id`). Expect: exactly one `Transaction` row after both requests, both requests return 200.
5. **Secret token check** (contracts/telegram-webhook.md): POST without the correct `X-Telegram-Bot-Api-Secret-Token` header. Expect: 200 (no information-revealing error), no `Transaction` row, no Telegram reply sent.

## Cleanup

Delete any test `Transaction`/`User` rows created during verification; re-run `node scripts/verify-data-integrity.mjs` and confirm 0 FAIL / 0 WARN before considering the feature done — matching this session's established practice, and the "Data Integrity Across Migrations" review category this project already applies.

## What can be verified before a real bot exists (Ф7)

Steps 1–4 all exercise `/api/webhooks/telegram` directly via a simulated POST — they do **not** require a real Telegram bot to be registered, only a valid `TELEGRAM_BOT_TOKEN`/`GROQ_API_KEY` and a real short audio clip to transcribe. Only the true end-to-end path (a real person speaking into a real Telegram client) is blocked on Ф7.
