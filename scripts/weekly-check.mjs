// Weekly health check (BudgetSelfcheck task, Mon 09:03). No AI, no git, read-only.
//  1. node scripts/verify-data-integrity.mjs -> parse "Summary: N FAIL, M WARN"
//  2. newest backups/budget-*.json.gz must be < 50h old
//  3. savings-pool cross-check: the bank's stored balance change vs the app's pool change
// Silent when OK. On problems: Ukrainian Telegram message to every household-1 user with a
// telegramId (bot token = TELEGRAM_BOT_TOKEN from .env, same as src/lib/telegramBot.ts).
// WEEKLY_CHECK_TEST=1 forces the alert path with a "Тест:" prefix. Exit 1 on real problems.
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
try { process.loadEnvFile('.env'); } catch { /* handled below via missing token */ }

const test = process.env.WEEKLY_CHECK_TEST === '1';
const logDir = join(root, '.claude', 'logs');
mkdirSync(logDir, { recursive: true });
const d = new Date(), p = (n) => String(n).padStart(2, '0');
const logFile = join(logDir, `weekly-check-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.log`);
const log = (s) => { console.log(s); appendFileSync(logFile, `[${d.toISOString()}] ${s}\n`); };

const problems = [];
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 1. data integrity
const v = spawnSync(process.execPath, ['scripts/verify-data-integrity.mjs'], { encoding: 'utf8', timeout: 5 * 60_000 });
const out = strip((v.stdout ?? '') + (v.stderr ?? ''));
const m = out.match(/Summary: (\d+) FAIL, (\d+) WARN/);
if (!m) {
  problems.push(`verify-data-integrity впав (код ${v.status ?? v.signal}):\n${out.trim().split('\n').slice(-5).join('\n')}`);
} else {
  log(`verify: ${m[1]} FAIL, ${m[2]} WARN`);
  if (+m[1] > 0) problems.push(`Перевірка цілісності даних: ${m[1]} FAIL:\n${out.split('\n').filter((l) => l.includes('FAIL')).slice(0, 5).join('\n')}`);
}

// 2. backup freshness
const bdir = join(root, 'backups');
let newest = 0;
try {
  for (const f of readdirSync(bdir)) if (/^budget-.*\.json\.gz$/.test(f)) newest = Math.max(newest, statSync(join(bdir, f)).mtimeMs);
} catch { /* no dir -> stale */ }
const ageH = newest ? (Date.now() - newest) / 3.6e6 : Infinity;
log(`backup age: ${ageH === Infinity ? 'none' : ageH.toFixed(1) + 'h'}`);
if (ageH >= 50) problems.push(newest ? `Бекап застарілий: ${Math.round(ageH)} год (ліміт 50).` : 'Бекапів немає.');

// 3. pool cross-check. No bank API calls: uses only the balance the app already stored
// (SparebankAccount.balanceAmount/balanceFetchedAt, refreshed by the app itself). The
// absolute levels can't be compared (the pool has history from before the bank connection),
// so a snapshot {balanceAmount, balanceFetchedAt, poolSum} per pool account is kept in
// AppSetting 'poolCheck:<accountId>' and, once the stored balance is newer than the snapshot,
// the bank's CHANGE is compared with the CHANGE of the app's counted sparebank rows in that
// pool category. A mismatch > 1 kr = a transfer leg got lost / double counted (the 2026-10
// "both legs excluded" bug showed up as exactly this). First run only seeds the snapshot.
// ponytail: assumes one mapped account per pool category; sum the balances if that changes.
const prisma = new PrismaClient();
try {
  const accts = await prisma.sparebankAccount.findMany({
    where: { categoryId: { not: null }, balanceAmount: { not: null }, balanceFetchedAt: { not: null }, category: { type: 'savings', isActive: true } },
    select: { id: true, label: true, categoryId: true, balanceAmount: true, balanceFetchedAt: true },
  });
  const r2 = (n) => Math.round(n * 100) / 100;
  const dm = (dt) => `${p(dt.getUTCDate())}.${p(dt.getUTCMonth() + 1)}`;
  for (const a of accts) {
    const rows = await prisma.transaction.findMany({ where: { categoryId: a.categoryId, source: 'sparebank', isTransfer: false }, select: { amount: true, savingsWithdrawal: true } });
    const poolSum = r2(rows.reduce((t, x) => t + (x.savingsWithdrawal ? -x.amount : x.amount), 0));
    const key = `poolCheck:${a.id}`;
    const prev = await prisma.appSetting.findUnique({ where: { key } });
    const snap = prev ? JSON.parse(prev.value) : null;
    if (snap && a.balanceFetchedAt <= new Date(snap.balanceFetchedAt)) continue; // no fresher balance yet
    if (snap) {
      const dBank = r2(a.balanceAmount - snap.balanceAmount), dApp = r2(poolSum - snap.poolSum);
      log(`pool ${a.label}: bank ${dBank >= 0 ? '+' : ''}${dBank}, app ${dApp >= 0 ? '+' : ''}${dApp}`);
      if (Math.abs(dBank - dApp) > 1) problems.push(`Подушка «${a.label}»: з ${dm(new Date(snap.balanceFetchedAt))} по ${dm(a.balanceFetchedAt)} баланс у банку змінився на ${dBank} kr, а в застосунку на ${dApp} kr (різниця ${r2(dBank - dApp)} kr). Перевір перекази між рахунками.`);
    }
    const value = JSON.stringify({ balanceAmount: a.balanceAmount, balanceFetchedAt: a.balanceFetchedAt.toISOString(), poolSum });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
} catch (e) { problems.push(`Перевірка подушки впала: ${e.message}`); }

// 4. alert
let code = 0;
if (test) problems.unshift('Тест: щотижнева перевірка налаштована (це одноразове тестове повідомлення).');
if (problems.length) {
  const text = (test ? '' : 'Бюджет, щотижнева перевірка:\n') + problems.join('\n\n');
  log(`PROBLEMS:\n${text}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { log('TELEGRAM_BOT_TOKEN не задано в .env: повідомлення не надіслано.'); code = 1; }
  else {
    try {
      const users = await prisma.user.findMany({ where: { householdId: 1, telegramId: { not: null } }, select: { telegramId: true } });
      for (const u of users) {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: u.telegramId, text: text.slice(0, 3500) }),
        });
        log(`telegram ${u.telegramId}: ${r.status}`);
        if (!r.ok) code = 1;
      }
      if (!users.length) { log('немає отримувачів з telegramId'); code = 1; }
    } catch (e) { log(`telegram send failed: ${e.message}`); code = 1; }
  }
  if (!test) code = 1;
} else log('OK');
await prisma.$disconnect();

// keep 10 logs
const logs = readdirSync(logDir).filter((f) => /^weekly-check-.*\.log$/.test(f)).sort().reverse();
for (const f of logs.slice(10)) unlinkSync(join(logDir, f));
process.exit(code);
