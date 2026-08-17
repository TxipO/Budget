---
name: fullreview
description: >
  The single code-quality command for this project — mechanical grep sweep,
  per-file reasoning pass, security lens, and whole-system invariant +
  data-reconciliation audit, in one staged run. Invoke for "повний чек коду",
  "перевір все", "фул ревʼю", "аудит", a pre-release pass, or after any week
  with data-corruption incidents. Supports `quick` (stage 1 only) and `deep`
  (all stages incl. live reconciliation) — default runs stages 1-3.
---

# Full review

Budget tracker: Next.js 14 + Prisma + Postgres/Neon, deployed on Vercel
serverless. ~12k LOC, 46 API routes, 27 lib modules, 5 external integrations
(Monobank, Enable Banking/SpareBank 1, Telegram, Groq, email). Project root
`C:\Users\doter\Budget`, source in `src/`.

Replaces the former `/selfcheck`, `/deep-review`, `/full-review` and
`/audit` skills — same content, one entry point. `/verify-export` stays
separate (it's an export-artifact pipeline, not code review, and has its own
standing rule in memory).

## Modes

| Invocation | Stages | When |
|---|---|---|
| `/fullreview quick` | 1 | After a small change; cheap, minutes |
| `/fullreview` | 1 → 2 → 3 | Default. A real review pass |
| `/fullreview deep` | 1 → 2 → 3 → 4 | Periodic health check, or after data-corruption incidents |

**The cheap→expensive gradient is the point, don't collapse it.** Stage 1 is
grep-only and must never start reading files in full; stage 2 reads
everything and must never degrade into grep-and-report. Running stage 2 on a
bug a grep would have caught in seconds is waste; running stage 1 and
calling it a review is theatre. Do the stages in order and carry findings
forward — later stages cover the fixes made by earlier ones.

---

# Stage 1 — Mechanical sweep (grep only)

**Token rule: Grep only.** Never Read a file unless a match genuinely needs
5+ lines of context to judge, and then read only that range. No full-file
reads in this stage.

Patterns are listed as fenced blocks, not a table, deliberately — several
contain `|` (alternation), which a markdown table cell would split, and
escaping it to `\|` for rendering would silently turn alternation into a
literal pipe and make the check match nothing.

**1. Unhandled HTTP errors** — `src/**/*.{ts,tsx}`. Bug unless preceded by `if (!r.ok)`.
```
\.then\(r => r\.json\(\)\)
```
**2. Silent fetch failures** — `src/**/*.{ts,tsx}`. Bug if that chain has no `.catch(`.
```
fetch\(
```
**3. Unvalidated numeric parse** — `src/app/api/**/*.ts`. Bug unless wrapped in `Number.isFinite(`.
```
parseInt\(|parseFloat\(
```
**4. Debug leftovers** — `src/**/*.{ts,tsx}`. Candidates for removal.
```
console\.log\(
```
**5. Type escapes** — `src/**/*.{ts,tsx}`. Report all; skip tests and comments.
```
as any
```
**6. Stuck spinners** — `src/**/*.tsx`. Bug if no `finally`/`catch` resets it.
```
setLoading\(true\)
```
**7. Missing effect deps** — `src/**/*.tsx`. Read ±8 lines; a referenced state/prop absent from the deps array is a bug.
```
useEffect\(
```
**8. Raw SQL** — `src/**/*.ts`. Review each for injection.
```
prisma\.\$queryRaw|prisma\.\$executeRaw
```
**9. Unawaited async** — `src/**/*.tsx`. Async fn called with no await/catch.
```
^\s+[a-zA-Z]+\(.*\);$
```
**10. Month off-by-one** — `src/app/api/**/*.ts`. Check 0-indexed month used consistently.
```
new Date\(.*month
```
**11. Module-level mutable state** — `src/app/api/**/*.ts`. See note below.
```
^(let|var) [a-zA-Z]
```
**12. Neon pooled endpoint** — `grep DATABASE_URL .env`. Hostname must contain `-pooler`. See note.

