// Offline accuracy harness for the LLM classification tier — Ф2a of the
// classification overhaul plan (project_classification_overhaul.md). Run
// this BEFORE shipping any prompt/model change: every change gets measured
// against this baseline instead of guessed. Ground truth is this
// household's own real history — the actual "smart" test set the plan
// calls for, not a synthetic one.
//
// Run: npx tsx scripts/eval-llm-classification.mts
// (needs TypeScript module resolution for lib/categoryGuess.ts, unlike the
// plain .mjs scripts in this folder — hence .mts + tsx instead of node.)
//
// Baseline recorded 2026-09-15, current prompt (openai/gpt-oss-120b), 125
// pairs: 7.2% commit rate, ~33-44% precision when committed, ~2-3% overall
// accuracy. A few-shot + flipped-null-bias variant was tried the same day
// and reverted — see project_classification_overhaul.md for the numbers;
// neither individually nor combined beat this baseline at this sample size.
import { prisma } from '../src/lib/prisma';
import { guessCategoryByLLM } from '../src/lib/categoryGuess';

async function main() {
  const txs = await prisma.transaction.findMany({
    where: { source: { in: ['mono', 'sparebank', 'voice'] } },
    select: { householdId: true, source: true, monoMerchant: true, details: true, categoryId: true, date: true },
    orderBy: { date: 'asc' },
  });

  // Ground truth: for each merchantKey, the category of its MOST RECENT
  // transaction. A merchant occasionally appears under more than one
  // category across history (a correction changed it partway through) —
  // the latest, settled answer is what's worth testing against, not a
  // stale pre-correction value from before the household fixed it.
  const keyOf = (t: (typeof txs)[number]) => (t.source === 'mono' ? t.monoMerchant : t.details) || '';
  const truth = new Map<string, { categoryId: number; householdId: number }>();
  for (const t of txs) {
    const raw = keyOf(t).trim();
    if (!raw) continue;
    const merchantKey = raw.toLowerCase().replace(/\s+/g, ' ');
    truth.set(merchantKey, { categoryId: t.categoryId, householdId: t.householdId }); // txs is date-ascending, so a later write overwrites an earlier one
  }

  const householdIds = [...new Set([...truth.values()].map(v => v.householdId))];
  const categoriesByHousehold = new Map<number, { id: number; name: string; type: string }[]>();
  for (const hid of householdIds) {
    categoriesByHousehold.set(hid, await prisma.category.findMany({ where: { householdId: hid, isActive: true }, select: { id: true, name: true, type: true } }));
  }
  const categoryById = new Map<number, { id: number; name: string; type: string }>();
  for (const cats of categoriesByHousehold.values()) for (const c of cats) categoryById.set(c.id, c);

  // Only expense/income — guessCategoryByLLM is never actually asked to
  // classify a savings pool (SparebankAccount.categoryId mapping) or a
  // transfer (its own dedicated upsert), so including those here would
  // measure a question production never asks.
  const pairs = [...truth.entries()]
    .map(([merchantKey, { categoryId, householdId }]) => ({ merchantKey, categoryId, householdId, cat: categoryById.get(categoryId) }))
    .filter((p): p is typeof p & { cat: NonNullable<typeof p.cat> } => !!p.cat && (p.cat.type === 'expense' || p.cat.type === 'income'));

  console.log(`Evaluating ${pairs.length} labeled (merchant -> category) pairs against the live LLM tier (openai/gpt-oss-120b)...`);

  let correct = 0, wrong = 0, abstained = 0;
  const mismatches: { merchantKey: string; expected: string; got: string | null }[] = [];

  // Small concurrency limit — 100+ sequential calls would be slow, but
  // firing them all at once risks tripping Groq's rate limit. 4 at a time
  // is a reasonable middle ground for a one-off offline run.
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < pairs.length) {
      const i = idx++;
      const { merchantKey, cat, householdId } = pairs[i];
      const names = (categoriesByHousehold.get(householdId) ?? []).filter(c => c.type === cat.type).map(c => c.name);
      const guess = await guessCategoryByLLM(merchantKey, names);
      if (guess === null) abstained++;
      else if (guess === cat.name) correct++;
      else { wrong++; mismatches.push({ merchantKey, expected: cat.name, got: guess }); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const total = pairs.length;
  const committed = correct + wrong;
  console.log(`\n=== Results (${total} pairs) ===`);
  console.log(`Committed to a guess:      ${committed}/${total} (${(100 * committed / total).toFixed(1)}%)`);
  console.log(`Abstained (null):          ${abstained}/${total} (${(100 * abstained / total).toFixed(1)}%)`);
  console.log(`Precision when committed:  ${committed > 0 ? (100 * correct / committed).toFixed(1) : 'n/a'}% (${correct}/${committed})`);
  console.log(`Overall accuracy (abstain counted as wrong): ${(100 * correct / total).toFixed(1)}% (${correct}/${total})`);

  if (mismatches.length > 0) {
    console.log(`\n=== Wrong guesses (${mismatches.length}) — raw material for future prompt tuning ===`);
    for (const m of mismatches) console.log(`  "${m.merchantKey}" -> expected "${m.expected}", got "${m.got}"`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
