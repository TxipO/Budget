// One-off, guarded migration for the 2026-10 merchant-key overhaul
// (lib/merchantKey.ts + Transaction.merchantText). Dry run by default; writes
// only with --apply. Idempotent (a second --apply finds nothing to do).
//
//   npx tsx scripts/migrate-merchant-keys.mts            # dry run
//   npx tsx scripts/migrate-merchant-keys.mts --apply
//
// Part 1 — backfill Transaction.merchantText for sparebank rows (= details,
//   the text the key was derived from) EXCEPT the rows whose details the user
//   overwrote with a comment (the PUT used to write the comment into the same
//   column): there it is sbCounterparty if non-empty, else left null.
// Part 2 — re-key every MonoCategoryRule through the shared normalizer:
//   keys that become empty/generic are deleted; collisions within one user
//   merge (same category: keep one, sum hitCount; different categories: keep
//   the most recently updated, drop the rest). The printed log is the undo
//   record. Transaction rows are never modified here beyond merchantText.
import { prisma } from '../src/lib/prisma';
import { merchantKey, isGenericKey } from '../src/lib/merchantKey';

const APPLY = process.argv.includes('--apply');
const COMMENT_ROWS = [837, 838, 874, 885, 937, 1112];

async function backfill() {
  console.log('=== Part 1: merchantText backfill ===');
  const rows = await prisma.transaction.findMany({
    where: { source: { in: ['sparebank', 'voice'] }, merchantText: null },
    select: { id: true, source: true, details: true, sbCounterparty: true },
  });
  const plan: { id: number; text: string | null; note: string }[] = [];
  for (const r of rows) {
    if (COMMENT_ROWS.includes(r.id)) {
      const cp = (r.sbCounterparty ?? '').trim();
      plan.push({ id: r.id, text: cp || null, note: cp ? 'comment row -> sbCounterparty' : 'comment row, no counterparty -> stays null' });
    } else {
      plan.push({ id: r.id, text: r.details, note: r.source });
    }
  }
  const toWrite = plan.filter(p => p.text !== null);
  console.log(`rows with merchantText null: ${rows.length} (sparebank ${rows.filter(r => r.source === 'sparebank').length}, voice ${rows.filter(r => r.source === 'voice').length})`);
  console.log(`to set: ${toWrite.length}; left null: ${plan.length - toWrite.length}`);
  for (const p of plan.filter(p => COMMENT_ROWS.includes(p.id))) console.log(`  #${p.id}: ${p.note} ${p.text ? JSON.stringify(p.text) : ''}`);
  for (const p of toWrite.slice(0, 5)) console.log(`  e.g. #${p.id} ${JSON.stringify(p.text)}`);
  if (APPLY) {
    for (const p of toWrite) await prisma.transaction.update({ where: { id: p.id }, data: { merchantText: p.text } });
    console.log(`APPLIED: ${toWrite.length} rows updated`);
  }
}

async function migrateRules() {
  console.log('\n=== Part 2: rule re-key ===');
  const rules = await prisma.monoCategoryRule.findMany({ include: { category: { select: { name: true } } }, orderBy: { id: 'asc' } });
  const byUser = new Map<number, typeof rules>();
  for (const r of rules) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

  const deletes: number[] = [];
  const updates: { id: number; merchantKey: string; hitCount: number; updatedAt: Date }[] = [];
  const fmt = (r: (typeof rules)[number]) => `#${r.id} u${r.userId} ${JSON.stringify(r.merchantKey)} -> ${r.category.name} (hit ${r.hitCount}, upd ${r.updatedAt.toISOString().slice(0, 10)})`;

  for (const [, list] of byUser) {
    const groups = new Map<string, typeof rules>();
    for (const r of list) {
      const nk = merchantKey(r.merchantKey);
      if (isGenericKey(nk)) { deletes.push(r.id); console.log(`DELETE generic/empty: ${fmt(r)}  [key ${JSON.stringify(nk)}]`); continue; }
      groups.set(nk, [...(groups.get(nk) ?? []), r]);
    }
    for (const [nk, g] of groups) {
      if (g.length === 1) {
        if (g[0].merchantKey !== nk) { updates.push({ id: g[0].id, merchantKey: nk, hitCount: g[0].hitCount, updatedAt: g[0].updatedAt }); console.log(`REKEY ${fmt(g[0])}  =>  ${JSON.stringify(nk)}`); }
        continue;
      }
      const sorted = [...g].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id - a.id);
      const win = sorted[0];
      const sameCat = g.filter(r => r.categoryId === win.categoryId);
      const hit = sameCat.reduce((s, r) => s + r.hitCount, 0);
      console.log(`MERGE into ${JSON.stringify(nk)}: keep #${win.id} (${win.category.name}), hit ${win.hitCount} -> ${hit}`);
      for (const r of g) {
        if (r.id === win.id) continue;
        deletes.push(r.id);
        console.log(`   drop ${fmt(r)}${r.categoryId === win.categoryId ? '  [same category, hits summed]' : '  [DIFFERENT category, discarded]'}`);
      }
      updates.push({ id: win.id, merchantKey: nk, hitCount: hit, updatedAt: win.updatedAt });
    }
  }
  console.log(`\nsummary: ${rules.length} rules; delete ${deletes.length}; update ${updates.length}; unchanged ${rules.length - deletes.length - updates.length}`);
  if (APPLY) {
    // Deletes first so a winner re-keyed onto a loser's old key can't hit the unique index.
    await prisma.monoCategoryRule.deleteMany({ where: { id: { in: deletes } } });
    for (const u of updates) await prisma.monoCategoryRule.update({ where: { id: u.id }, data: { merchantKey: u.merchantKey, hitCount: u.hitCount, updatedAt: u.updatedAt } });
    console.log('APPLIED');
  }
}

console.log(APPLY ? 'MODE: APPLY' : 'MODE: dry run (pass --apply to write)');
await backfill();
await migrateRules();
await prisma.$disconnect();
