import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import * as XLSX from 'xlsx';

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

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 });

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });

    // --- Ensure users exist ---
    for (const name of ['Паша', 'Женя']) {
      await prisma.user.upsert({
        where: { name }, update: {}, create: { name },
      });
    }

    // --- Parse Планування sheet ---
    const planSheet = wb.Sheets['Планування'];
    if (!planSheet) return NextResponse.json({ error: 'Sheet "Планування" not found' }, { status: 400 });

    const rows: (string | number | null)[][] = XLSX.utils.sheet_to_json(planSheet, { header: 1, defval: null }) as any;

    // Find section boundaries by scanning column C (index 2)
    type SectionType = 'income' | 'expense' | 'savings' | null;
    let currentSection: SectionType = null;
    const importedCats = new Map<string, number>(); // name → id

    // Month columns: col index 4=Jan,5=Feb,...,15=Dec (0-indexed) for year 2026 block
    const YEAR_COL   = 4;  // January 2026 starts at col E (index 4)
    const MONTHS     = 12;

    for (const row of rows) {
      const cell = row[2]; // Column C = category name
      if (cell === 'Дохід')      { currentSection = 'income';   continue; }
      if (cell === 'Витрати')    { currentSection = 'expense';  continue; }
      if (cell === 'Збереження') { currentSection = 'savings';  continue; }
      if (cell === 'Сума')       continue;
      if (!currentSection || !cell || typeof cell !== 'string') continue;
      if (cell.startsWith('Встановіть') || cell.startsWith('Буде') || cell.startsWith('Накоп')) continue;

      const name = cleanName(cell);
      if (!name) continue;

      // Upsert category
      let cat = await prisma.category.findFirst({ where: { name, type: currentSection } });
      if (!cat) {
        cat = await prisma.category.create({
          data: { name, type: currentSection, color: getColor(name, currentSection) },
        });
      }
      importedCats.set(name, cat.id);

      // Read monthly values (cols 4..15 = Jan..Dec 2026)
      for (let m = 0; m < MONTHS; m++) {
        const val = row[YEAR_COL + m];
        if (val === null || val === undefined || val === '' || val === ' ') continue;
        const amount = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isFinite(amount) || amount <= 0) continue;

        // Create a monthly summary transaction on the 1st of each month
        const date = new Date(2026, m, 1);

        // Upsert: avoid duplicates on re-import (delete existing for this cat/month then re-create)
        await prisma.transaction.deleteMany({
          where: {
            categoryId: cat.id,
            date: { gte: new Date(2026, m, 1), lt: new Date(2026, m + 1, 1) },
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
          where: { year_month_categoryId: { year: 2026, month: m + 1, categoryId: cat.id } },
          update: { plannedAmount: amount },
          create: { year: 2026, month: m + 1, categoryId: cat.id, plannedAmount: amount },
        });
      }
    }

    // --- Parse Ведення sheet (individual transactions) ---
    const vedSheet = wb.Sheets['Ведення'];
    if (vedSheet) {
      const vedRows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(vedSheet, { header: 1, defval: null }) as any;
      for (let i = 2; i < vedRows.length; i++) {
        const row = vedRows[i];
        const rawDate = row[2];
        const type    = row[3];
        const catName = row[4];
        const amount  = row[5];
        const details = row[6];

        if (!rawDate || !type || !catName || !amount) continue;
        if (typeof amount !== 'number' || amount <= 0) continue;

        const typeLower = String(type) === 'Витрати' ? 'expense'
                        : String(type) === 'Дохід'   ? 'income'
                        : String(type) === 'Збереження' ? 'savings' : null;
        if (!typeLower) continue;

        let date: Date;
        if (rawDate instanceof Date) date = rawDate;
        else if (typeof rawDate === 'number') date = XLSX.SSF.parse_date_code(rawDate) as unknown as Date;
        else date = new Date(String(rawDate));

        const catNameStr = String(catName).trim();
        let cat = await prisma.category.findFirst({ where: { name: catNameStr, type: typeLower } });
        if (!cat) {
          cat = await prisma.category.create({
            data: { name: catNameStr, type: typeLower, color: getColor(catNameStr, typeLower) },
          });
        }

        await prisma.transaction.create({
          data: {
            date, categoryId: cat.id, amount: typeof amount === 'number' ? amount : parseFloat(String(amount)),
            details: details ? String(details) : '',
          },
        });
      }
    }

    return NextResponse.json({ ok: true, categories: importedCats.size });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
