# Implementation Plan: Режим подорожі

**Spec**: [spec.md](./spec.md) · **Ponytail**: найменша повна зміна.

## Constitution Check
- II: зачіпає bank ingest (mono + sparebank) і нові `/api/**` → `/fullreview deep` перед merge.
- III: перевірка наживо на локальній Postgres-копії бекапу 27.11 + перегляд на проді.
- IV: один прапорець `lockedFromModes` замість системи режимів; без feature flags.
- VI: дати поїздки — UTC-дні (`Date.UTC`), без локальних компонентів; без module-level стану.
- VII: жодних `include: { user: true }`.

## Data model (prisma, лише додає)
```prisma
model Trip {
  id          Int       @id @default(autoincrement())
  householdId Int
  household   Household @relation(fields: [householdId], references: [id])
  name        String
  startDate   DateTime          // UTC midnight, inclusive
  endDate     DateTime?         // UTC midnight, inclusive; null = active until ended
  accounts    String[]          // "mono:<userId>" | "sb:<sparebankAccountId>"
  categoryId  Int               // the household's «Подорожі» (find-or-create)
  category    Category  @relation(fields: [categoryId], references: [id])
  createdAt   DateTime  @default(now())
  transactions Transaction[]
  @@index([householdId])
}
// Category: lockedFromModes Boolean @default(false)
// Transaction: tripId Int? (relation), tripPrevCategoryId Int?, tripPrevCategorySource String?
```

## Logic — `src/lib/travelMode.ts`
- `travelOverride({ householdId, account, date, txType, merchantKey, guess, isTransfer, bank })` →
  `{ categoryId, tripId, prevCategoryId, prevSource } | null`. Called in monoIngest and sparebankIngest right after
  `guessCategoryId` (only that branch — intents, reversals, transfers, pool legs never reach it).
- `isKnownMerchant(householdId, key, before)` — prior rows (365 d) whose `merchantKey(monoMerchant ?? merchantText)` equals key,
  category not the fallback name, `categorySource` not `travel`.
- Same decision function powers the retro preview (with the row's stored `categorySource` as the tier).

## API
- `GET/POST /api/trips` — list / create (`name, startDate, endDate?, accounts[]`).
- `GET /api/trips/[id]/preview` — candidates (id, date, merchant, amount, current category, account).
- `POST /api/trips/[id]/apply` `{ ids[] }` — re-validates each id against the rule, writes travel + prev.
- `PATCH /api/trips/[id]` `{ endDate }` (Завершити) · `DELETE /api/trips/[id]` — revert rows still `travel`, then delete.
- `PUT/POST /api/categories` accept `lockedFromModes`.

## UI
- Головна: кнопка «✈ Режим подорожі» → діалог (назва, дати, рахунки) → для минулих дат перегляд з галочками → «Застосувати».
  Активна поїздка → банер «✈ <назва> · N рахунки · <сума>» + «Завершити».
- Налаштування → категорія: перемикач «Режими не чіпають цю категорію».
- Нова сім'я: `defaultCategories` ставить `lockedFromModes` для Медицина/Підписки/Комунальні/Оренда/Кредит.

## Rollout
1. `prisma db push` на прод (лише додає) → скрипт `scripts/set-locked-categories.mts` (guard + before/after лог) для 5 категорій.
2. Merge → Vercel. 3. Створити «Варшаву», перегляд, Паша натискає «Застосувати».