**13. Silent numeric fallback** — `src/**/*.ts`. See note.
```
\?\? [01]\b
```
**14. Host-header trust** — `src/**/*.ts`, case-insensitive. Bug only if the URL leaves the app. See note.
```
nextUrl\.origin|headers\.get\(.host.\)|x-forwarded-host
```
**15. Unscoped User select** — `src/**/*.ts`. Leaks secrets. See note.
```
user: true|prisma\.user\.findMany\(\)
```
**16. Expired-precondition candidates** — `src/**`, case-insensitive. Feed the hits into Stage 4B. Verified live: ~10 hits across 7 files, a reviewable number rather than noise.
```
if .* ever|поки що|for now|currently only|correct today|тимчасов|revisit|ponytail:|would need to
```

Notes on the ones with a real incident behind them:

- **#11** Vercel gives no shared memory across invocations/isolates. Rate
  limits, counters, caches, locks in module state silently stop working in
  prod while passing locally. Real case: the brute-force lockout counter,
  moved to Postgres. Fix = persist in the DB, never a module variable.
- **#12** The direct (non-pooled) Neon endpoint has a low connection ceiling
  that concurrent serverless invocations exhaust. Treat a missing `-pooler`
  as Critical; fix `.env` *and* the Vercel env var, then redeploy.
- **#13** `?? 0`/`?? 1` is fine for a genuine optional default; it's a bug
  when the fallback is a *plausible* value in a money/rate context. Real
  case: `fxRate = (await getCachedExchangeRate(...)) ?? 1` silently recorded
  a ~4-5x wrong amount. Fix = throw, don't substitute.
- **#14** `req.nextUrl.origin` reflects the client's Host header. Fine for
  internal routing; a bug when the resulting URL is handed to a third party
  (webhook registration, OAuth redirect, email link). Real case:
  `api/monobank/connect` — fixed with `getAppOrigin()` from Vercel's
  non-spoofable system env vars.
- **#15** `include: { user: true }` returns every column including
  `monoTokenEnc` and the plaintext `monoWebhookSecret` — leaking the latter
  lets an attacker post fake transactions to that user's webhook receiver.
  Real case: 9 call sites. Fix = explicit `select: { id, name }`.

Fix every Critical immediately without asking. Commit.

---

# Stage 2 — Reasoning pass (read files in full)

**Don't grep-and-report.** Read the relevant files fully, trace actual data
flow, and ask the "what if the assumption breaks" question. Read cross-file —
a bug's cause and its symptom are usually in different files.

Canonical case for why this stage exists: every API route computed month
boundaries with `new Date(year, month, day)`, silently using the process's
local timezone. Syntactically fine, passed every grep, worked for months —
because the dev machine (Europe/Kyiv) and the only runtime shared a timezone.
It broke the day it deployed to Vercel (UTC), shifting transactions across
month boundaries and corrupting real financial totals.

Read `src/app/api/**/*.ts` and `src/lib/**/*.ts` in full — that's where money
math, dates, crypto and external-API clients live. Then actively look for:

1. **Environment-dependent behavior.** Anything whose result depends on
   *where* the code runs rather than what the data says: `new Date(y,m,d)`,
   `.getMonth()` instead of UTC variants, unfixed locales, `process.cwd()`,
   timeouts that differ between local Node and serverless. Would this give
   the same answer in Kyiv, in UTC, on Windows, on Vercel's Linux?
2. **Serverless/deployment mismatches.** Anything assuming a long-lived
   process: in-memory caches, accumulating singletons, `setInterval`
   expected to survive requests, filesystem writes expected to persist.
3. **Data integrity across migrations.** This app went SQLite → Postgres and
   through several repair passes. Do all FKs resolve? Unique constraints
   hold? Impossible values (negative amounts, out-of-range dates, orphaned
   `recurringTemplateId`)? Spot-check with real queries, not schema reading.
4. **Boundary/off-by-one.** Date range edges, `page * PAGE_SIZE`, slicing,
   Dec→Jan rollover, Feb 29. Write out a concrete example per range query
   and check the edge by hand.
5. **Concurrency.** Two tabs / two people acting at once: double-submit, the
   5s undo window colliding with a real delete, optimistic UI racing the
   server, `Promise.all` where one failure should roll back others.
6. **Silent data loss.** Empty catches, `.catch(() => {})` on *writes*,
   partial success reported as full success, defaults masking real errors.
7. **Trust boundaries.** Client data reaching a query/write without
   validation a previous reviewer assumed was "obviously fine" — re-check
   the assumption, don't just confirm a validator is called.
8. **Two subsystems modelling one real event.** Found live: Excel-plan import
   and the recurring-template button both wrote a transaction for the same
   rent payment, each assuming it was the only writer. For every place that
   writes a `Transaction`: what *other* path could write the same real-world
   event?
