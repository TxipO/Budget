// Run: node scripts/seed.js [path/to/Budget.xlsx]
const path = require('path');
const dbPath = path.resolve(__dirname, '../prisma/budget.db');
process.env.DATABASE_URL = `file:${dbPath}`;
const { PrismaClient } = require('@prisma/client');
const XLSX = require('xlsx');
const fs = require('fs');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const INCOME_COLORS  = { 'Женя': '#22C55E', 'Паша': '#16A34A', 'Додаткове': '#4ADE80' };
const EXPENSE_COLORS = {
  'Оренда': '#EF4444', 'Комунальні': '#F97316', 'Їжа': '#EAB308',
  'Медицина': '#EC4899', 'Домашній хлам/одяг/etc': '#8B5CF6',
  'Балування': '#3B82F6', 'Підписки': '#6366F1', 'Навчання': '#06B6D4',
  'Кредит': '#DC2626', 'Залежності': '#92400E', 'Подарунки': '#BE185D',
  'Незрозуміло': '#6B7280',
};
const SAVINGS_COLORS = {
  'Фінансова подушка': '#A855F7', 'Акції': '#7C3AED',
  'Машина': '#6D28D9', 'Dual Invest': '#C084FC',
};

function getColor(name, type) {
  if (type === 'income')  return INCOME_COLORS[name]  || '#22C55E';
  if (type === 'expense') return EXPENSE_COLORS[name] || '#EF4444';
  return SAVINGS_COLORS[name] || '#A855F7';
}

function cleanName(raw) {
  if (raw && String(raw).includes('пчола')) return 'Женя';
  return String(raw).trim();
}

// Column layout in "Планування" sheet (0-indexed):
// col 0  = category name / section header
// col 2  = January, col 3 = February, ..., col 13 = December
const JAN_COL = 2;

async function main() {
  const xlsxPath = process.argv[2] || path.join(require('os').homedir(), 'Downloads', 'Budget.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Excel not found: ${xlsxPath}`);
    process.exit(1);
  }

  console.log(`Reading: ${xlsxPath}`);
  const wb = XLSX.readFile(xlsxPath);

  // Users
  for (const name of ['Паша', 'Женя']) {
    await prisma.user.upsert({ where: { name }, update: {}, create: { name } });
  }
  console.log('Users: Паша, Женя');

  // Parse Планування
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Планування'], { header: 1, defval: null });
  let section = null;
  let totalTx = 0;
  let totalCats = 0;

  for (const row of rows) {
    const cell = row[0]; // category name is in column 0
    if (!cell) continue;
    const cellStr = String(cell).trim();

    if (cellStr === 'Дохід')      { section = 'income';  continue; }
    if (cellStr === 'Витрати')    { section = 'expense'; continue; }
    if (cellStr === 'Збереження') { section = 'savings'; continue; }
    if (!section) continue;
    if (cellStr === 'Сума' || cellStr.startsWith('Встановіть') || cellStr.startsWith('Буде') || cellStr.startsWith('Накоп')) continue;

    const name = cleanName(cellStr);

    let cat = await prisma.category.findFirst({ where: { name, type: section } });
    if (!cat) {
      cat = await prisma.category.create({ data: { name, type: section, color: getColor(name, section) } });
      console.log(`  [${section}] ${name}`);
      totalCats++;
    }

    for (let m = 0; m < 12; m++) {
      const val = row[JAN_COL + m];
      if (val === null || val === undefined || val === '' || val === ' ') continue;
      const amount = typeof val === 'number' ? val : parseFloat(String(val));
      if (!isFinite(amount) || amount <= 0) continue;

      const date = new Date(2026, m, 1);

      await prisma.transaction.deleteMany({
        where: { categoryId: cat.id, date: { gte: new Date(2026, m, 1), lt: new Date(2026, m + 1, 1) }, details: '[імпорт]' },
      });
      await prisma.transaction.create({
        data: { date, categoryId: cat.id, amount, details: '[імпорт]' },
      });

      await prisma.monthlyPlan.upsert({
        where: { year_month_categoryId: { year: 2026, month: m + 1, categoryId: cat.id } },
        update: { plannedAmount: amount },
        create: { year: 2026, month: m + 1, categoryId: cat.id, plannedAmount: amount },
      });
      totalTx++;
    }
  }

  console.log(`\nДодано: ${totalCats} категорій, ${totalTx} транзакцій.`);
  console.log('Запускайте: npm run dev');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
