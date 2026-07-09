# Selfcheck skill

Budget tracker (Next.js 14 + Prisma + Postgres/Neon, deployed on Vercel serverless).
Project root: `C:\Users\doter\Budget`, source in `src/`.

**Token rule:** use Grep only — never Read a file unless a grep match needs 5+ lines of context to judge. One Read = one specific file + specific line range. No full-file reads.

**Deployment context:** the app runs both locally (`npm run dev`/`start`) and on Vercel (serverless functions, each invocation potentially a different isolate) against a shared Neon Postgres database. Checks #11–#12 exist specifically because bugs that are invisible on a single long-running local process can be silent, real regressions once deployed serverless — module-level mutable state is the classic example (worked locally, silently stopped protecting anything in prod).

## Run these grep checks in order

### 1. Unhandled HTTP errors — fetch without .ok check
```
pattern: \.then\(r => r\.json\(\)\)
glob: src/**/*.ts src/**/*.tsx
```
Any match that is NOT preceded by `if (!r.ok)` or `.then(r => { if (!r.ok)` on the same or previous line is a bug. Report file:line.

### 2. Silent fetch failures — .then() chain without .catch()
```
pattern: fetch\(
glob: src/**/*.ts src/**/*.tsx
```
For each fetch call, check if the chain in that block ends with `.catch(`. Missing = bug. Also flag `.catch(() => {})` (present but empty) when the fetch is loading data the page actually needs to function (main stats, form dropdowns) rather than a decorative counter — a silent empty catch there leaves a blank page or an unusable form (e.g. empty category dropdown) with zero indication anything failed. Real example already fixed: 5 sites (dashboard stats, analytics, transaction-form and recurring-modal category/user dropdowns) had this; fix = a `toast(...)` matching the error-message convention already used by sibling pages. A silent catch on a truly decorative element (a pending-count badge) is fine — use judgment, don't toast everything.

### 3. Unvalidated parseInt / parseFloat
```
pattern: parseInt\(|parseFloat\(
glob: src/app/api/**/*.ts
```
Any result used directly (not wrapped in `Number.isFinite(`) = bug.

### 4. Debug leftovers
```
pattern: console\.log\(
glob: src/**/*.ts src/**/*.tsx
```
All matches are candidates for removal. Report file:line.

### 5. `as any` type casts hiding real bugs
```
pattern: as any
glob: src/**/*.ts src/**/*.tsx
```
Report all. Skip ones in test files or comments.

### 6. Missing error state on setLoading(true) without finally/catch
```
pattern: setLoading\(true\)
glob: src/**/*.tsx
```
For each match, check the surrounding function for `.finally(() => setLoading(false))` or a catch that calls `setLoading(false)`. Missing = loading spinner never stops.

### 7. useEffect with missing deps (common pattern)
```
pattern: useEffect\(
glob: src/**/*.tsx
```
For each useEffect, read ±8 lines. If the callback references a state variable or prop that's not in the deps array `[...]`, report it.

### 8. Prisma raw queries (SQL injection risk)
```
pattern: prisma\.\$queryRaw|prisma\.\$executeRaw
glob: src/**/*.ts
```
Any match = review for user input injection.

### 9. Unhandled promise — async function called without await/catch
```
pattern: ^\s+[a-zA-Z]+\(.*\);$
glob: src/**/*.tsx
```
Look for lines that call `async` functions (defined in the same file) without `await`. Common pattern: event handlers that call `async` functions.

### 10. Date arithmetic bugs — month off-by-one
```
pattern: new Date\(.*month
glob: src/app/api/**/*.ts
```
Check that JS `month` parameter uses 0-indexed (`month - 1`) consistently.

### 11. Module-level mutable state in API routes (serverless-breaking)
```
pattern: ^(let|var) [a-zA-Z]
glob: src/app/api/**/*.ts
```
Any top-level (not inside a function) `let`/`var` in a route file is suspect — Vercel serverless functions do not guarantee shared memory across invocations/isolates. Rate limits, counters, caches, or locks kept this way silently stop working once deployed, even though they work fine in local `npm start`. Real example already fixed: brute-force lockout counter in `api/auth/route.ts` used to live in module state — moved to the `AppSetting` table. Fix = persist the state in Postgres (or another shared store), never in a module-level variable.