9. **"Delivered" ≠ "final".** For every external push source: what states
   does the sender's own model distinguish (pending/hold vs settled), and
   does the handler treat them the same? Found live: the Monobank webhook
   processed `hold: true` provisional authorizations as if settled.
10. **Host-header trust** — same as grep #14, but reasoned: trace whether the
    built URL actually leaves the app.

Two rules learned the hard way, apply them throughout:

- **A valid-looking wrong value is more dangerous than a crash.** For every
  fallback, don't ask "does this crash" — ask "if this default is wrong,
  does *anything* ever notice?" If no, it should fail loudly instead.
- **A data-repair scope is only as good as its WHERE clause.** Write the
  detection query as broadly as the bug's actual *mechanism*, not as
  narrowly as the first example you found. Precedent: a timezone repair
  filtered on `details = '[імпорт]'` and missed an identically-corrupted
  recurring-generated row.

Prove each candidate with a concrete failing example or a live query.
Distinguish **confirmed** (proven) from **suspected** (plausible,
unverified) and label them differently. Fix confirmed immediately; surface
suspicions, don't fix speculatively.

---

# Stage 3 — Security lens

Runs last of the standard stages so it also covers fixes just made. Project
surface, not a generic checklist:

- **Auth & session.** `lib/session.ts` cookie format and HMAC input,
  `middleware.ts` fail-closed when `AUTH_SECRET` is missing, issued-at
  binding, server-side expiry, `Secure`, constant-time comparison for PIN
  hash and signature. Middleware must stay crypto-only (Edge, no Prisma).
- **Multi-tenant isolation (IDOR).** Every query scoped by `householdId`;
  `x-current-user-id` / `x-current-household-id` always decided server-side,
  never trusted from the client. Verify no `Transaction`/`Category`/
  `MonthlyPlan` read or write can reach another household's rows — including
  via a `[id]` route param. Confirm with a real cross-household query.
- **Webhooks.** `/api/webhooks/monobank/[secret]` — secret is the only
  gate and is stored in plaintext, so check #15 leakage first. Telegram
  webhook HMAC verification. Neither has a session; both must resolve
  `userId`/`householdId` from the looked-up record, never from the payload.
- **Secrets.** `monoTokenEnc`/`sbSessionEnc` AES-256-GCM via `lib/crypto.ts`,
  never logged, never returned. `ENABLE_BANKING_PRIVATE_KEY_B64`,
  `CRON_SECRET` (constant-time compare), `GROQ_API_KEY`, `OBSIDIAN_API_KEY`
  never in responses or client bundles.
- **Error text.** No raw exception strings to the client (real case:
  `import/route.ts`).
- **Headers.** CSP, X-Frame-Options and friends still present.
- **Dependencies.** `npm audit` — triage, don't auto-bump majors.

The built-in `/security-review` is still available for a diff-scoped pass;
this stage is the standing surface, not a replacement for reviewing a
specific change.

---

# Stage 4 — System invariants & reconciliation (`deep` mode)

The axis the first three stages structurally cannot cover. They're all
*code-centric*: read code, find the wrong line. Every serious incident here
was **a correct line whose surrounding truth changed**:

| Where the bug actually lived | Real example |
|---|---|
| Between code and the external world | `entry_reference` reshuffles on every re-fetch |
| Between code and its own past | `/^від: /i → 'Паша'` was right with one Monobank user |
| Between two subsystems modelling one thing | mono vs sparebank dedup/transfer logic diverged |
| Between code and the data it already wrote | DB held rows today's code would never produce |

## 4A — External-field trust decay

For every third-party field used as an **identity, matching key, or stable
label**, the question isn't "is it present" but "is it still the same thing
it was last week". Two live failures, both from fields believed stable:

- `entry_reference` was checked twice **seconds apart**, matched, adopted as
  the dedup key — then SpareBank 1 turned out to reshuffle a whole day's
  numbering on every re-fetch, with no old→new relationship.
- `remittance_information` carried `"*0506 12.08 NOK 49.50 NORSK
  REISELIVSMUSEUM Kurs: 1.0000"` at ingest and `"NORSK REISELIVSMUSEUM"`
  later — the bank enriches text after settlement, and the card-auth form
  embeds that purchase's own amount and date, making it unique per row.

