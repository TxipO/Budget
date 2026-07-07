import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import ExcelJS from 'exceljs';

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
function cellNumber(v: ExcelJS.CellValue): number | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  if (typeof v === 'number') return round(v);
  if (v && typeof v === 'object' && 'result' in v && typeof (v as any).result === 'number') return round((v as any).result);
  const s = cellText(v);
  if (s === null || s.trim() === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? round(n) : null;
}
function cellDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  const s = cellText(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    // --- Ensure users exist ---
    for (const name of ['Паша', 'Женя']) {
      await prisma.user.upsert({
        where: { name }, update: {}, create: { name },
      });
    }

    // --- Parse Планування sheet ---
    const planSheet = wb.getWorksheet('Планування');
    if (!planSheet) return NextResponse.json({ error: 'Sheet "Планування" not found' }, { status: 400 });

    // Starting year comes from Налаштування!E7, not hardcoded — a hardcoded
    // year here would silently misfile every future re-import (e.g. importing
    // a 2027 template would still write everything into 2026) with no error.
    const settingsSheet = wb.getWorksheet('Налаштування');
    const yearCell = settingsSheet ? cellNumber(settingsSheet.getCell('E7').value) : null;
    const baseYear = yearCell && yearCell >= 2000 && yearCell <= 2100 ? Math.trunc(yearCell) : new Date().getUTCFullYear();

    // Find section boundaries by scanning column C (index 3, exceljs is 1-based)
    type SectionType = 'income' | 'expense' | 'savings' | null;
    let currentSection: SectionType = null;
    const importedCats = new Map<string, number>(); // name → id

    // Month columns: col 5=Jan,6=Feb,...,16=Dec (1-based) for year 2026 block
    const YEAR_COL = 5;
    const MONTHS   = 12;

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

      // Upsert category (name+type is unique at the DB level)
      const cat = await prisma.category.upsert({
        where: { name_type: { name, type: currentSection } },
        update: {},
        create: { name, type: currentSection, color: getColor(name, currentSection) },
      });
      importedCats.set(name, cat.id);

      // Read monthly values (cols 5..16 = Jan..Dec 2026)
      for (let m = 0; m < MONTHS; m++) {
        const amount = cellNumber(row.getCell(YEAR_COL + m).value);
        if (amount === null || amount <= 0) continue;

        // Create a monthly summary transaction on the 1st of each month.
        // UTC explicitly so this doesn't depend on the server process's
        // timezone (local dev vs Vercel) — see stats/route.ts for the bug
        // this class of mistake caused when those didn't match.
        const date = new Date(Date.UTC(baseYear, m, 1));

        // Upsert: avoid duplicates on re-import (delete existing for this cat/month then re-create)
        await prisma.transaction.deleteMany({
          where: {
            categoryId: cat.id,
            date: { gte: new Date(Date.UTC(baseYear, m, 1)), lt: new Date(Date.UTC(baseYear, m + 1, 1)) },
            details: '[імпорт]',
          },
        });
        await prisma.transaction.create({
          data: {
            date, categoryId: cat.id, amount, details: '[імпорт]',
          },
        });

        // Create monthly plan
        await prisma.monthlyPlan.upsert({
          where: { year_month_categoryId: { year: baseYear, month: m + 1, categoryId: cat.id } },
          update: { plannedAmount: amount },
          create: { year: baseYear, month: m + 1, categoryId: cat.id, plannedAmount: amount },
        });
      }
    }

    // --- Parse Ведення sheet (individual transactions) ---
    const vedSheet = wb.getWorksheet('Ведення');
    if (vedSheet) {
      for (let r = 3; r <= vedSheet.rowCount; r++) {
        const row = vedSheet.getRow(r);
        const rawDate = row.getCell(3).value;
        const type    = cellText(row.getCell(4).value);
        const catName = cellText(row.getCell(5).value);
        const amount  = cellNumber(row.getCell(6).value);
        const details = cellText(row.getCell(7).value);

        if (!rawDate || !type || !catName || amount === null || amount <= 0) continue;

        const typeLower = type === 'Витрати' ? 'expense'
                         : type === 'Дохід'   ? 'income'
                         : type === 'Збереження' ? 'savings' : null;
        if (!typeLower) continue;

        const date = cellDate(rawDate);
        if (!date) continue;

        const catNameStr = catName.trim();
        const cat = await prisma.category.upsert({
          where: { name_type: { name: catNameStr, type: typeLower } },
          update: {},
          create: { name: catNameStr, type: typeLower, color: getColor(catNameStr, typeLower) },
        });

        const detailsStr = details ?? '';
        const exists = await prisma.transaction.findFirst({
          where: { date, categoryId: cat.id, amount, details: detailsStr },
        });
        if (!exists) {
          await prisma.transaction.create({
            data: { date, categoryId: cat.id, amount, details: detailsStr },
          });
        }
      }
    }

    return NextResponse.json({ ok: true, categories: importedCats.size });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
