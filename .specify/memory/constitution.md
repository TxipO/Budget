<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Modified principles: n/a (initial ratification)
- Added sections:
  - Core Principles: I–VII (Fix Confirmed Bugs Immediately; Security Review
    Gates; Verify Live, Not Just Types; No Over-Engineering; Money and
    Fallbacks Fail Loudly; Environment-Independent Correctness; Explicit
    Data-Exposure Boundaries)
  - Product Direction & Constraints (Ukrainian-language UI; multi-tenant-
    ready groundwork)
  - Development Workflow (commit discipline)
  - Governance
- Removed sections: none (first fill of the template)
- Templates requiring updates:
  - .specify/templates/plan-template.md — ✅ no change needed (Constitution
    Check gate is already generic, pulls from this file at plan time)
  - .specify/templates/spec-template.md — ✅ no change needed (no
    constitution-specific references)
  - .specify/templates/tasks-template.md — ✅ no change needed (no
    constitution-specific references)
- Follow-up TODOs: none
-->

# Budget Constitution

## Core Principles

### I. Fix Confirmed Bugs Immediately
When a review (self-review, `/selfcheck`, `/deep-review`, or ad-hoc reading)
turns up a confirmed bug, fix it in the same pass. Do not write it into a
list of "potential improvements" and wait for approval — a confirmed defect
gets fixed, committed, and verified before the task is considered done.
Genuinely speculative or out-of-scope findings (a real gap, but not what was
asked) are surfaced and asked about instead of fixed unprompted.

**Rationale**: Deferred fixes accumulate as debt nobody revisits, and asking
permission to fix an already-proven bug adds a round-trip that produces no
new information — the fix is going to happen either way.

### II. Security Review Gates for Sensitive Work
Any change touching authentication, session handling, webhooks, external
API integrations, or money math MUST go through `/selfcheck` and
`/deep-review` before being considered done. This includes new endpoints
under `src/app/api/**` and anything in `src/lib/**`. A change in this
category is not "done" at type-check-passes; it is done after both review
skills report clean (or their findings are fixed and re-verified).

**Rationale**: This codebase has shipped real security regressions (a
brute-force lockout counter that silently stopped working once deployed
serverless; a fail-open middleware gap on Preview deployments) that passed
type-checking and looked correct on read. Grep-pattern and reasoning-based
review are complementary, not redundant.

### III. Verify Live, Not Just Types
A change is not verified by `tsc --noEmit` and `npm run build` succeeding.
Before reporting a change complete, exercise it at its actual runtime
surface — the dev server via the preview tools, a live curl/API call, or a
deployed URL — and capture what actually happened. Type-checks prove the
code compiles; they do not prove the feature works.

**Rationale**: Established directly from repeated practice this project —
every phase of the Monobank and Telegram-auth work was verified by actually
running the flow (signed test payloads, live widget clicks, DB queries
before/after), not by trusting a clean build.

### IV. No Over-Engineering
Do not add abstractions, feature flags, backwards-compatibility shims, or
validation for scenarios that cannot happen. Match the scope of a change to
what was actually requested — a bug fix does not need surrounding cleanup,
a one-shot script does not need a reusable helper. Trust internal code and
framework guarantees; only validate at real system boundaries (client
input, external APIs, webhooks).

**Rationale**: Three similar lines of code are cheaper to read and maintain
than a premature abstraction built for a fourth case that may never arrive.

### V. Money and Fallbacks Fail Loudly, Never Silently Guess
Money is stored as `Float` and MUST be rounded via `roundMoney()` at every
write boundary. Any fallback (`?? x`, `|| x`, a caught exception returning a
default) in a money, rate, or quantity context MUST be evaluated against one
question: if the fallback value is wrong, does anything downstream ever
notice? If the answer is no, the code MUST throw or return an error instead
of substituting a plausible-looking number.

**Rationale**: Proven live — `fxRate ?? 1` silently recorded real UAH
amounts as if already in the app's own currency (a ~4–5x understatement)
whenever the exchange-rate cache was unavailable, with no error anywhere. A
malformed payload that produced `NaN` was *safer* than this, because `NaN`
gets caught; a plausible float does not.

### VI. Environment-Independent Correctness
Code MUST behave identically regardless of where or how it runs:
- **Time**: use UTC-safe date arithmetic (`Date.UTC`, ISO boundaries) —
  never construct dates from local-timezone components
  (`new Date(y, m, d)`, `.getMonth()`/`.getDate()` for storage or
  comparison logic).
- **Process lifetime**: no module-level mutable state (counters, caches,
  locks) — Vercel serverless functions do not guarantee a shared process
  between invocations. Persist shared state in Postgres or another shared
  store.
- **Database**: `DATABASE_URL` MUST use Neon's pooled (`-pooler`) endpoint,
  never the direct endpoint, so concurrent serverless invocations don't
  exhaust the connection ceiling.

**Rationale**: This project was burned once for real — every API route
computed month boundaries with local-timezone `Date` math, which worked
perfectly for months because the dev machine (Kyiv) and the only deployment
target happened to agree, then silently corrupted real financial totals the
day it needed to disagree with Vercel's UTC runtime.

### VII. Explicit Data-Exposure Boundaries
Any Prisma query touching the `User` model MUST use an explicit `select` —
never a bare `findMany()`/`findUnique()` or an `include: { user: true }`
that pulls every column by default. `User` carries sensitive fields
(`monoTokenEnc`, `monoWebhookSecret`) that must never reach a client
response or get fetched unnecessarily, even when the result is otherwise
discarded server-side.

**Rationale**: Found and fixed live, more than once, across the Monobank
and Telegram-auth work — the default Prisma behavior is the unsafe one, so
this has to be an explicit habit, not an assumption.

## Product Direction & Constraints

**Language**: All user-facing UI text and strings are Ukrainian. This is a
hard product constraint, not a default that can drift per-feature.

**Multi-tenant-ready by design**: This is a 2-person household app today
(Паша/Женя), but auth and registration groundwork (Telegram login, email
collection, per-user sessions) is being built toward a future multi-tenant
product — that groundwork is a deliberate investment, not overkill for the
current 2-user scope. Features in this area should default to "works for
1, works for 2, and doesn't structurally block N" without spending effort
building N-user UI or infrastructure that isn't needed yet.

## Development Workflow

Commit messages explain **why** a change was made, not just what changed —
the diff already shows what changed. After a working session's changes are
verified (per Principle III), commit and push automatically without waiting
to be asked, unless the changes are exploratory/uncommitted-on-purpose or
the user has indicated otherwise for that session.

## Governance

This constitution supersedes ad-hoc practice when the two conflict. Amendments happen by editing this file directly (via `/speckit-constitution`) and require:
1. A stated reason for the change (new lesson learned, corrected assumption, or scope change).
2. A version bump per semantic versioning: MAJOR for backward-incompatible
   principle removals/redefinitions, MINOR for new principles or materially
   expanded guidance, PATCH for wording/clarification only.
3. Updating the Sync Impact Report at the top of this file.

Compliance is reviewed the same way the principles themselves are applied —
via `/selfcheck` and `/deep-review` for security-sensitive work, and via
direct reasoning for everything else. Complexity or a deviation from a
principle must be justified in the change itself (e.g. a plan's Complexity
Tracking section), not silently introduced.

**Version**: 1.0.0 | **Ratified**: 2026-07-08 | **Last Amended**: 2026-07-08