**"Verified stable" means re-fetched after enough elapsed time for the
provider to settle, enrich, re-sort and renumber — days, not seconds.**
Confirmed stable so far: `amount`, `booking_date`,
`credit_debit_indicator`. Everything else is suspect until re-proven.

## 4B — Expired preconditions

Code that was correct when written and silently became wrong as the system
grew. Highest-frequency class here, and the most avoidable, because **the
code usually says so itself and nobody came back.** The canonical case
carried a comment reading *"if Женя's card is ever connected too, this would
need to stop being a blanket rule"* — she connected five weeks later, and
three of her transfers were misattributed before a human noticed.

Take grep #16's hits and answer literally, per hit: **has the condition it
names already come true?** Not "could it" — has it. Check the DB and config,
don't reason from memory. Standing instances to re-check every pass:

- `selfAccountId > transferAccountId` (`sparebankIngest.ts`) — ordinal proxy
  for "which account is the savings pool", correct only because Основний
  (id 1) predates Подушка (id 2). Breaks on the opposite connection order.
- `findMonoTransferMatch`'s `userId: { not: userId }` — structurally blind to
  same-person cross-bank movement, a real pattern here (SpareBank NO →
  Monobank UA via Paysend).
- Any per-household assumption written while exactly one household existed.

## 4C — Blast radius of the fix itself

Before shipping any change to a **data-writing** path: not "is the premise
wrong" but "how bad is it when it is". Worst self-inflicted incident here: a
dedup patch assumed the bank shifts only the *tail* of a day's numbering and
"recovered" collisions by writing a new row. The real behavior was a *full*
reshuffle, so every item in every reshuffled day looked like a collision —
one sync produced four duplicates, and every later sync would produce more.
**A rare bug was converted into a systematic corruption engine, and shipped.**

Test: if the premise is inverted, does the failure stay bounded (one row, one
sync) or scale with volume (every row, every sync, forever)? A fix whose
failure mode scales is not safer than the bug. Prefer failing closed (skip,
log, surface) over "recovering" into a write.

## 4D — Data-vs-code divergence (highest-yield technique)

**Every incident left corrupted rows behind, and none were found by reading
code — all by reconciling stored data against the source of truth.**

1. Pull the **raw external feed** fresh, covering the full span of stored
   rows for that integration.
2. Recompute what today's code *would* produce for each raw item — reuse the
   real exported helper (e.g. `buildSbContentKeyBase`), never a
   reimplementation, or the audit drifts from production.
3. Match every stored row to a raw item by content, claiming each at most
   once.
4. **Rows with no raw match are the finding.** This surfaced three phantom
   duplicates code review had missed, and corrected a backwards assumption
   about which of two candidate rows was legitimate.

Without the external feed, also check: rows whose category today's
`guessCategoryId` would no longer produce; `MonoCategoryRule` entries keyed
on text that can never recur (embedded amounts/dates); ids whose shape
predates the current key scheme.

Then prove idempotency **live**: run a real sync twice in a row and require
zero rows created on both passes. Not a simulation — the real function
against the real feed. Only this catches "the feed changed under us between
two calls", which happened repeatedly.

## 4E — Cross-integration model divergence

The two bank integrations independently implement the same concepts; a
lesson learned on one side rarely reaches the other. Build this table each
pass and inspect every differing row:

| Concept | Monobank | SpareBank 1 |
|---|---|---|
| Dedup identity | `monoStatementId` (provider-unique) | content key (provider ids proved unstable) |
| Transfer detection | amount + opposite direction + **different** user | counterparty account number + mirror check |
| Category resolution | shared `guessCategoryId` | shared `guessCategoryId` |
| Provisional filter | `hold` flag | `status !== 'BOOK'` (`undefined` treated as final — open gap) |
| Money direction | sign of `amount` | `credit_debit_indicator` |

For each difference: forced by the provider's real semantics, or just an
accident of which was built first?

## 4F — Attribution: whose money is this

Every `Transaction` write needs a defensible answer to both "who owns this"
(`userId`) and "which bucket" (`categoryId`) — and the second must never
derive from a hardcoded person's name. Audit: does every income row's
category match the account that actually received the money? A
person-named category on a different person's row is this bug's signature.
Also re-check the unexplained 2026-07-31 finding of two rows attributed to
the wrong member (root cause never found) — if it recurs, fetch each user's
own raw statement and cross-check every row's provider id against its stored
owner's feed.

