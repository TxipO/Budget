# Feature Specification: Voice Transaction Logging

**Feature Branch**: `001-voice-transaction-logging`

**Created**: 2026-07-08

**Status**: Draft

**Input**: User description: "Voice control via the Telegram bot for logging transactions. A household member who has already linked their Telegram account sends a voice message to the bot — e.g. saying \"потратив 200 гривень на каву\" or \"отримав зарплату 15000\". The bot transcribes the voice message, extracts the amount, whether it's income or an expense, and a best-guess category (reusing the existing category-guessing logic already built for Monobank: rule → MCC/keyword → fallback), creates the transaction attributed to that Telegram-linked user, and replies confirming what was logged (amount, category, who) so the person can catch a misheard transcription before it's wrong in their budget. If the bot can't confidently parse the amount or action from the transcription, it replies asking for clarification instead of guessing and silently logging something wrong. This depends on a real registered Telegram bot receiving webhook updates for voice messages, and on the user already being linked to a household member account — an unlinked sender's voice message should not silently create a transaction under nobody's name."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Log an expense by voice (Priority: P1)

A linked household member sends a short voice message to the bot describing a purchase — amount, and optionally what it was for. The bot transcribes it, creates an expense transaction attributed to them, and replies with a confirmation showing the amount, guessed category, and who it was logged under.

**Why this priority**: This is the entire point of the feature — logging a transaction hands-free, faster than opening the app. Without this, there is no feature.

**Independent Test**: Send a voice message saying "потратив 200 гривень на каву" from a linked account; verify a new expense transaction of 200 appears for that user, and the bot's reply names the amount and a plausible category.

**Acceptance Scenarios**:

1. **Given** a linked user sends a voice message clearly stating an amount and that money was spent, **When** the bot processes it, **Then** an expense transaction is created for that amount, attributed to that user, categorized via the existing rule → MCC/keyword → fallback logic, and the bot replies confirming amount, category, and who.
2. **Given** the confirmation reply shows a category that doesn't match what was meant, **When** the user corrects it in the app afterward, **Then** the correction is available to the same category-learning mechanism already used for Monobank corrections, so future similar messages guess better.

---

### User Story 2 - Log income by voice (Priority: P2)

A linked household member sends a voice message describing money received (salary, a gift, etc.). The bot creates an income transaction instead of an expense.

**Why this priority**: Income logging is less frequent than expenses but is part of the same mental model — without it, the feature only half-replaces manual entry.

**Independent Test**: Send a voice message saying "отримав зарплату 15000" from a linked account; verify a new income transaction of 15000 appears for that user.

**Acceptance Scenarios**:

1. **Given** a linked user sends a voice message clearly indicating money was received, **When** the bot processes it, **Then** an income transaction is created for that amount and attributed to that user.

---

### User Story 3 - Bot asks instead of guessing when unsure (Priority: P1)

When the transcription doesn't clearly state an amount, or doesn't make clear whether money was spent or received, the bot does not create a transaction. It replies asking the sender to clarify or resend.

**Why this priority**: A silently wrong transaction (wrong amount, or expense logged as income) is worse than no transaction — it corrupts the budget data and may not be noticed for weeks. This is a correctness/trust requirement, not a nice-to-have.

**Independent Test**: Send a voice message with mumbled or ambiguous content (no clear number, or unclear whether spent/received); verify no transaction is created and the bot's reply asks for clarification rather than logging a guess.

**Acceptance Scenarios**:

1. **Given** the transcription contains no parseable amount, **When** the bot processes it, **Then** no transaction is created and the bot replies asking the sender to state the amount.
2. **Given** the transcription contains an amount but no clear signal of income vs. expense, **When** the bot processes it, **Then** no transaction is created and the bot replies asking whether it was spent or received.

---

### User Story 4 - Unlinked sender cannot log a transaction (Priority: P1)

Someone who has not linked their Telegram account to a household member sends a voice message to the bot. No transaction is created under any account.

**Why this priority**: Without this, a stranger (or a wrong-number message) could silently corrupt someone's real budget data under nobody's — or the wrong — name. This is a hard security boundary, not a UX nicety.

**Independent Test**: Send a voice message from a Telegram account that has never completed the linking flow; verify no transaction is created anywhere in the system, regardless of how clearly the message states an amount.

**Acceptance Scenarios**:

1. **Given** the sender's Telegram identity is not linked to any household member, **When** they send a voice message, **Then** no transaction is created, and the bot replies directing them to link their account first (see Assumptions).

---

### Edge Cases

