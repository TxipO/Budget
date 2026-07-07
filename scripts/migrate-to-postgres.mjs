// One-off migration: local SQLite (prisma/budget.db) -> Postgres (Neon).
// Run with: node scripts/migrate-to-postgres.mjs
// Requires DATABASE_URL in .env pointing at the target Postgres, and the
// Prisma client already generated for the postgresql provider.
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import path from 'path';

const sqlitePath = path.resolve(process.cwd(), 'prisma', 'budget.db');
const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const prisma = new PrismaClient();

function all(table) {
  return sqlite.prepare(`SELECT * FROM "${table}"`).all();
}

async function main() {
  console.log('Reading from', sqlitePath);

  const users = all('User');
  const categories = all('Category');
  const templates = all('RecurringTemplate');
  const transactions = all('Transaction');
  const plans = all('MonthlyPlan');
  const settings = all('AppSetting');

  console.log({
    users: users.length, categories: categories.length, templates: templates.length,
    transactions: transactions.length, plans: plans.length, settings: settings.length,
  });

  // Order matters: users/categories first (referenced by everything else),
  // then templates (referenced by transactions), then transactions/plans/settings.
  for (const u of users) {
    await prisma.user.upsert({
      where: { id: u.id },
      update: {},
      create: { id: u.id, name: u.name, createdAt: new Date(u.createdAt) },
    });
  }

  for (const c of categories) {
    await prisma.category.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id, name: c.name, type: c.type, color: c.color,
        icon: c.icon, isActive: !!c.isActive,
      },
    });
  }

  for (const t of templates) {
    await prisma.recurringTemplate.upsert({
      where: { id: t.id },
      update: {},
      create: {
        id: t.id, name: t.name, amount: t.amount, categoryId: t.categoryId,
        userId: t.userId, details: t.details, isActive: !!t.isActive,
        createdAt: new Date(t.createdAt),
      },
    });
  }

  for (const tx of transactions) {
    await prisma.transaction.upsert({
      where: { id: tx.id },
      update: {},
      create: {
        id: tx.id, date: new Date(tx.date), categoryId: tx.categoryId,
        amount: tx.amount, details: tx.details, userId: tx.userId,
        createdAt: new Date(tx.createdAt), recurringTemplateId: tx.recurringTemplateId,
      },
    });
  }

  for (const p of plans) {
    await prisma.monthlyPlan.upsert({
      where: { id: p.id },
      update: {},
      create: {
        id: p.id, year: p.year, month: p.month, categoryId: p.categoryId,
        plannedAmount: p.plannedAmount, notes: p.notes,
      },
    });
  }

  for (const s of settings) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: { key: s.key, value: s.value },
    });
  }

  // Reset Postgres auto-increment sequences past the highest migrated id,
  // otherwise the next INSERT collides with a migrated row.
  for (const [table, col] of [['User', 'id'], ['Category', 'id'], ['RecurringTemplate', 'id'], ['Transaction', 'id'], ['MonthlyPlan', 'id']]) {
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', '${col}'), COALESCE((SELECT MAX("${col}") FROM "${table}"), 1))`
    );
  }

  console.log('Migration done.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); sqlite.close(); });