## 4G — Silent-fallback inventory

Stage 2 states the principle; this is the systematic sweep. Enumerate
**every** fallback in money/identity/attribution paths — `?? x`, `|| x`,
caught exceptions returning defaults, and the category-guess chain's final
tiers — and for each: *if this default is wrong, does anything notice?* The
generic `Додаткове` income bucket is the current one to watch: everything
unrecognized lands there, so it silently accumulates whatever the chain
failed to classify.

## 4H — Scheduled work actually running

A scheduled trigger reporting "success" only proves **delivery**, not that
the payload landed inside whatever condition the handler gates on. Found
live: the SpareBank cron showed 6 consecutive days of `success` in GitHub
Actions while every single response body was `{"skipped":"not a target
hour"}` — GH Actions' schedules run 55-70 min late, consistently missing an
exact-hour match. Check the **response bodies / log content** of real runs,
not their exit status. Same lens for anything gated on wall-clock time,
quotas, or a watermark.

## 4I — Quotas and cost

Recent additions put real external calls in hot paths. Verify none of them
can be hammered: Enable Banking's ~4/day **unattended** cap (attended calls
with PSU headers are a separate bucket — omitting those headers silently
downgrades every call), Monobank's ~1 req/60s statement limit, and the Groq
LLM tier now sitting in `guessCategoryId` — confirm it's still last before
the fallback and can't run per-item in a large backfill loop.

---

# Stage 5 — Verify, report, remember

1. `node scripts/verify-data-integrity.mjs` once at the end — not after each
   stage. Add `VERIFY_URL`/`VERIFY_PIN` to include the live-API cross-check.
   Extend this script whenever a new corruption class is found; it's the
   accumulated checklist from every past pass.
2. If any integration was touched, the twice-in-a-row live sync from 4D.
3. If anything user-visible changed, verify in the browser preview (login PIN
   flow) — don't ask the user to check manually.
4. **One consolidated report**, not one per stage.
5. Commit, push, deploy per the project's standing autonomous convention.
6. **Update memory** (`C:\Users\doter\.claude\projects\C--Users-doter-Budget\memory\`)
   even if unasked — a full pass is exactly when accumulated session work
   must land before context compaction. What qualifies: new subsystems, real
   bugs found (the failure mode and fix, not the diff), security-relevant
   findings. What doesn't: anything re-derivable from the repo or git
   history. **Supersede, don't append** — a memory file should read as the
   current state of an area, not a log of passes over it. Update
   `MEMORY.md`'s index line for anything touched, and mirror to Obsidian.

## Standing rules

- **Ask before deleting bank-sourced transactions**, every time — including
  when a similar case was approved earlier in the same session.
- **Never repair data on assumption.** Drive every fix from a match against
  the source of truth, not from inference about which row "looks" right.
  Doing exactly this caught a backwards assumption of mine.
- **N matching rows is corroborating, not confirming.** A query returning
  exactly the number of rows the user mentioned is not proof it found the
  right ones — mutating financial data on a plausible name match was a real
  mistake made here once.
- **Scratch scripts** go in the project root, run with `npx tsx`, and are
  deleted (`rm -f`) immediately after. Never left behind.
- **Don't build speculative infrastructure** during a review — surface the
  finding and ask.

## Report format

```
## Full review — <date>   [mode: quick | default | deep]

### Critical (fixed immediately)
- <stage> file.ts:42 — <what's wrong> — <the proof: example, query, or diff>

### Broken invariants (deep mode)
- <4A-4I> — <what no longer holds> — <evidence>
  Blast radius: <rows / period / still producing new ones?>
  Fix: <what changes, and what its own failure mode would be>

### Expired preconditions (condition already came true)
- file.ts:17 — <assumption> — <proof it's now met>

### Fragile but not yet broken (surfaced, not fixed)
- file.ts:88 — <assumption> — <what would break it>

### Warnings (review, not auto-fixed)
### Reviewed clean
<name the checks/categories that found nothing, so the next pass knows they
were run and not skipped>
```

## Feeding lessons back

A genuinely new bug **class** found during a pass goes into this file
immediately — grep-able → Stage 1's table, reasoning → Stage 2's list,
system-level → Stage 4. A new **instance** of an existing class goes in
memory only. This skill exists because the 2026-08-13→17 discoveries landed
in memory and never reached a skill, so the next pass would have re-learned
them from scratch. Don't repeat that.
