import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Every household that already exists predates the onboarding wizard —
// backfilled to now() so none of them get retroactively sent through it.
// Idempotent: only touches rows still null.
const result = await prisma.household.updateMany({
  where: { onboardedAt: null },
  data: { onboardedAt: new Date() },
});
console.log(`Backfilled onboardedAt for ${result.count} household(s).`);

const remaining = await prisma.household.count({ where: { onboardedAt: null } });
console.log(`Households still needing onboarding: ${remaining}`);

await prisma.$disconnect();
