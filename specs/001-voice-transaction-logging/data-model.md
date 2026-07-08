# Phase 1 Data Model: Voice Transaction Logging

No new tables. One additive, nullable column on the existing `Transaction` model — same shape as the Monobank integration's additions (`monoStatementId` etc.), backward compatible, safe via `prisma db push`.

## `Transaction` (existing model — extended)

| Field | Change | Purpose |
|---|---|---|
| `telegramMessageId` | **NEW**, `String? @unique` | Dedup key for FR-011 (idempotency against duplicate webhook delivery) — set to the Telegram voice message's `file_unique_id`. `null` for all non-voice transactions (manual/import/recurring/mono), matching how `monoStatementId` is already `null` for everything except Monobank-originated rows. |
| `source` | **Existing field, new value** | Gets a new value `"voice"` (existing default is `"manual"`; Monobank/import/recurring already use their own values). No schema change — `source` is already a plain `String`, not an enum. |
| `userId` | **Existing field, no change** | Set to the household member resolved from the sender's `telegramId` (FR-007). Never `null` for a voice-originated row (contrast with Monobank/manual rows, which can be unattributed) — FR-008 makes attribution mandatory as a precondition of creating the row at all. |
| `categoryId` | **Existing field, no change** | Set via the generalized `lib/categoryGuess.ts` (see research.md #5). |
| `amount`, `date`, `details` | **Existing fields, no change** | `amount` via `roundMoney()` at the write boundary (Constitution V). `date` = webhook-receipt time. `details` = the raw transcript (useful for the sender to see exactly what the bot heard, and for future category-rule learning). |

## `User` (existing model — read-only for this feature)

| Field | Usage |
|---|---|
| `telegramId` | Looked up to resolve sender → household member (FR-007, FR-008). Already exists from the Telegram-auth work; no change needed. |

## No new entity for "pending clarification" state

FR-004/FR-005 (bot asks instead of guessing) do **not** need a persisted "pending" record — the clarification round-trip is stateless: the bot replies asking the sender to resend with the missing information, and the *next* voice message is processed fresh, independent of the one that triggered clarification. This keeps the feature free of a new state machine, consistent with Constitution Principle IV (no over-engineering) — a stateful "conversation in progress" concept is not needed for a single-turn clarification ask.

## Schema change required

```prisma
model Transaction {
  // ...existing fields...
  telegramMessageId String? @unique  // NEW
}
```

Applied via `npx prisma db push --accept-data-loss` (safe for a nullable unique column — Postgres allows multiple `NULL`s under a unique constraint, matching the exact precedent already established for `monoStatementId`/`monoWebhookSecret` in this project).
