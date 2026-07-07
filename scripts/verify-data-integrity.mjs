// Systematic data-integrity verification pipeline for the budget tracker.
// Run any time you suspect something's off: node scripts/verify-data-integrity.mjs
//
// Each step is independent and prints its own PASS/FAIL/WARN — read top to
// bottom, stop at the first FAIL and fix before trusting later steps (later
// steps sometimes assume earlier ones passed).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
let failCount = 0;
let warnCount = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`  \x1b[31m✗ FAIL\x1b[0m ${msg}`); failCount++; }
function warn(msg) { console.log(`  \x1b[33m⚠ WARN\x1b[0m ${msg}`); warnCount++; }
function step(n, title) { console.log(`\n[${n}] ${title}`); }

async function main() {
  console.log('=== Budget tracker data-integrity pipeline ===');
  console.log('Database:', process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@'));

  const [txs, cats, users, templates, plans] = await Promise.all([
    prisma.transaction.findMany({ include: { category: true, user: true } }),
    prisma.category.findMany(),
    prisma.user.findMany(),
    prisma.recurringTemplate.findMany(),
    prisma.monthlyPlan.findMany(),
  ]);

  // ── Step 1: orphaned foreign keys ─────────────────────────────────────
  step(1, 'Foreign key integrity');
  const catIds = new Set(cats.map(c => c.id));
  const userIds = new Set(users.map(u => u.id));
  const tplIds = new Set(templates.map(t => t.id));
  const orphanCat = txs.filter(t => !catIds.has(t.categoryId));
  const orphanUser = txs.filter(t => t.userId !== null && !userIds.has(t.userId));
  const orphanTpl = txs.filter(t => t.recurringTemplateId !== null && !tplIds.has(t.recurringTemplateId));
  if (orphanCat.length) fail(`${orphanCat.length} transactions reference a missing category: ${orphanCat.map(t => t.id).join(',')}`);
  else pass(`all ${txs.length} transactions have a valid categoryId`);
  if (orphanUser.length) fail(`${orphanUser.length} transactions reference a missing user`);
  else pass('all userId references valid');
  if (orphanTpl.length) fail(`${orphanTpl.length} transactions reference a missing recurring template`);
  else pass('all recurringTemplateId references valid');

  // ── Step 2: amount sanity ─────────────────────────────────────────────
  step(2, 'Amount sanity');
  const badAmount = txs.filter(t => !Number.isFinite(t.amount) || t.amount <= 0);
  if (badAmount.length) fail(`${badAmount.length} transactions have non-positive/non-finite amount: ${badAmount.map(t => t.id).join(',')}`);
  else pass(`all ${txs.length} amounts are positive finite numbers`);
  const unrounded = txs.filter(t => Math.round(t.amount * 100) / 100 !== t.amount);
  if (unrounded.length) warn(`${unrounded.length} transactions have sub-cent float drift (cosmetic, roundMoney() should prevent new ones): ${unrounded.map(t => t.id).join(',')}`);
  else pass('no float-drift amounts');

  // ── Step 3: suspicious timestamps (the timezone-offset bug class) ─────
  step(3, 'Timezone-offset residue');
  // Legitimate timestamp shapes in this app: manual entries land on exact
  // UTC midnight (ISO date string parsing), recurring-apply lands on exact
  // UTC noon (Date.UTC(...,12,0,0)). Anything else is residue from the old
  // local-timezone Date() constructor bug and represents a transaction
  // sitting in the wrong month.
  const suspicious = txs.filter(t => {
    const h = t.date.getUTCHours(), m = t.date.getUTCMinutes();
    return !(h === 0 && m === 0) && !(h === 12 && m === 0);
  });
  if (suspicious.length) {
    fail(`${suspicious.length} transactions have a non-midnight/non-noon UTC timestamp (likely misfiled into the wrong month):`);
    suspicious.forEach(t => console.log(`      #${t.id} ${t.date.toISOString()} ${t.category.name} "${t.details}" ${t.amount}`));
  } else pass(`all ${txs.length} transactions land on a clean UTC midnight or noon boundary`);

  // ── Step 4: double-counting between [імпорт] and recurring-template rows ─
  step(4, 'Double-counted recurring items');
  // Both the Excel-plan import and the recurring-template "Застосувати"
  // button can independently write a transaction for the same category in
  // the same month. Neither checks whether the other already did, so the
  // same real-world payment (e.g. rent) can get counted twice.
  const byKey = {};
  for (const t of txs) {
    const key = `${t.categoryId}:${t.date.getUTCFullYear()}-${String(t.date.getUTCMonth() + 1).padStart(2, '0')}`;
    (byKey[key] ??= []).push(t);
  }
  const doubled = Object.entries(byKey).filter(([, group]) =>
    group.some(t => t.details === '[імпорт]') && group.some(t => t.recurringTemplateId !== null)
  );
  if (doubled.length) {
    fail(`${doubled.length} category+month combos have BOTH an [імпорт] row and a recurring-template row (likely double-counted):`);
    for (const [key, group] of doubled) {
      console.log(`      ${key} ${group[0].category.name}:`);
      group.forEach(t => console.log(`        #${t.id} ${t.date.toISOString()} "${t.details}" ${t.amount} (recurringTemplateId=${t.recurringTemplateId})`));
    }
  } else pass('no category+month combo double-counted between import and recurring sources');

  // Broader version of the same class of bug: the check above only catches
  // the [імпорт]-vs-recurring pair we already found once. But the same "two
  // independent writers for one real-world event" shape applies to ANY
  // manually-entered or Ведення-imported transaction (recurringTemplateId
  // null, not an [імпорт] summary row) landing in the same category+month as
  // a recurring-template row — e.g. someone logs "Оренда" by hand the same
  // month the rent template gets applied. Deliberately as broad as the bug's
  // actual mechanism, not just the first example that triggered it (see the
  // WHERE-clause lesson in the deep-review skill).
  const doubledAny = Object.entries(byKey).filter(([, group]) =>
    group.some(t => t.recurringTemplateId !== null) &&
    group.some(t => t.recurringTemplateId === null && t.details !== '[імпорт]')
  );
  if (doubledAny.length) {
    warn(`${doubledAny.length} category+month combos have BOTH a recurring-template row and an unrelated manual/imported row — verify these aren't the same real payment counted twice:`);
    for (const [key, group] of doubledAny) {
      console.log(`      ${key} ${group[0].category.name}:`);
      group.forEach(t => console.log(`        #${t.id} ${t.date.toISOString()} "${t.details}" ${t.amount} (recurringTemplateId=${t.recurringTemplateId})`));
    }
  } else pass('no category+month combo mixes a recurring-template row with an unrelated manual/imported row');

  // ── Step 4c: Ф5's possibleDuplicateOf flag ──────────────────────────────
  step('4c', 'Mono possibleDuplicateOf flags');
  // The webhook receiver (src/app/api/webhooks/monobank/[secret]/route.ts)
  // sets this at write time when a new mono transaction lands in the same
  // category+month as an existing recurring/import row — a human still has
  // to glance at these (shown as a badge in the transactions list), this
  // just checks the flag itself points at something real.
  const flagged = txs.filter(t => t.possibleDuplicateOf !== null);
  const txIds = new Set(txs.map(t => t.id));
  const danglingFlags = flagged.filter(t => !txIds.has(t.possibleDuplicateOf));
  if (danglingFlags.length) fail(`${danglingFlags.length} possibleDuplicateOf values point at a non-existent transaction id`);
  else pass(`${flagged.length} transaction(s) flagged as a possible duplicate, all references valid`);

  // ── Step 5: duplicate recurring applications ───────────────────────────
  step(5, 'Duplicate recurring-template applications');
  const byTplMonth = {};
  for (const t of txs.filter(t => t.recurringTemplateId !== null)) {
    const key = `${t.recurringTemplateId}:${t.date.getUTCFullYear()}-${t.date.getUTCMonth()}`;
    (byTplMonth[key] ??= []).push(t);
  }
  const tplDupes = Object.entries(byTplMonth).filter(([, g]) => g.length > 1);
  if (tplDupes.length) fail(`${tplDupes.length} template+month combos have more than one transaction (race-condition duplicate)`);
  else pass('every recurring template applied at most once per month');

  // ── Step 6: MonthlyPlan sanity ──────────────────────────────────────────
  step(6, 'MonthlyPlan integrity');
  const orphanPlanCat = plans.filter(p => !catIds.has(p.categoryId));
  const badPlanMonth = plans.filter(p => p.month < 1 || p.month > 12);
  if (orphanPlanCat.length) fail(`${orphanPlanCat.length} plans reference a missing category`);
  else pass('all plan categoryId references valid');
  if (badPlanMonth.length) fail(`${badPlanMonth.length} plans have an out-of-range month`);
  else pass('all plan months in 1..12');

  // ── Step 6b: export template row capacity ───────────────────────────────
  step('6b', 'Excel export template capacity (Планування sheet)');
  // src/app/api/export/route.ts writes one row per active category into a
  // FIXED number of template rows per section (income/expense/savings). Once
  // a section has more active categories than rows, the export route now
  // fails loudly (see the fix) instead of silently dropping the extras — but
  // catching it here too means it shows up before anyone tries to export.
  const EXPORT_CAPACITY = { income: 10, expense: 13, savings: 10 }; // must match SECTIONS in export/route.ts
  const activeCats = cats.filter(c => c.isActive);
  for (const [type, capacity] of Object.entries(EXPORT_CAPACITY)) {
    const count = activeCats.filter(c => c.type === type).length;
    if (count > capacity) fail(`${count} active "${type}" categories but the export template only has ${capacity} rows for that section`);
    else if (count === capacity) warn(`${count}/${capacity} "${type}" category rows used in the export template — next category added will overflow it`);
    else pass(`${count}/${capacity} "${type}" category rows used in the export template`);
  }

  // ── Step 7: cross-check aggregate math ──────────────────────────────────
  step(7, 'Aggregate cross-check (manual sum vs a fresh independent calculation)');
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const monthTxs = txs.filter(t => t.date.getUTCFullYear() === y && t.date.getUTCMonth() + 1 === m);
  const income = monthTxs.filter(t => t.category.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expenses = monthTxs.filter(t => t.category.type === 'expense').reduce((s, t) => s + t.amount, 0);
  console.log(`  current month (${y}-${String(m).padStart(2, '0')}) independently computed: income=${income}, expenses=${expenses}`);

  // ── Step 8: live API cross-check (optional — needs VERIFY_URL + VERIFY_PIN) ─
  step(8, 'Live API cross-check');
  const apiUrl = process.env.VERIFY_URL;
  const apiPin = process.env.VERIFY_PIN;
  if (!apiUrl || !apiPin) {
    console.log('  (skipped — set VERIFY_URL and VERIFY_PIN env vars to run this against a live deployment)');
  } else {
    const jar = [];
    const login = await fetch(`${apiUrl}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: apiPin }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!login.ok || !cookie) { fail(`login to ${apiUrl} failed with status ${login.status}`); }
    else {
      const stats = await fetch(`${apiUrl}/api/stats?period=month&year=${y}&month=${m}`, { headers: { Cookie: cookie } }).then(r => r.json());
      if (stats.income === income && stats.expenses === expenses) {
        pass(`live API (${apiUrl}) matches independent DB calculation: income=${stats.income}, expenses=${stats.expenses}`);
      } else {
        fail(`live API returned income=${stats.income}, expenses=${stats.expenses} but direct DB calculation says income=${income}, expenses=${expenses} — investigate the API route's query logic`);
      }
    }
  }

  console.log(`\n=== Summary: ${failCount} FAIL, ${warnCount} WARN ===`);
  await prisma.$disconnect();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