### 12. Neon connection uses the pooled endpoint
```bash
grep DATABASE_URL .env
```
Hostname must contain `-pooler` (e.g. `ep-xxx-pooler.c-9.us-east-1.aws.neon.tech`). Serverless functions can spin up many concurrent instances; each one opens its own Postgres connection, and the *direct* (non-pooled) endpoint has a low connection ceiling that concurrent traffic can exhaust. The pooled endpoint (PgBouncer) is free and handles this — there's no reason not to use it. If the hostname is missing `-pooler`, treat it as a Critical: fix both `.env` and the `DATABASE_URL` Vercel env var (`vercel env add DATABASE_URL production`, or via the dashboard), then `vercel deploy --prod`.

### 13. Silent numeric fallback masking a real error
```
pattern: \?\? [01]\b
glob: src/**/*.ts
```
For each match, check what happens if the left side is genuinely `null`/`undefined` because of a real failure (network down, cache empty, lookup missed) rather than a legitimate "no value" case. `?? 0` or `?? 1` is fine for a genuine default (e.g. an optional counter). It's a bug when the fallback is a *plausible* value in a money/rate/quantity context — nothing downstream can distinguish "real 1.0" from "we couldn't get the real value so we silently guessed 1.0". Real example already fixed: `fxRate = (await getCachedExchangeRate(...)) ?? 1` in `api/webhooks/monobank/[secret]/route.ts` silently recorded a ~4-5x wrong amount when the exchange rate was unavailable, with no error anywhere — fixed by throwing instead (which routes through the existing retry mechanism) rather than defaulting.

### 14. Client-controllable Host header used to build a URL handed to a third party
```
pattern: nextUrl\.origin|headers\.get\(.host.\)|x-forwarded-host
glob: src/**/*.ts
```
-i flag on. Any match building a URL that gets sent to an external service (a webhook registration, an OAuth redirect, an email link) is a bug — `req.nextUrl.origin` reflects the Host/X-Forwarded-Host header the client sent, not necessarily the real deployment domain. An attacker (or a hijacked session) could spoof it to redirect that callback to a domain they control. Real example already fixed: `api/monobank/connect` and `api/monobank/disconnect` used to build the Monobank webhook URL this way — fixed with `getAppOrigin()` in `lib/monobank.ts`, sourced from Vercel's non-spoofable system env vars (`VERCEL_PROJECT_PRODUCTION_URL`/`VERCEL_URL`) instead. Using `req.nextUrl` for routing/redirects *within* the app (not sent to a third party) is fine — only flag matches where the resulting URL leaves the app.

### 15. Prisma query touching User without an explicit select
```
pattern: user: true|prisma\.user\.findMany\(\)|prisma\.user\.findMany\(\{ orderBy|prisma\.user\.findUnique\(\{ where|prisma\.user\.findFirst\(\{ where
glob: src/**/*.ts
```
For each match, check whether `select:` appears anywhere in that same call (it can be on a later line, not just the matched line — read a few lines past the match before judging). Any `include: { user: true }`, an unscoped `prisma.user.findMany()`, or a bare `findUnique`/`findFirst` returns every column, including whatever sensitive fields have been added to `User` since this check was last run (currently `monoTokenEnc`, `monoWebhookSecret` — the latter is plaintext, and leaking it lets an attacker post fake transactions straight to that user's webhook receiver). Real examples already fixed: 9 call sites across `transactions`, `recurring`, `stats`, `export` routes with a bare `include`/`findMany`; separately, 5 more `findUnique` calls (webhooks/monobank, monobank/connect, monobank/disconnect, auth/telegram, auth/telegram/register) — the pattern above originally only caught `findMany`, missing `findUnique`/`findFirst` entirely, which is how those 5 slipped through several review passes. None of the 5 actually leaked (each only read one field or reconstructed a minimal object before responding), but the same shape has produced real leaks before, so the rule is unconditional: never a bare `findUnique`/`findFirst`/`findMany` on User. Fix = `select: { id: true, name: true }`, or whatever specific fields the caller actually needs.

---

## Report format

```
## Selfcheck — <date>

### Critical (fix now)
- file.tsx:42 — description

### Warnings (review)
- file.ts:17 — description

### Clean ✓
Checks that found nothing: #3, #8, #9
```

After reporting: **fix every Critical immediately**, commit, push. For Warnings — fix if clearly wrong, otherwise list for human review. Do NOT ask permission to fix Criticals.

After all fixes: `git add -A && git commit -m "Selfcheck fixes <date>" && git push`.

If a Critical fix changes anything Vercel needs (env vars, schema), also redeploy: `vercel deploy --prod --token=$env:VERCEL_TOKEN` and re-verify the live URL before considering the fix done.
