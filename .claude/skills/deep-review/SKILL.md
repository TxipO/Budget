# Deep review skill

Budget tracker (Next.js 14 + Prisma + Postgres/Neon, deployed on Vercel serverless).
Project root: `C:\Users\doter\Budget`, source in `src/`.

**This is not `/selfcheck`.** `/selfcheck` runs fixed grep patterns for known bug shapes (missing `.ok`, missing `.catch`, etc.) in a couple minutes. This skill looks for the bugs grep *can't* find — ones that require actually reasoning about what the code does, not matching a syntax pattern. Budget more time and more Read calls; token-frugality is not the point here.

**Canonical example — why this skill exists:** every API route computed month boundaries with `new Date(year, month, day)`, which silently uses the Node process's local timezone. That's syntactically fine, passes every grep check, compiles, and worked perfectly for months — because the dev machine (Windows, Europe/Kyiv) and the only place code ran shared one timezone. It broke the day the app deployed to Vercel (UTC), silently shifting transactions across month boundaries and corrupting real financial totals. No grep pattern catches "this is correct only because two environments happen to agree" — only reading the code and asking "what if this ran somewhere else, with different ambient state?" does.

## Method

Don't grep-and-report. For each area below: **read the relevant files fully**, trace the actual data flow, and ask the "what if the assumption breaks" question. Read cross-file — a bug's cause and its symptom are often in different files (the timezone bug's cause was in `stats/route.ts`, its symptom was in what the dashboard displayed).

## Categories to reason through

### 1. Environment-dependent behavior
Anything whose result depends on *where* the code executes rather than *what the data says*: system timezone (`new Date(y,m,d)`, `.getDate()`/`.getMonth()` instead of UTC variants), locale (`toLocaleDateString` without a fixed locale where consistency matters), machine-specific paths, `process.cwd()` assumptions, default timeouts that differ between local Node and serverless. Ask: would this produce the same result if run in Kyiv vs UTC vs any other TZ? On Windows vs the Vercel Linux runtime?

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

## Process

1. Read every file under `src/app/api/**/*.ts` in full (not excerpts) — this is where money math and dates live, the highest-consequence code in the app.
2. For each category above, actively look for it rather than waiting to notice it.
3. When you find a candidate bug, **prove it** with a concrete before/after example or a live query against the database — the way the timezone bug was proven with an actual UTC-vs-Kyiv boundary calculation, not just "this looks suspicious."
4. Distinguish confirmed bugs (proven with a concrete failing case) from suspicions (plausible but unverified) — report both, labeled differently.

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