- What happens when the voice message is silent, corrupted, or otherwise fails to transcribe at all? → No transaction created; bot replies that it couldn't understand the message and asks the sender to try again.
- What happens when the same voice message is somehow delivered twice by Telegram (retry/duplicate webhook delivery)? → Must not create two transactions for one spoken event.
- What happens when the stated amount is zero, negative, or absurdly large (e.g. a misheard "200" transcribed as "200000000")? → Treated as a low-confidence parse; bot asks for confirmation rather than logging it outright.
- What happens when the message mixes multiple amounts (e.g. "купив за 200, здачі отримав 50")? → Out of scope for v1 (see Assumptions) — treated as ambiguous, bot asks the sender to send one transaction per message.
- What currency is assumed when none is stated? → The household's home currency (UAH/гривня); see Assumptions.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept voice messages sent to the Telegram bot by a Telegram identity already linked to a household member account.
- **FR-002**: System MUST transcribe the voice message to text using Groq's Whisper API (free tier). This is the project's first third-party AI dependency — voice audio leaves to Groq's servers for transcription only; no other external AI/LLM dependency is introduced by this feature. Chosen over self-hosting because Vercel serverless (no GPU, execution-time limits, no long-lived process) cannot run Whisper inference itself, and standing up a separate always-on server for one feature is disproportionate for this app's scale.
- **FR-003**: System MUST extract from the transcription: a monetary amount, and whether it represents income or an expense.
- **FR-004**: System MUST NOT create a transaction when the amount cannot be confidently extracted; it MUST instead reply asking the sender to clarify.
- **FR-005**: System MUST NOT create a transaction when income-vs-expense cannot be confidently determined; it MUST instead reply asking the sender to clarify.
- **FR-006**: System MUST guess a category for the transaction using the existing rule → MCC/keyword → fallback logic already built for Monobank category guessing, adapted to work from transcribed text instead of a merchant description.
- **FR-007**: System MUST attribute the created transaction to the household member linked to the sending Telegram identity.
- **FR-008**: System MUST NOT create any transaction when the sending Telegram identity is not linked to a household member account.
- **FR-009**: System MUST reply to an unlinked sender directing them to link their account, without creating a transaction.
- **FR-010**: System MUST reply to every successfully logged transaction confirming the amount, category, and which household member it was logged under.
- **FR-011**: System MUST be idempotent against duplicate webhook delivery of the same voice message — the same spoken event must not produce two transactions.
- **FR-012**: System MUST record which subsystem created a transaction (matching the existing `source` field pattern already used to distinguish manual/import/recurring/Monobank transactions), so voice-logged transactions can be told apart from other sources for the existing double-counting safeguards.

### Key Entities

- **Voice transaction message**: A single incoming voice message from a linked Telegram identity — has a transcription outcome (text or failure), a parsed amount, a parsed direction (income/expense), a guessed category, and a resulting transaction (or none, if clarification was needed).
- **Transaction** *(existing entity)*: Extended in usage, not in shape — voice-logged transactions are ordinary transactions with `source` identifying them as voice-originated and `userId` set to the linked household member.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A household member can log a simple expense (clear amount, clear category) by voice in under 15 seconds end-to-end (send message → transaction exists → confirmation received), without opening the app.
- **SC-002**: At least 90% of clearly-spoken voice messages stating an amount and income/expense direction result in a correctly created transaction on the first attempt (no clarification round-trip needed).
- **SC-003**: 0% of voice messages from unlinked senders result in a created transaction, under any circumstance.
- **SC-004**: 0% of ambiguous voice messages (unparseable amount or unclear direction) result in a silently-wrong transaction — every such case either asks for clarification or is rejected, never guessed.

## Assumptions

- **Currency**: No currency is stated in voice messages; all amounts are assumed to be in the household's home currency (UAH), matching how the rest of the app already treats amounts.
- **Language**: The household speaks Ukrainian, English, and Russian interchangeably, so transcription and direction-parsing both support all three (Whisper's language auto-detection, plus keyword lists in all three languages) rather than assuming Ukrainian only. Bot replies stay Ukrainian regardless of which language the voice message was in, matching this project's Ukrainian-only UI-text constraint.
- **One transaction per message**: A voice message describes exactly one transaction. Messages describing multiple amounts/events are treated as ambiguous (see Edge Cases) rather than split automatically — this can be revisited in a later iteration if it turns out to be a common real usage pattern.
- **Audio retention**: Voice audio is used only to produce a transcription and is not retained afterward — consistent with this project's existing data-minimization posture (e.g. Monobank tokens are encrypted at rest, never logged in plaintext).
- **Scope of correction**: The bot's confirmation message is the only in-chat feedback loop; correcting a wrong category or amount after the fact happens in the existing web app (which already has edit/delete UI), not via further chat commands. A voice "undo last" command is out of scope for v1.
- **DM only**: This feature operates in a private Telegram chat between the household member and the bot, not in group chats.
- **Depends on Ф7**: This feature requires a real, registered Telegram bot (the same one from the prior Telegram-auth work) capable of receiving webhook updates for voice messages — it cannot be verified end-to-end until that bot exists. Everything up to and including the parsing/categorization/transaction-creation logic can be built and unit-verified beforehand; only the live Telegram round-trip and the transcription call are blocked on that dependency (a bot is needed to receive voice messages at all).
- **Depends on a Groq API key**: Transcription (FR-002) requires a `GROQ_API_KEY` — a new external credential, configured the same way `TELEGRAM_BOT_TOKEN` and `MONO_TOKEN` already are (Vercel env var, never committed).
