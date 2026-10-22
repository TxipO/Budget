import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import ExcelJS from 'exceljs';
import { requireHouseholdId, MAX_USERS } from '@/lib/household';
import { PLANNING_YEARS, planningMonthCol } from '@/lib/planningLayout';

const INCOME_COLORS: Record<string, string> = {
  'Женя': '#22C55E', 'Паша': '#16A34A', 'Додаткове': '#4ADE80',
};
const EXPENSE_COLORS: Record<string, string> = {
  'Оренда': '#EF4444', 'Комунальні': '#F97316', 'Їжа': '#EAB308',
  'Медицина': '#EC4899', 'Домашній хлам/одяг/etc': '#8B5CF6',
  'Балування': '#3B82F6', 'Підписки': '#F97316', 'Навчання': '#06B6D4',
  'Кредит': '#DC2626', 'Залежності': '#92400E', 'Подарунки': '#BE185D',
  'Незрозуміло': '#6B7280',
};
const SAVINGS_COLORS: Record<string, string> = {
  'Фінансова подушка': '#F59E0B', 'Акції': '#FBBF24',
  'Машина': '#F97316', 'Dual Invest': '#FCD34D',
};

function getColor(name: string, type: string): string {
  if (type === 'income')  return INCOME_COLORS[name]  || '#22C55E';
  if (type === 'expense') return EXPENSE_COLORS[name] || '#EF4444';
  return SAVINGS_COLORS[name] || '#F59E0B';
}

function cleanName(raw: string): string {
  // Fix the garbled "Жььжжь the пчола" → "Женя"
  if (raw && raw.includes('пчола')) return 'Женя';
  return raw.trim();
}

// exceljs cell.value can be a primitive, a Date, a formula result object, or
// a rich-text object — normalize down to what the import logic needs.
function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'object') {
    if ('richText' in v) return (v as any).richText.map((r: any) => r.text).join('');
    if ('result' in v)   return v.result !== undefined && v.result !== null ? String(v.result) : null;
    if ('text' in v)     return String((v as any).text);
    return null;
  }
  return String(v);
}
// A user-facing import problem → 400 (anything else is a real 500).
class ImportError extends Error {}

// Must match export/route.ts: set as the workbook's `keywords` doc property.
const EXPORT_MARKER = 'budget-app-export';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10000;
const MAX_AMOUNT = 1e9;

