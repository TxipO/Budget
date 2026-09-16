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

  const [txs, cats, users, plans] = await Promise.all([
    prisma.transaction.findMany({ include: { category: true, user: true } }),
    prisma.category.findMany(),
    prisma.user.findMany(),
    prisma.monthlyPlan.findMany(),
  ]);

  // ── Step 1: orphaned foreign keys ─────────────────────────────────────
  step(1, 'Foreign key integrity');
  const catIds = new Set(cats.map(c => c.id));
  const userIds = new Set(users.map(u => u.id));
  const orphanCat = txs.filter(t => !catIds.has(t.categoryId));
  const orphanUser = txs.filter(t => t.userId !== null && !userIds.has(t.userId));
  if (orphanCat.length) fail(`${orphanCat.length} transactions reference a missing category: ${orphanCat.map(t => t.id).join(',')}`);
  else pass(`all ${txs.length} transactions have a valid categoryId`);
  if (orphanUser.length) fail(`${orphanUser.length} transactions reference a missing user`);
  else pass('all userId references valid');

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

  // ── Step 4d: Monobank connection consistency ────────────────────────────
  step('4d', 'Monobank connection consistency');
  // connect/route.ts sets monoTokenEnc + monoWebhookSecret + monoAccountId
  // together in one update; disconnect/route.ts clears all three together.
  // No code path touches monoWebhookSecret alone — so a user with a token
  // but no webhookSecret means Monobank has nowhere valid to push
  // transactions (their webhook URL embeds the secret), and nothing else in
  // the app surfaces this silently-broken state. Found live 2026-07-08:
  // Паша had monoTokenEnc + monoAccountId but monoWebhookSecret was null,
  // so zero mono transactions had landed despite looking "connected" in
  // Settings (which only checks monoTokenEnc, not webhookSecret).
  const halfConnected = users.filter(u => u.monoTokenEnc && !u.monoWebhookSecret);
  if (halfConnected.length) fail(`${halfConnected.length} user(s) have a Monobank token but no webhookSecret — sync is silently broken: ${halfConnected.map(u => u.name).join(', ')}. Reconnect via Settings.`);
  else pass('every user with a stored Monobank token also has a webhookSecret');

  // ── Step 4e: undetected SpareBank same-person internal transfers ────────
  step('4e', 'SpareBank same-person transfer detection');
  // FOUND LIVE 2026-08-28: a checking<->pillow transfer's first sync landed
  // with creditor_account/debtor_account both still empty (SpareBank hadn't
  // resolved them yet, only a generic placeholder description) — the
  // reconciliation window's own dedup check used to exit before re-checking
  // account numbers on a later re-fetch, so a pair like this could sit
  // undetected indefinitely (fixed in sparebankIngest.ts's
  // `needsReconciliation` path). This is the exact scan that caught it:
  // same user, opposite direction, same amount, within a few days, both
  // still isTransfer:false. A clean run should find 0 — any hit here is a
  // live instance of that bug (or a new variant of it) sitting undetected
  // right now, not a historical record.
  const sbTxs = txs.filter(t => t.source === 'sparebank' && !t.isTransfer && t.userId !== null);
  const sbSuspects = [];
  for (let i = 0; i < sbTxs.length; i++) {
    for (let j = i + 1; j < sbTxs.length; j++) {
      const a = sbTxs[i], b = sbTxs[j];
      if (a.userId !== b.userId || a.amount !== b.amount) continue;
      if (Math.abs(a.date.getTime() - b.date.getTime()) > 3 * 24 * 3600 * 1000) continue;
      const aDir = a.sbTransactionId?.split('|')[2];
      const bDir = b.sbTransactionId?.split('|')[2];
      if (aDir && bDir && aDir !== bDir) sbSuspects.push([a, b]);
    }
  }
  if (sbSuspects.length) {
    fail(`${sbSuspects.length} pair(s) of SpareBank transactions look like an undetected same-person internal transfer:`);
    for (const [a, b] of sbSuspects) {
      console.log(`      #${a.id} <-> #${b.id}: user ${a.userId}, ${a.amount} kr, ${a.date.toISOString().slice(0, 10)}/${b.date.toISOString().slice(0, 10)}, "${a.details}" / "${b.details}"`);
    }
  } else pass('no undetected same-person SpareBank transfer pairs (opposite direction, same amount, same user, within 3 days)');

  // ── Step 4f: rendered row sign agrees with the total it rolls into ──────
  step('4f', 'Row sign vs aggregate sign consistency');
  // FOUND LIVE 2026-08-29, and every previous check missed it because they
  // all verify MATH (totals, FK integrity, amounts) and never the sign the
  // UI actually renders. A "Фінансова подушка" withdrawal displayed "+300"
  // green in both transaction lists while savingsAmount() counted it as
  // -300 in the "Збереження" tile those same rows sum into — one real event
  // reading as a gain in the list and a drop in the total. The arithmetic
  // was right the whole time, so nothing here caught it; only a screenshot did.
  //
  // The rule this asserts: for a savings row, the sign shown next to the
  // pot's own category name must match the sign savingsAmount() gives it.
  // Deposit -> "+" (pot grew), withdrawal -> "-" (pot shrank). The two
  // client components (src/app/page.tsx, src/app/transactions/page.tsx)
  // each build that sign inline, so this reimplements the intended rule and
  // compares — if either component is edited back to the old inverted form,
  // this fails.
  const savingsRows = txs.filter(t => t.category.type === 'savings' && !t.isTransfer);
  const signMismatches = savingsRows.filter(t => {
    const aggregateSign = (t.savingsWithdrawal ? -t.amount : t.amount) >= 0 ? '+' : '-';
    const renderedSign = !t.savingsWithdrawal ? '+' : '-';
    return aggregateSign !== renderedSign;
  });
  if (signMismatches.length) {
    fail(`${signMismatches.length} savings row(s) would render a sign contradicting savingsAmount():`);
    for (const t of signMismatches) console.log(`      #${t.id} ${t.date.toISOString().slice(0, 10)} ${t.amount} withdrawal=${t.savingsWithdrawal} "${t.details}"`);
  } else pass(`all ${savingsRows.length} savings rows render a sign matching the total they sum into`);

  // ── Step 4g: SparebankAccount pool-category mapping integrity ───────────
  step('4g', 'SparebankAccount savings-pool mapping');
  // Ф2 (2026-08-29): SparebankAccount.categoryId asserts "this real account
  // IS this tracked savings pool" — sparebankIngest.ts trusts it directly
  // (no defensive re-check at read time, by design, same as every other FK
  // in this app). The API route validates active+type:savings on write, but
  // a category could still be deactivated or retyped AFTER being mapped —
  // catch that here rather than let it silently misroute future transfers.
  const sbAccountsWithCat = await prisma.sparebankAccount.findMany({
    where: { categoryId: { not: null } },
    select: { id: true, label: true, categoryId: true },
  });
  const badPoolMapping = sbAccountsWithCat.filter(a => {
    const cat = cats.find(c => c.id === a.categoryId);
    return !cat || !cat.isActive || cat.type !== 'savings';
  });
  if (badPoolMapping.length) fail(`${badPoolMapping.length} SparebankAccount(s) map to a missing/inactive/non-savings category: ${badPoolMapping.map(a => `${a.label}(#${a.id})`).join(', ')}`);
  else pass(`${sbAccountsWithCat.length} SparebankAccount savings-pool mapping(s), all point to a valid active savings category`);

  // ── Step 4h: LLM classification tier liveness ───────────────────────────
  step('4h', 'LLM classification tier liveness (categorySource)');
  // FOUND LIVE 2026-09-15: the LLM tier (Groq) sat completely dead for an
  // unknown stretch of time — a retired model id AND an empty prod API key,
  // both failing open ("try the next tier") with zero visible error
  // anywhere. categorySource (added the same day) now records which tier
  // resolved each row, so a repeat of that exact silent failure shows up
  // here instead of only as the eventual symptom (everything piling into
  // "Незрозуміло").
  //
  // Not a bare "did the LLM fire at all" check — the free tiers (rule/mcc/
  // keyword) legitimately cover 100% of some households' merchants some
  // weeks, and failing on that alone would be a false alarm every quiet
  // week. The actual danger sign is fallback rows existing (something
  // reached the end of the chain unresolved) while the LLM tier produced
  // zero decisions in the same window — that's exactly the shape of the
  // incident that started this whole overhaul.
  const LOOKBACK_DAYS = 30;
  const windowStart = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const recentSourced = txs.filter(t => t.categorySource !== null && t.date >= windowStart);
  const recentLlm = recentSourced.filter(t => t.categorySource === 'llm');
  const recentFallback = recentSourced.filter(t => t.categorySource === 'fallback');
  if (recentSourced.length === 0) {
    warn(`no guessCategoryId-routed transactions in the last ${LOOKBACK_DAYS} days yet — not enough data to judge the LLM tier's health`);
  } else if (recentFallback.length > 0 && recentLlm.length === 0) {
    fail(`${recentFallback.length} transaction(s) fell through to the safe fallback in the last ${LOOKBACK_DAYS} days but the LLM tier made zero decisions in that window — possible silent death (dead GROQ_API_KEY or a retired model), check categoryGuess.ts's guessCategoryByLLM live`);
  } else {
    pass(`LLM tier: ${recentLlm.length} decision(s) in the last ${LOOKBACK_DAYS} days (${recentFallback.length} fell through to fallback)`);
  }

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
  // "Враховано деінде" is explicitly excluded from export (2026-09-15) — see
  // export/route.ts's own comment. Every row filed under it already has
  // isTransfer:true, so it never contributed a real number to the export
  // anyway; excluding it here too so this check reflects what the export
  // route actually counts, not a stale total that FAILs even though a real
  // export now succeeds.
  const activeCats = cats.filter(c => c.isActive && c.name !== 'Враховано деінде');
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
    const login = await fetch(`${apiUrl}/api/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: apiPin }),
    });
    // The login response sets TWO cookies (session + PIN-lock "unlocked"
    // marker) — headers.get('set-cookie') only ever returns one of them
    // (undici joins multiple Set-Cookie values with ", " per the Fetch spec,
    // which also collides with the ", " inside each cookie's own Expires
    // date). getSetCookie() returns the real array; every cookie's
    // name=value pair (dropping Path/Expires/etc attributes) is what an
    // actual browser would send back as the request's Cookie header.
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') || null;
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
