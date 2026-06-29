# Selfcheck skill

Budget tracker (Next.js 14 + Prisma + SQLite) auto-debug scan.
Project root: `C:\Users\doter\Budget`, source in `src/`.

**Token rule:** use Grep only — never Read a file unless a grep match needs 5+ lines of context to judge. One Read = one specific file + specific line range. No full-file reads.

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
For each fetch call, check if the chain in that block ends with `.catch(`. Missing = bug.

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
