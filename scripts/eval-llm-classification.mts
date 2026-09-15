// Offline accuracy harness for the LLM classification tier — Ф2a of the
// classification overhaul plan (project_classification_overhaul.md). Run
// this BEFORE shipping any prompt/model change: every change gets measured
// against this baseline instead of guessed. Ground truth is this
// household's own real history — the actual "smart" test set the plan
// calls for, not a synthetic one.
//
// Run: npx tsx scripts/eval-llm-classification.mts [--context]
// (needs TypeScript module resolution for lib/categoryGuess.ts, unlike the
// plain .mjs scripts in this folder — hence .mts + tsx instead of node.)
//
// Baseline recorded 2026-09-15, current prompt (openai/gpt-oss-120b), 125
// pairs: 7.2% commit rate, ~33-44% precision when committed, ~2-3% overall
// accuracy. A few-shot + flipped-null-bias variant was tried the same day
// and reverted — neither individually nor combined beat this baseline at
// this sample size. project_classification_overhaul.md has the full log.
//
// --context (Ф2c + Ф3 combined, 2026-09-15): adds amount, day of week, who
// paid, a crude "city" guess (last word of the merchant text, filtered
// against common Norwegian company suffixes so "... AS" doesn't get read as
// a city) and whether that city is typical for this user, plus whether
// other transactions the same day also look like unusual-city outliers
// (Ф3's "trip" signal — never stored, just assembled here per pair and
// discarded, matching Ф3's own no-new-entity design). Backtest-only: NOT
// wired into the real guessCategoryId call site — see this run's own printed
// numbers before deciding whether it's worth that follow-up.
import { prisma } from '../src/lib/prisma';
import { guessCategoryByLLM } from '../src/lib/categoryGuess';

const DAY_NAMES = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'];

// Norwegian business-entity suffixes — the single most common way the
// "last word = city" heuristic goes wrong in this household's real data
// (e.g. "SYGNIR AS", "LINGU AS - LINGU.NO"). Not exhaustive, just the
// shapes actually seen in this data; a missed one just means an occasional
// noisy "city" guess, not a crash.
const NOT_A_CITY = new Set(['as', 'asa', 'ans', 'da', 'enk', 'nuf', 'sa', 'mva', 'ab', 'by']);

function extractCity(merchantKey: string): string | null {
  const words = merchantKey.trim().split(/\s+/);
  const last = words[words.length - 1]?.toLowerCase();
  if (!last || last.length < 3 || NOT_A_CITY.has(last)) return null;
  return /^[a-zøæåäöüéè]+$/i.test(last) ? last : null; // alphabetic only — skip terminal codes, numbers, punctuation-heavy tokens
}

