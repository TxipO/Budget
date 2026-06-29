# Common Export Errors & Fixes

When `scripts/verify-export.py` finds ❌ errors, use this table to navigate to the fix location in `src/app/api/export/route.ts`.

| Error Pattern | Lines in route.ts | What to Check | Common Fix |
|---|---|---|---|
| **selection** | 268-270 | sheet1.xml attribute order (Pass 2) | Regex to reorder `pane=` before `activeCell=` |
| **drawing** | 171-253 | Drawing file restoration or worksheet refs | Copy drawing*.xml from template, add `<drawing>` tags |
| **comment** | 68-119 | `buildComments()` function or XML escaping | Check XML entity escaping (&, <, >, ", ') |
| **style** / **fill** | 256-225 | styles.xml number format or cell fill | Pass 1 numFmt regex or noFill assignment |
| **margin** | 235-236 | pageMargins footer/header attributes | Float "0.0" not "0" |
| **align** | 240-244 | D-G column alignment in rows 18+ (sheet3) | Replace s=67 with clean no-alignment style index |
| **numfmt** | 207-209 | Number format \( escape in styles.xml | Regex: `_(\* (#,##0);` → `_(* \(#,##0\);` |
| **formula** | 250-253 | Date DV formula .0 restoration (sheet3) | Regex: `<formula1>1</formula1>` → `<formula1>1.0</formula1>` |
| **vmlDrawing** / **DV** | 245-248 | Extra data validation rule D100:D200 (sheet3) | Remove spurious DV with sqref="D100:D200" |

## Architecture reminder

- **Template**: `src/templates/Budget_template.xlsx` (pristine copy of original)
- **Post-processing order**: Drawing restoration → styles.xml → worksheet XMLs
- **ExcelJS bug**: Cell style API modifies shared styles. Never use `cell.fill = ...` or `cell.font = ...` for fixes — always post-process XML
- **Sheets**: sheet1 = Планування, sheet2 = Налаштування, sheet3 = Ведення
