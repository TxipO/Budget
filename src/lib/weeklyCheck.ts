import { prisma } from '@/lib/prisma';
import { notifyHousehold } from '@/lib/telegramBot';
import { llmTierStatus } from '@/lib/llmStatus';

// Server-side weekly health check, fired from the cron route (GitHub Actions ~2x/day).
// It used to live only in scripts/weekly-check.mjs on the laptop (Task Scheduler);
// that task silently missed two Mondays and a pool/bank mismatch sat unnoticed for
// a week. Read-only against the banks (stored balances only, no API calls). What
// stays local: data-integrity verify and backup-file age (laptop disk).
//
// Gate: AppSetting `<prefix>:lastRunAt`, at most once per WEEK_MS. The dashboard
// badge goes up when that marker is older than 8 days (api/sparebank/status).
// keyPrefix/householdIds exist for tests; the cron passes nothing.
const WEEK_MS = 7 * 24 * 3600 * 1000;
const STALE_BALANCE_MS = 3 * 24 * 3600 * 1000;
const AUTOSYNC_STALE_H = 36;

const p2 = (n: number) => String(n).padStart(2, '0');
const dm = (d: Date) => `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

async function collectProblems(householdIds?: number[]): Promise<Map<number, string[]>> {
  const hhs = householdIds ?? (await prisma.household.findMany({ select: { id: true } })).map(h => h.id);
  const out = new Map<number, string[]>();
  const add = (hid: number | null | undefined, text: string) => {
    for (const h of hid == null ? hhs : [hid]) out.set(h, [...(out.get(h) ?? []), text]);
  };
  // One crashing check must not hide the rest; its crash goes to everyone in scope.
  const safe = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      console.error('[weeklyCheck]', name, e);
      add(null, `Перевірка «${name}» впала: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const inHh = { in: hhs };

  // Pool vs bank. The absolute levels can't be compared (the pool has history from
  // before the bank connection), so a snapshot {balanceAmount, balanceFetchedAt, poolSum}
  // per pool account is kept in AppSetting 'poolCheck:<accountId>' and, once the stored
  // balance is newer than the snapshot, the bank's CHANGE is compared with the CHANGE
  // of the app's counted sparebank rows in that pool category. A mismatch > 1 kr = a
  // transfer leg got lost / double counted. First run only seeds the snapshot.
  // The app side is counted AS OF the balance's own fetch time (rows created <=
  // balanceFetchedAt): rows ingested after the last balance read are in the app and
  // not yet in the bank figure. Snapshots carry v:2; an older one is re-seeded.
  // ponytail: assumes one mapped account per pool category; sum the balances if that changes.
  await safe('подушка', async () => {
    const accts = await prisma.sparebankAccount.findMany({
      where: { categoryId: { not: null }, balanceAmount: { not: null }, balanceFetchedAt: { not: null }, category: { type: 'savings', isActive: true }, user: { householdId: inHh } },
      select: { id: true, label: true, categoryId: true, balanceAmount: true, balanceFetchedAt: true, user: { select: { householdId: true } } },
    });
    for (const a of accts) {
      const fetchedAt = a.balanceFetchedAt!, balance = a.balanceAmount!;
      const rows = await prisma.transaction.findMany({ where: { categoryId: a.categoryId!, source: 'sparebank', isTransfer: false, createdAt: { lte: fetchedAt } }, select: { amount: true, savingsWithdrawal: true } });
      const poolSum = r2(rows.reduce((t, x) => t + (x.savingsWithdrawal ? -x.amount : x.amount), 0));
      const key = `poolCheck:${a.id}`;
      const prev = await prisma.appSetting.findUnique({ where: { key } });
      const snap = prev ? JSON.parse(prev.value) : null;
      if (snap && fetchedAt <= new Date(snap.balanceFetchedAt)) continue; // no fresher balance yet
      if (snap && snap.v === 2) {
        const dBank = r2(balance - snap.balanceAmount), dApp = r2(poolSum - snap.poolSum);
        if (Math.abs(dBank - dApp) > 1) add(a.user.householdId, `Подушка «${a.label}»: з ${dm(new Date(snap.balanceFetchedAt))} по ${dm(fetchedAt)} баланс у банку змінився на ${dBank} kr, а в застосунку на ${dApp} kr (різниця ${r2(dBank - dApp)} kr). Перевір перекази між рахунками.`);
      }
      const value = JSON.stringify({ v: 2, balanceAmount: balance, balanceFetchedAt: fetchedAt.toISOString(), poolSum });
      await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    }
  });

  // Stale balances: the app refreshes them itself (cron ~daily, every sync, the Settings
  // button), so 3+ days old means that stopped working (consent expired, token revoked).
  await safe('свіжість балансів', async () => {
    const cutoff = new Date(Date.now() - STALE_BALANCE_MS);
    const age = (t: Date | null) => (t ? `востаннє ${dm(t)}, ${Math.floor((Date.now() - t.getTime()) / 864e5)} дн. тому` : 'жодного разу не оновлювався');
    const stale = { OR: [{ balanceFetchedAt: null }, { balanceFetchedAt: { lt: cutoff } }] };
    const sb = await prisma.sparebankAccount.findMany({
      where: { syncEnabled: true, user: { householdId: inHh, sbSessionEnc: { not: null } }, ...stale },
      select: { label: true, balanceFetchedAt: true, user: { select: { name: true, householdId: true } } },
    });
    for (const a of sb) add(a.user.householdId, `Баланс рахунку «${a.label}» (${a.user.name}) не оновлюється: ${age(a.balanceFetchedAt)}. Перевір автосинхронізацію SpareBank 1 / чинність доступу.`);
    const mono = await prisma.user.findMany({
      where: { householdId: inHh, monoTokenEnc: { not: null }, OR: [{ monoBalanceFetchedAt: null }, { monoBalanceFetchedAt: { lt: cutoff } }] },
      select: { name: true, householdId: true, monoBalanceFetchedAt: true },
    });
    for (const u of mono) add(u.householdId, `Баланс Monobank (${u.name}) не оновлюється: ${age(u.monoBalanceFetchedAt)}. Перевір крон і токен Monobank.`);
  });

  // Sync health: the cron alerts on its own failures, but only on the 2nd/3rd/... one
  // and only when Telegram delivery works; this is the independent weekly backstop.
  // SpareBank only for users whose consent is still valid (an expired one is the
  // cron's own 'expired' alert, not a sync fault).
  await safe('автосинхронізація', async () => {
    const now = new Date();
    const sbUsers = await prisma.user.findMany({
      where: { householdId: inHh, sbAutoSync: true, sbSessionEnc: { not: null }, OR: [{ sbValidUntil: null }, { sbValidUntil: { gt: now } }] },
      select: { name: true, householdId: true, sbSyncFailCount: true, sbLastAutoSyncAt: true },
    });
    for (const u of sbUsers) {
      const lastH = u.sbLastAutoSyncAt ? (now.getTime() - u.sbLastAutoSyncAt.getTime()) / 3.6e6 : Infinity;
      if (u.sbSyncFailCount > 0) add(u.householdId, `Автосинхронізація SpareBank 1 (${u.name}) не вдалась ${u.sbSyncFailCount} раз(ів) поспіль.`);
      if (lastH > AUTOSYNC_STALE_H) add(u.householdId, `Автосинхронізація SpareBank 1 (${u.name}) не спрацьовувала ${lastH === Infinity ? 'жодного разу' : Math.round(lastH) + ' год'} (ліміт ${AUTOSYNC_STALE_H}). Перевір GitHub Actions / крон.`);
    }
    const monoUsers = await prisma.user.findMany({
      where: { householdId: inHh, monoTokenEnc: { not: null }, monoAccountId: { not: null }, OR: [{ monoSyncFailCount: { gt: 0 } }, { monoLastSyncError: { not: null } }] },
      select: { name: true, householdId: true, monoSyncFailCount: true, monoLastSyncError: true },
    });
    for (const u of monoUsers) add(u.householdId, `Monobank (${u.name}): синхронізація виписки з помилкою${u.monoSyncFailCount > 0 ? ` (${u.monoSyncFailCount} раз(ів) поспіль)` : ''}${u.monoLastSyncError ? `: ${u.monoLastSyncError}` : ''}.`);
  });

  // LLM tier liveness (Groq): fallback rows piling up with zero LLM decisions.
  await safe('LLM-категоризація', async () => {
    for (const h of hhs) {
      const s = await llmTierStatus(h);
      if (s.status === 'dead') add(h, `Авто-категоризація (Groq) не спрацювала жодного разу за ${s.lookbackDays} днів, хоча ${s.fallbackCount} транзакцій впали в «Незрозуміло». Перевір GROQ_API_KEY.`);
    }
  });

  return out;
}

export async function runWeeklyCheckIfDue(opts?: { householdIds?: number[]; keyPrefix?: string }) {
  const prefix = opts?.keyPrefix ?? 'weeklyCheck';
  const lastKey = `${prefix}:lastRunAt`;
  const last = await prisma.appSetting.findUnique({ where: { key: lastKey } });
  if (last && Date.now() - new Date(last.value).getTime() < WEEK_MS) return { ran: false as const };

  const problems = await collectProblems(opts?.householdIds);
  let total = 0;
  for (const [hid, list] of problems) {
    total += list.length;
    await notifyHousehold(hid, ('Бюджет, щотижнева перевірка:\n' + list.join('\n\n')).slice(0, 3500));
  }
  const upsert = (key: string, value: string) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await upsert(`${prefix}:lastSummary`, total ? `проблем: ${total}` : 'OK');
  await upsert(lastKey, new Date().toISOString()); // last: a crash above leaves the gate open for the next fire
  return { ran: true as const, problems: total };
}