// Numbers: native numbers / formula results as-is; text only if it is a
// plain decimal (spaces/NBSP/thin-space thousands separators and a decimal
// comma allowed: '1 234,50', '1,5', '1,234.50'). Garbage ('12abc', '1e5x')
// is rejected with the cell's location — parseFloat used to silently
// truncate it to 12 and import a wrong amount.
function cellNumber(v: ExcelJS.CellValue, where: string): number | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  const raw = v && typeof v === 'object' && !(v instanceof Date) && 'result' in v ? (v as any).result : v;
  if (raw === null || raw === undefined) return null;
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    let t = raw.replace(/[\s  ]/g, '');
    if (t === '') return null;
    // Both separators present → the last one is the decimal mark.
    if (t.includes(',') && t.includes('.')) {
      t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    } else {
      t = t.replace(',', '.');
    }
    if (!/^-?\d+(\.\d+)?$/.test(t)) throw new ImportError(`Некоректне число "${raw}" (${where})`);
    n = Number(t);
  } else {
    return null; // Date, error value, rich text, boolean — not a number cell
  }
  if (!Number.isFinite(n) || Math.abs(n) > MAX_AMOUNT) throw new ImportError(`Некоректне число (${where})`);
  return round(n);
}
function cellDate(v: ExcelJS.CellValue): Date | null {
  // Native Excel dates arrive as a Date (possibly with a time part) — keep the
  // UTC calendar day only, like every other writer (transactions POST, mono).
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())) : null;
  }
  const s = cellText(v);
  if (!s) return null;
  // ExcelJS gives a real Date for native Excel date cells (the common
  // case, caught above) — this string fallback only runs for a cell typed
  // or pasted as plain text. `new Date(arbitraryString)` is timezone-
  // dependent for most non-ISO formats (confirmed live: "7/8/2026" parses
  // as a different UTC calendar day depending on the server's local
  // timezone, "08.07.2026" gets silently misread as month 8 day 6) — the
  // exact bug class that already once corrupted stats/route.ts's month
  // boundaries. Only accept an unambiguous ISO date, explicitly as UTC;
  // anything else is skipped (the caller treats a null date as "no row
  // here") rather than risking a silently wrong month.
  const isoMatch = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!isoMatch) return null;
  const [, y, m, day] = isoMatch;
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, Number(day)));
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return NextResponse.json({ error: 'Файл не вибрано' }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: 'Файл завеликий (максимум 5 МБ)' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    // Our own export carries the marker: its Ведення rows are the same
    // transactions already in the DB under different signatures (aggregated
    // [імпорт] rows from Планування vs real ones), so importing it back
    // doubled the books (income +171k / expense +170k seen live).
    if (wb.keywords === EXPORT_MARKER) {
      return NextResponse.json({ error: 'Цей файл створено експортом застосунку — імпорт задублює дані' }, { status: 400 });
    }

    // --- Parse Планування sheet ---
    const planSheet = wb.getWorksheet('Планування');
    if (!planSheet) return NextResponse.json({ error: 'Аркуш "Планування" не знайдено' }, { status: 400 });
    const vedSheet = wb.getWorksheet('Ведення');
    if (planSheet.rowCount > MAX_ROWS || (vedSheet?.rowCount ?? 0) > MAX_ROWS) {
      return NextResponse.json({ error: `Забагато рядків у файлі (максимум ${MAX_ROWS})` }, { status: 400 });
    }

    // --- Ensure users exist ---
    // Only seed Паша/Женя into a household that has NO users yet (a fresh
    // import); an established household with differently named members must
    // not get phantom people. householdId_name is the compound unique
    // (MT Ф4), never colliding with another household's names; capped by MAX_USERS.
    if ((await prisma.user.count({ where: { householdId } })) === 0) {
      for (const name of ['Паша', 'Женя'].slice(0, MAX_USERS)) {
        await prisma.user.upsert({
          where: { householdId_name: { householdId, name } }, update: {}, create: { name, householdId },
        });
      }
    }

    // Find section boundaries by scanning column C (index 3, exceljs is 1-based)
    type SectionType = 'income' | 'expense' | 'savings' | null;
    let currentSection: SectionType = null;
    const importedCats = new Map<string, number>(); // name → id

    for (let r = 1; r <= planSheet.rowCount; r++) {
      const row = planSheet.getRow(r);
      const cell = cellText(row.getCell(3).value);
      if (cell === 'Дохід')      { currentSection = 'income';   continue; }
      if (cell === 'Витрати')    { currentSection = 'expense';  continue; }
      if (cell === 'Збереження') { currentSection = 'savings';  continue; }
      if (cell === 'Сума')       continue;
      if (!currentSection || !cell) continue;
      if (cell.startsWith('Встановіть') || cell.startsWith('Буде') || cell.startsWith('Накоп')) continue;

      const name = cleanName(cell);
      if (!name) continue;

      // Read monthly values across EVERY year block the export template
      // actually has (2026-2030, see lib/planningLayout.ts), not just the
      // first — FIXED 2026-08-30 (/fullreview deep): this used to hardcode
      // cols 5..16 (year 2026's own block) and label whatever it found there
      // with a single baseYear read from Налаштування!E7 (which the export
      // route never actually changes — it's a static template cell, always
      // 2026). A household re-importing a real multi-year-edited export
      // would have every 2027+ column silently ignored, with no error — the
      // exact "silent data loss" class this skill's Stage 2 exists to catch.
      const entries: { year: number; m: number; amount: number }[] = [];
      for (const year of PLANNING_YEARS) {
        for (let m = 0; m < 12; m++) {
          const amount = cellNumber(row.getCell(planningMonthCol(year, m + 1)).value, `Планування, рядок ${r}`);
          if (amount === null || amount <= 0) continue;
          entries.push({ year, m, amount });
        }
      }
      // A label with no non-zero cell is a template/placeholder row, not a
      // category — don't create phantom categories from it.
      if (entries.length === 0) continue;

      // Upsert category (householdId+name+type is unique at the DB level)
      const cat = await prisma.category.upsert({
        where: { householdId_name_type: { householdId, name, type: currentSection } },
        update: {},
        create: { name, type: currentSection, color: getColor(name, currentSection), householdId },
      });
      importedCats.set(name, cat.id);

      for (const { year, m, amount } of entries) {
        // Create a monthly summary transaction on the 1st of each month.
        // UTC explicitly so this doesn't depend on the server process's
        // timezone (local dev vs Vercel) — see stats/route.ts for the bug
        // this class of mistake caused when those didn't match.
        const date = new Date(Date.UTC(year, m, 1));

        // Upsert: avoid duplicates on re-import (delete existing for this cat/month then re-create)
        await prisma.transaction.deleteMany({
          where: {
            categoryId: cat.id,
            householdId,
            date: { gte: new Date(Date.UTC(year, m, 1)), lt: new Date(Date.UTC(year, m + 1, 1)) },
            details: '[імпорт]',
          },
        });
        await prisma.transaction.create({
          data: {
            date, categoryId: cat.id, amount, details: '[імпорт]', householdId,
          },
        });

        // Create monthly plan — year+month+categoryId is already implicitly
        // household-scoped (a category belongs to exactly one household),
        // no compound-key change needed the way Category's was.
        await prisma.monthlyPlan.upsert({
          where: { year_month_categoryId: { year, month: m + 1, categoryId: cat.id } },
          update: { plannedAmount: amount },
          create: { year, month: m + 1, categoryId: cat.id, plannedAmount: amount, householdId },
        });
      }
    }

    // --- Parse Ведення sheet (individual transactions) ---
    if (vedSheet) {
      // Dedup by "which occurrence of this signature within THIS file", not
      // by "does a transaction with this signature exist at all" — the
      // latter silently dropped genuinely distinct rows that happen to
      // share date+category+amount+details (e.g. coffee bought twice the
      // same day for the same price), including within a single import: the
      // first identical row created the transaction, the second saw it
      // "already exists" and got skipped. Re-importing the exact same file
      // must still be idempotent (no duplicates), so instead of a boolean
      // exists-check, count how many matching transactions are already in
      // the DB and compare against this row's 1-based occurrence count of
      // the same signature seen so far in this file — occurrence N only
      // gets created if fewer than N already exist, which handles both re-
      // import (all occurrences already present, all skipped) and adding a
      // genuinely new Nth duplicate row (only the new one gets created)
      // correctly, with no schema change. Found during deep-review
      // 2026-07-11.
      const occurrenceBySignature = new Map<string, number>();
      for (let r = 3; r <= vedSheet.rowCount; r++) {
        const row = vedSheet.getRow(r);
        const rawDate = row.getCell(3).value;
        const type    = cellText(row.getCell(4).value);
        const catName = cellText(row.getCell(5).value);
        const signedAmount = cellNumber(row.getCell(6).value, `Ведення, рядок ${r}`);
        const details = cellText(row.getCell(7).value);

        if (!rawDate || !type || !catName || signedAmount === null || signedAmount === 0) continue;

        const typeLower = type === 'Витрати' ? 'expense'
                         : type === 'Дохід'   ? 'income'
                         : type === 'Збереження' ? 'savings' : null;
        if (!typeLower) continue;
        // The export writes a savings withdrawal as a NEGATIVE amount (the
        // sheet has no other column for direction); only savings can be one.
        if (signedAmount < 0 && typeLower !== 'savings') continue;
        const savingsWithdrawal = signedAmount < 0;
        const amount = Math.abs(signedAmount);

        const date = cellDate(rawDate);
        if (!date) continue;

        const catNameStr = catName.trim();
        const cat = await prisma.category.upsert({
          where: { householdId_name_type: { householdId, name: catNameStr, type: typeLower } },
          update: {},
          create: { name: catNameStr, type: typeLower, color: getColor(catNameStr, typeLower), householdId },
        });

        const detailsStr = details ?? '';
        const signature = `${date.getTime()}|${cat.id}|${signedAmount}|${detailsStr}`;
        const occurrence = (occurrenceBySignature.get(signature) ?? 0) + 1;
        occurrenceBySignature.set(signature, occurrence);

        const existingCount = await prisma.transaction.count({
          where: { date, categoryId: cat.id, amount, savingsWithdrawal, details: detailsStr, householdId },
        });
        if (existingCount < occurrence) {
          await prisma.transaction.create({
            data: { date, categoryId: cat.id, amount, savingsWithdrawal, details: detailsStr, householdId },
          });
        }
      }
    }

    return NextResponse.json({ ok: true, categories: importedCats.size });
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[import POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