async function main() {
  const useContext = process.argv.includes('--context');

  const txs = await prisma.transaction.findMany({
    where: { source: { in: ['mono', 'sparebank', 'voice'] } },
    select: { householdId: true, userId: true, source: true, monoMerchant: true, details: true, categoryId: true, date: true, amount: true },
    orderBy: { date: 'asc' },
  });

  const keyOf = (t: (typeof txs)[number]) => (t.source === 'mono' ? t.monoMerchant : t.details) || '';

  // Ground truth: for each merchantKey, the FULL representative row (most
  // recent occurrence) — category for correctness, and its own amount/
  // date/userId as the "instance" the context signals describe. A merchant
  // occasionally appears under more than one category across history (a
  // correction changed it partway through) — the latest, settled answer is
  // what's worth testing against.
  const truth = new Map<string, { categoryId: number; householdId: number; userId: number | null; date: Date; amount: number }>();
  for (const t of txs) {
    const raw = keyOf(t).trim();
    if (!raw) continue;
    const merchantKey = raw.toLowerCase().replace(/\s+/g, ' ');
    truth.set(merchantKey, { categoryId: t.categoryId, householdId: t.householdId, userId: t.userId, date: t.date, amount: t.amount }); // date-ascending source, so later overwrites earlier
  }

  // Per-user city history, built from ALL transactions (not just the
  // deduped pairs) — the city TOKEN itself doesn't reveal a category label,
  // so using the full set here isn't the kind of answer-leak the few-shot
  // examples were; it's just "how does this user's life actually look".
  const cityDatesByUser = new Map<number, Map<string, Set<string>>>(); // userId -> city -> set of date-strings seen
  const citiesByUserDate = new Map<string, Set<string>>(); // "userId:dateStr" -> set of cities seen that day
  for (const t of txs) {
    if (t.userId === null) continue;
    const raw = keyOf(t).trim();
    const city = raw ? extractCity(raw.toLowerCase().replace(/\s+/g, ' ')) : null;
    if (!city) continue;
    const dateStr = t.date.toISOString().slice(0, 10);
    if (!cityDatesByUser.has(t.userId)) cityDatesByUser.set(t.userId, new Map());
    const perCity = cityDatesByUser.get(t.userId)!;
    if (!perCity.has(city)) perCity.set(city, new Set());
    perCity.get(city)!.add(dateStr);
    const dayKey = `${t.userId}:${dateStr}`;
    if (!citiesByUserDate.has(dayKey)) citiesByUserDate.set(dayKey, new Set());
    citiesByUserDate.get(dayKey)!.add(city);
  }

  const userNames = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map(u => [u.id, u.name]));

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
    .map(([merchantKey, v]) => ({ merchantKey, ...v, cat: categoryById.get(v.categoryId) }))
    .filter((p): p is typeof p & { cat: NonNullable<typeof p.cat> } => !!p.cat && (p.cat.type === 'expense' || p.cat.type === 'income'));

  // "Typical" = seen on 3+ distinct OTHER dates historically for this user
  // — a simple, defensible line between "somewhere they actually go" and
  // "somewhere new/rare", not tuned against this eval's own answers.
  const TYPICAL_THRESHOLD = 3;
  function buildContext(p: (typeof pairs)[number]): string {
    const parts: string[] = [];
    parts.push(`сума ${p.amount} kr`);
    parts.push(DAY_NAMES[p.date.getUTCDay()]);
    if (p.userId !== null && userNames.has(p.userId)) parts.push(`платив(ла) ${userNames.get(p.userId)}`);

    const city = extractCity(p.merchantKey);
    if (city && p.userId !== null) {
      const dateStr = p.date.toISOString().slice(0, 10);
      const datesForCity = cityDatesByUser.get(p.userId)?.get(city) ?? new Set();
      const otherDates = [...datesForCity].filter(d => d !== dateStr).length;
      const typical = otherDates >= TYPICAL_THRESHOLD;
      parts.push(`місто з опису "${city}" — ${typical ? `типове для цього користувача (бачили ${otherDates} інших днів)` : 'НЕтипове/нове місто для цього користувача'}`);

      if (!typical) {
        const dayKey = `${p.userId}:${dateStr}`;
        const citiesThatDay = citiesByUserDate.get(dayKey) ?? new Set();
        const otherUnusualThatDay = [...citiesThatDay].filter(c => c !== city && (cityDatesByUser.get(p.userId!)?.get(c)?.size ?? 0) < TYPICAL_THRESHOLD).length;
        if (otherUnusualThatDay > 0) parts.push(`того ж дня ще ${otherUnusualThatDay} транзакцій у теж нетипових місцях — можливо, поїздка`);
      }
    }
    return parts.join(', ');
  }

  console.log(`Evaluating ${pairs.length} labeled (merchant -> category) pairs against the live LLM tier (openai/gpt-oss-120b)${useContext ? ' WITH Ф2c+Ф3 context signals' : ' WITHOUT context (baseline)'}...`);
  if (useContext) {
    const withCity = pairs.filter(p => extractCity(p.merchantKey) !== null).length;
    console.log(`(city extracted for ${withCity}/${pairs.length} pairs — the rest still get amount/day/payer only)`);
  }

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
      const p = pairs[i];
      const names = (categoriesByHousehold.get(p.householdId) ?? []).filter(c => c.type === p.cat.type).map(c => c.name);
      const context = useContext ? buildContext(p) : undefined;
      const guess = await guessCategoryByLLM(p.merchantKey, names, context);
      if (guess === null) abstained++;
      else if (guess === p.cat.name) correct++;
      else { wrong++; mismatches.push({ merchantKey: p.merchantKey, expected: p.cat.name, got: guess }); }
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
