# Tasks: Режим подорожі

- [x] T001 Schema: Trip, Category.lockedFromModes, Transaction.tripId/tripPrevCategoryId/tripPrevCategorySource (`prisma/schema.prisma`)
- [x] T002 `src/lib/travelMode.ts`: decision rule (FR-001/002/004), active-trip lookup, known-merchant check, «Подорожі» find-or-create
- [x] T003 Hook into `src/lib/monoIngest.ts` and `src/lib/sparebankIngest.ts` after `guessCategoryId`
- [x] T004 Exclude `travel` rows from bill-history guesses (`src/lib/billHistory.ts` caller) and known-merchant checks
- [x] T005 API `/api/trips` (+ `[id]`, `[id]/preview`, `[id]/apply`) with household scoping + session auth like siblings
- [x] T006 Categories API + Settings toggle `lockedFromModes`; `defaultCategories` defaults
- [x] T007 UI: main-page button/banner + dialog with preview checkboxes (DESIGN.md tokens, Ukrainian, 375px)
- [x] T008 `scripts/check-travel-mode.mts`: Варшава fixtures from the 27.11 backup (SC-001), revert (SC-002)
- [x] T009 `scripts/set-locked-categories.mts` (guarded prod write, before/after log)
- [ ] T010 `/fullreview deep`, live check on local Postgres restore, then prod db push → merge
