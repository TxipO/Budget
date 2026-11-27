// Marks the household's essential expense categories "modes must not touch"
// (Category.lockedFromModes — travel mode never moves spending out of them).
// Dry run by default; writes only with --apply. Idempotent.
//
//   npx tsx scripts/set-locked-categories.mts            # dry run
//   npx tsx scripts/set-locked-categories.mts --apply
import { prisma } from '../src/lib/prisma';
import { LOCKED_FROM_MODES_NAMES } from '../src/lib/defaultCategories';

const APPLY = process.argv.includes('--apply');

const cats = await prisma.category.findMany({
  where: { type: 'expense', isActive: true, name: { in: LOCKED_FROM_MODES_NAMES } },
  select: { id: true, householdId: true, name: true, lockedFromModes: true },
  orderBy: [{ householdId: 'asc' }, { id: 'asc' }],
});
console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN (add --apply to write) ===');
for (const c of cats) console.log(`household ${c.householdId} #${c.id} ${c.name}: ${c.lockedFromModes} -> true${c.lockedFromModes ? ' (no change)' : ''}`);
const missing = LOCKED_FROM_MODES_NAMES.filter(n => !cats.some(c => c.name === n));
if (missing.length) console.log('not found in any household (skipped):', missing.join(', '));

const todo = cats.filter(c => !c.lockedFromModes);
if (APPLY && todo.length) {
  const { count } = await prisma.category.updateMany({ where: { id: { in: todo.map(c => c.id) } }, data: { lockedFromModes: true } });
  console.log(`updated ${count}`);
  const after = await prisma.category.findMany({ where: { id: { in: cats.map(c => c.id) } }, select: { id: true, name: true, lockedFromModes: true }, orderBy: { id: 'asc' } });
  for (const c of after) console.log(`after: #${c.id} ${c.name} lockedFromModes=${c.lockedFromModes}`);
} else {
  console.log(APPLY ? 'nothing to update' : `would update ${todo.length}`);
}
await prisma.$disconnect();
