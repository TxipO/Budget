// Multi-tenant migration, phase A backfill — creates the household for the
// original 2-person budget (Паша/Женя), copies the existing shared PIN and
// lockout state into it, and tags every existing row with its householdId.
// Idempotent: every write is scoped to rows where householdId is still null,
// so re-running this after a partial run (or after new manual/mono/recurring
// data was added in the meantime, still landing with householdId=null until
// application code is updated to set it) only ever backfills what's missing.
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.household.findFirst({ orderBy: { id: 'asc' } });
  let household = existing;
  if (!household) {
    const pinRow = await prisma.appSetting.findUnique({ where: { key: 'pinHash' } });
    household = await prisma.household.create({
      data: {
        name: 'Паша та Женя',
        pinHash: pinRow?.value ?? null,
        authMode: 'pin',
      },
    });
    console.log('created household', household.id);
  } else {
    console.log('household already exists:', household.id, household.name);
  }

  const existingLockout = await prisma.householdLockout.findUnique({ where: { householdId: household.id } });
  if (!existingLockout) {
    const oldLockout = await prisma.authLockout.findUnique({ where: { id: 1 } });
    await prisma.householdLockout.create({
      data: {
        householdId: household.id,
        failCount: oldLockout?.failCount ?? 0,
        lockedUntil: oldLockout?.lockedUntil ?? 0n,
      },
    });
    console.log('created household lockout row');
  } else {
    console.log('household lockout row already exists');
  }

  const results = {};
  results.users = await prisma.user.updateMany({ where: { householdId: null }, data: { householdId: household.id } });
  results.categories = await prisma.category.updateMany({ where: { householdId: null }, data: { householdId: household.id } });
  results.transactions = await prisma.transaction.updateMany({ where: { householdId: null }, data: { householdId: household.id } });
  results.recurringTemplates = await prisma.recurringTemplate.updateMany({ where: { householdId: null }, data: { householdId: household.id } });
  results.monthlyPlans = await prisma.monthlyPlan.updateMany({ where: { householdId: null }, data: { householdId: household.id } });

  console.log('backfilled row counts:', Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.count])));

  // Verify nothing was left unassigned.
  const remaining = {
    users: await prisma.user.count({ where: { householdId: null } }),
    categories: await prisma.category.count({ where: { householdId: null } }),
    transactions: await prisma.transaction.count({ where: { householdId: null } }),
    recurringTemplates: await prisma.recurringTemplate.count({ where: { householdId: null } }),
    monthlyPlans: await prisma.monthlyPlan.count({ where: { householdId: null } }),
  };
  const stillNull = Object.entries(remaining).filter(([, c]) => c > 0);
  if (stillNull.length) {
    console.error('FAIL — still-null householdId after backfill:', stillNull);
    process.exit(1);
  }
  console.log('OK — every row now has a householdId');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
