---
name: verify-export
description: >
  Verify Budget XLSX export pixel-perfect vs original. ALWAYS run this automatically
  after every edit to src/app/api/export/route.ts. Also run whenever user says
  "перевірити експорт", "verify export", or before reporting any export task done.
  The skill runs 7 verification scripts, finds any ❌ errors, diagnoses them with
  exact line numbers and fix suggestions, fixes them immediately, and re-verifies.
---

## What to do

1. **Run the verification script:**
   ```bash
   python scripts/verify-export.py
   ```

2. **Read the output:**
   - ✅ at end = done, report success
   - ❌ in middle = errors found with diagnostics

3. **If errors exist:**
   - Script tells you the line numbers in `src/app/api/export/route.ts` and what to check
   - Fix the issue in the code (see `references/error-patterns.md` for details)
   - Run the script again
   - Repeat until ✅ (0 ❌)

4. **Report only when:**
   - All 7 scripts show 0 ❌
   - Data differences (⚠️ vs original) are OK and expected

## Error diagnostics

The script provides:
- Which of the 7 checks failed
- The exact error description from that check
- Line range in `route.ts` where the fix likely is
- Type of fix needed (XML, style, number format, etc.)

See `references/error-patterns.md` for a quick lookup table.

## Key facts

- 7 verification scripts: iter5, iter8, iter9, iter10, iter11, iter12, iter13
- Template: `src/templates/Budget_template.xlsx`
- Export source: `src/app/api/export/route.ts` (all fixes here via XML post-processing)
- Sheets: sheet1=Планування, sheet2=Налаштування, sheet3=Ведення
- **Fix immediately.** Do not ask user or make a list. Run → fix → run again.
