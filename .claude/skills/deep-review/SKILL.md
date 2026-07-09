# Deep review skill

Budget tracker (Next.js 14 + Prisma + Postgres/Neon, deployed on Vercel serverless).
Project root: `C:\Users\doter\Budget`, source in `src/`.

**This is not `/selfcheck`.** `/selfcheck` runs fixed grep patterns for known bug shapes (missing `.ok`, missing `.catch`, etc.) in a couple minutes. This skill looks for the bugs grep *can't* find — ones that require actually reasoning about what the code does, not matching a syntax pattern. Budget more time and more Read calls; token-frugality is not the point here.

**Canonical example — why this skill exists:** every API route computed month boundaries with `new Date(year, month, day)`, which silently uses the Node process's local timezone. That's syntactically fine, passes every grep check, compiles, and worked perfectly for months — because the dev machine (Windows, Europe/Kyiv) and the only place code ran shared one timezone. It broke the day the app deployed to Vercel (UTC), silently shifting transactions across month boundaries and corrupting real financial totals. No grep pattern catches "this is correct only because two environments happen to agree" — only reading the code and asking "what if this ran somewhere else, with different ambient state?" does.

## Method

Don't grep-and-report. For each area below: **read the relevant files fully**, trace the actual data flow, and ask the "what if the assumption breaks" question. Read cross-file — a bug's cause and its symptom are often in different files (the timezone bug's cause was in `stats/route.ts`, its symptom was in what the dashboard displayed).

## Categories to reason through

### 1. Environment-dependent behavior
Anything whose result depends on *where* the code executes rather than *what the data says*: system timezone (`new Date(y,m,d)`, `.getDate()`/`.getMonth()` instead of UTC variants), locale (`toLocaleDateString` without a fixed locale where consistency matters), machine-specific paths, `process.cwd()` assumptions, default timeouts that differ between local Node and serverless. Ask: would this produce the same result if run in Kyiv vs UTC vs any other TZ? On Windows vs the Vercel Linux runtime? Same failure shape, different constructor: `new Date(arbitraryString)` for a non-ISO string is also environment-dependent — `"7/8/2026"` and `"08.07.2026"` parse to *different calendar days or months* depending on the runtime's locale/TZ interpretation. Found live in `import/route.ts`'s `cellDate()`, which fell back to this for any Excel cell that wasn't already a `Date` object. Fix = accept only an unambiguous format (ISO `YYYY-MM-DD`) and construct explicitly via `Date.UTC(y, m-1, d)`; anything else returns `null` (row skipped) rather than risking a silently wrong date. Any bare `new Date(someString)` where `someString` isn't guaranteed ISO-formatted is suspect for the same reason.

### 2. Serverless/deployment mismatches
Already have two confirmed real bugs of this class this session (module-level mutable state for rate-limiting; non-pooled DB connection). Look for more: anything that assumes a long-lived process (in-memory caches, singletons that accumulate state, setInterval/setTimeout expected to survive across requests), assumptions about cold start vs warm invocation, file-system writes expected to persist (Vercel's filesystem is ephemeral outside `/tmp`).

### 3. Data integrity across migrations
This app has been through a SQLite -> Postgres migration and a data-repair pass. Check: do all foreign keys still resolve (no orphaned rows)? Do unique constraints hold? Are there rows with impossible values (negative amounts where positive is required, dates outside sane ranges, orphaned `recurringTemplateId` pointing at soft-deleted templates)? Spot-check with real queries against the live Neon DB, not just schema review.

### 4. Boundary and off-by-one logic
Date ranges (inclusive/exclusive edges), pagination (`page * PAGE_SIZE` math), array slicing, month/year rollover (December -> January, leap years for Feb 29). For each range query, write out a concrete example and check the edge manually rather than trusting the code reads correctly.

### 5. Concurrency and race conditions
Two browser tabs / two users (Паша and Женя) acting at once: double-submit on forms, the undo-delete 5s window colliding with a real delete, optimistic UI updates racing with server responses, `Promise.all` where one failure should roll back others but doesn't.

### 6. Silent data loss or corruption paths
Places where a caught exception discards information without surfacing it (empty catch blocks, `.catch(() => {})` on writes not just reads), places where partial success is reported as full success, places where a default/fallback value masks a real error (e.g., `?? 0` hiding a failed lookup that should have blocked the operation).

### 7. Trust boundary violations
Any place client-supplied data reaches a query or write without validation that a previous reviewer might have assumed was "obviously fine" — re-check assumptions, don't just check presence of a validation function call.

### 8. Independent subsystems modeling the same real-world concept
Found live: the Excel-plan import and the recurring-template "Застосувати" button both independently write a transaction for "this category, this month" with no awareness of each other — so the same real payment (rent) got counted twice, once from each source. This isn't a race and isn't a validation gap; it's two features that each assume they're the only writer. Ask, for every place the app writes a transaction: what *other* code path could also write a transaction meaning the same real-world event? Cross-reference `details === '[імпорт]'` rows against `recurringTemplateId !== null` rows for the same category+month as one concrete check; there may be other pairs of subsystems with the same shape.

### 9. External push/webhook state modeling — is "delivered" the same as "final"?
Any integration that receives push events from an external system (Monobank's webhook now; a future Telegram bot is the same shape) needs to ask: does this event represent a *finalized* real-world fact, or a *provisional* one that can still be reversed? Found live: the Monobank webhook handler processed every `StatementItem` it received, including ones with `hold: true` — a provisional card authorization (a fuel-pump pre-auth, a hotel deposit hold) that can be declined or cancelled without ever settling. Recording it immediately risked a phantom transaction if it never settled, or a duplicate if it settled later under a different id. The fix wasn't validation (the payload was well-formed) or a race condition — it was failing to model that "we received a webhook" and "this is a completed event" are different claims. For every external push source: what states does the sender's own data model distinguish (pending/held/authorized vs settled/confirmed/final), and does the handler treat all of them the same?

### 10. Host-header trust for anything sent to a third party
Any URL built from `req.nextUrl.origin`, `req.headers.get('host')`, or `x-forwarded-host` and then handed to an external service (a webhook registration, an OAuth redirect_uri, a password-reset link) is trusting client-supplied input for something a third party will act on. Found live: `api/monobank/connect` built the Monobank webhook callback URL from `req.nextUrl.origin` — an authenticated session (including a hijacked one, e.g. via a future XSS bug) could in principle register the webhook against an attacker-controlled domain and silently exfiltrate every future transaction. Using `req.nextUrl` for *internal* routing/redirects is fine; the question is specifically whether the resulting value leaves the app. Fix: build such URLs from platform-injected, non-request-derived values (Vercel's `VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL` system env vars), never from anything read off the incoming request.

## A rule learned the hard way: a valid-looking wrong value is more dangerous than a crash
Found live: `fxRate = (await getCachedExchangeRate(...)) ?? 1` — when the exchange rate was genuinely unavailable (no cache yet, external rate endpoint down), the code silently used `1.0` as the rate, recording a real UAH amount as if it were already in the app's own currency (a ~4-5x understatement). Compare this to a sibling bug tested in the same session: a malformed webhook payload with a missing `amount` field produced `NaN`, which Prisma's own client validation rejected outright, converting it into a clean 500 with no data written. The `NaN` case was *safer* than the `fxRate ?? 1` case specifically because NaN is obviously wrong and gets caught; `1.0` is a completely ordinary, valid-looking float that nothing downstream can distinguish from a real fetched rate. When reviewing a fallback (`?? x`, `|| x`, a caught exception that returns a default), don't just ask "does this crash" — ask "if this default is wrong, does *anything* ever notice?" If the answer is no, the fallback should fail loudly (throw, return an error status) instead of substituting a plausible number.

## A rule learned the hard way: a data-repair scope is only as good as its WHERE clause
When a bug has already corrupted stored data, fixing the code is not enough — the fix's data-repair query needs to cover *every* row that got corrupted, not just the obvious majority. Session precedent: the timezone bug was fixed by repairing all `details = '[імпорт]'` rows (87 of them) — but a recurring-template-generated row (`recurringTemplateId != null`) had the *exact same* corruption from the *same root cause* (a stale local-dev-server write, migrated as-is) and was missed because the repair query filtered on `details`, not on "does this timestamp look wrong." Before declaring a data-repair done, write the detection query as broadly as the bug's actual mechanism (e.g. "any timestamp not on a clean UTC boundary"), not as narrowly as the first example you happened to find.

## A rule learned the hard way: a live relation reflects today's state, not the state when the row was written
Prisma relations resolved via `include`/`select` (e.g. `transaction.category.type`) always read the CURRENT row, not a snapshot from when the referencing row was created — unlike a field that gets COPIED at write time (`Transaction.categoryId`, `Transaction.amount`, `Transaction.userId` on `RecurringTemplate` application), which stays fixed even if the source later changes. Found live: `categories/[id]/route.ts` allowed editing a category's `type` (income/expense) with no guard. Every existing transaction under that category — some of them months old — instantly reclassified from expense to income (or vice versa) everywhere `stats/route.ts` aggregates `t.category.type` via the live relation, because nothing was ever snapshotted at transaction-write time. Proven live with a disposable test: created an expense category + transaction, confirmed it summed as an expense, changed ONLY the category's `type` field to income, re-queried, and the same transaction now summed as income with no other write involved. Fix: block the mutation (`categories/[id]/route.ts` now 400s a `type` change if `prisma.transaction.count({ where: { categoryId } }) > 0`, forcing "make a new category" instead of silently rewriting history). General rule: any field that controls how *historical* data gets classified or aggregated — not just how it's displayed today — either needs to be write-time-snapshotted onto the child row, or needs a guard preventing it from changing once real data depends on it. Ask, for every editable field on a parent row: does any downstream query read this field via a live relation to decide something about *already-recorded* child rows?

## A rule learned the hard way: "check then create" is a race whenever two writers can reach the same check
A `findUnique` guard followed by a separate `create` is only race-free if exactly one caller can ever run it for a given key. Found live: `monoIngest.ts`'s `ingestStatementItem()` checks `findUnique({ monoStatementId })` then `create()`s if not found — safe when only the webhook called it, but a second writer (`/api/monobank/sync`, added the same session as a reconciliation safety net) can now reach the same function for the same never-before-seen item concurrently with the webhook, or two overlapping manual syncs can race each other. Whoever loses the race hits the database's own unique-constraint rejection (Prisma P2002) on the `create` — a real, uncaught exception, not a hypothetical. Verified live by firing two concurrent calls sharing one synthetic id: one `created`, the other threw. Because the loop in `sync/route.ts` had no per-item try/catch, this uncaught throw silently aborted the *entire remaining batch* and turned an accurate partial-success response into an opaque 500. Fix: catch the specific unique-constraint error code and treat it as the same outcome as the `findUnique` finding a row (because it *is* the same outcome — someone else won the race). General rule: any time you add a second writer to a table that already had a "check then create" pattern, that pattern needs the create's own unique-constraint violation handled as a success path, not just the upfront check.

## Process

1. Read every file under `src/app/api/**/*.ts` and `src/lib/**/*.ts` in full (not excerpts) — this is where money math, dates, and now encryption/external-API clients live, the highest-consequence code in the app.
2. For each category above, actively look for it rather than waiting to notice it.
3. When you find a candidate bug, **prove it** with a concrete before/after example or a live query against the database — the way the timezone bug was proven with an actual UTC-vs-Kyiv boundary calculation, not just "this looks suspicious."
4. Distinguish confirmed bugs (proven with a concrete failing case) from suspicions (plausible but unverified) — report both, labeled differently.
5. Run `node scripts/verify-data-integrity.mjs` (add `VERIFY_URL=<deployment> VERIFY_PIN=<pin>` env vars to include the live-API cross-check step) both *before* starting — to catch anything already wrong — and *after* fixes — to confirm nothing regressed and nothing was missed by too-narrow a repair query. This script is the accumulated checklist from past reviews; extend it whenever a new category of corruption is found rather than only checking it ad hoc.

## Report format

```
## Deep review — <date>

### Confirmed bugs
- file.ts:42 — <what's wrong> — <concrete proof: the example/query that shows it failing>
  Fix: <what changes>

### Suspicions (plausible, unverified — needs a human decision or more investigation)
- file.ts:17 — <what could be wrong and why>

### Reviewed clean
<categories/files gone through that turned up nothing>
```

After reporting: **fix confirmed bugs immediately** (code + data if the bug already corrupted stored data — check with a live query whether it did), verify the fix with a concrete before/after check, commit, push, and redeploy to Vercel if the fix touches anything already in production (`vercel deploy --prod --token=$env:VERCEL_TOKEN`), then re-verify against the live URL.

For suspicions: do not fix speculatively. Surface them and ask, unless investigating further is cheap and quick.
