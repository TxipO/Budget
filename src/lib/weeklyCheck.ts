import { prisma } from '@/lib/prisma';
import { notifyHousehold } from '@/lib/telegramBot';
import { llmTierStatus } from '@/lib/llmStatus';
import { poolBalance } from '@/lib/savingsBreakdown';

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

  // Pool vs bank, ABSOLUTE: the app's balance of a pool category (every row of it, computed
  // exactly like the dashboard: lib/savingsBreakdown) must equal the summed stored balance of
  // the SpareBank accounts mapped to it. Any gap > 1 kr is reported EVERY week until fixed.
  // (The earlier version compared only the CHANGE between snapshots, so a static offset such
  // as the 250 kr double-counted transfer of 2026-11-10 alerted once and became the baseline
  // forever; this subsumes it - equal absolute levels imply equal changes - and needs no state.)
  // The app side is counted AS OF the balance's own fetch time (rows created <= the oldest
  // balanceFetchedAt of the pool): rows ingested after the last balance read are in the app and
  // not yet in the bank figure. A pool whose balances are not in the household currency is
  // skipped (no FX here).
  await safe('подушка', async () => {
    const accts = await prisma.sparebankAccount.findMany({
      where: { categoryId: { not: null }, balanceAmount: { not: null }, balanceFetchedAt: { not: null }, category: { type: 'savings', isActive: true }, user: { householdId: inHh } },
      select: { label: true, categoryId: true, balanceAmount: true, balanceCurrency: true, balanceFetchedAt: true, user: { select: { householdId: true, household: { select: { currency: true } } } } },
    });
    const pools = new Map<number, typeof accts>();
    for (const a of accts) pools.set(a.categoryId!, [...(pools.get(a.categoryId!) ?? []), a]);
    for (const [categoryId, group] of pools) {
      if (group.some(a => (a.balanceCurrency ?? 'NOK') !== (a.user.household?.currency ?? 'NOK'))) continue;
      const bank = r2(group.reduce((t, a) => t + a.balanceAmount!, 0));
      const fetchedAt = new Date(Math.min(...group.map(a => a.balanceFetchedAt!.getTime())));
      const rows = await prisma.transaction.findMany({
        where: { categoryId, createdAt: { lte: fetchedAt } },
        select: { categoryId: true, amount: true, savingsWithdrawal: true, isTransfer: true, category: { select: { name: true, color: true, icon: true, type: true } } },
      });
      const app = poolBalance(rows), diff = r2(bank - app);
      if (Math.abs(diff) > 1) add(group[0].user.householdId, `Подушка «${group.map(a => a.label).join(' + ')}»: в обліку ${app} kr, у банку ${bank} kr, різниця ${diff} kr (баланс банку на ${dm(fetchedAt)}). Перевір перекази між рахунками; нагадуватиму щотижня, поки не виправлено.`);
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

  // «Connected, no errors, but silently empty»: 2026-11-11 Monobank was bound to an empty
  // EUR account, every sync "succeeded" with 0 rows while the real card kept spending.
  // Snapshot {balanceAmount, fetchedAt} per feed in AppSetting 'balanceCheck:<mono:userId|sb:accountId>';
  // once a fresher balance differs by >= 1 unit but the feed produced no row (created or
  // dated) since the snapshot, the selected card/account is probably the wrong one.
  // First run only seeds. ponytail: a feed that is really idle but earns/loses >= 1 unit
  // (interest, fees) alerts once per change; raise MIN_DELTA if that gets noisy.
  await safe('баланс без транзакцій', async () => {
    const check = async (key: string, balance: number, fetchedAt: Date, rowsSince: (since: Date) => Promise<number>) => {
      const prev = await prisma.appSetting.findUnique({ where: { key } });
      const snap = prev ? JSON.parse(prev.value) : null;
      if (snap && fetchedAt <= new Date(snap.fetchedAt)) return null; // no fresher balance yet
      const since = snap ? new Date(snap.fetchedAt) : null;
      const alert = since && Math.abs(balance - snap.balanceAmount) >= 1 && (await rowsSince(since)) === 0
        ? Math.max(1, Math.round((fetchedAt.getTime() - since.getTime()) / 864e5)) : null;
      const value = JSON.stringify({ balanceAmount: balance, fetchedAt: fetchedAt.toISOString() });
      await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      return alert;
    };
    const win = (since: Date) => ({ OR: [{ createdAt: { gt: since } }, { date: { gte: new Date(since.getTime() - 864e5) } }] });
    const monoUsers = await prisma.user.findMany({
      where: { householdId: inHh, monoTokenEnc: { not: null }, monoAccountId: { not: null }, monoBalanceAmount: { not: null }, monoBalanceFetchedAt: { not: null } },
      select: { id: true, name: true, householdId: true, monoBalanceAmount: true, monoBalanceFetchedAt: true },
    });
    for (const u of monoUsers) {
      const days = await check(`balanceCheck:mono:${u.id}`, u.monoBalanceAmount!, u.monoBalanceFetchedAt!, since => prisma.transaction.count({ where: { userId: u.id, source: 'mono', ...win(since) } }));
      if (days) add(u.householdId, `Monobank ${u.name}: баланс змінився, а транзакцій за ${days} дн. немає — перевірте вибрану картку в Налаштуваннях.`);
    }
    const sbAccts = await prisma.sparebankAccount.findMany({
      where: { syncEnabled: true, balanceAmount: { not: null }, balanceFetchedAt: { not: null }, user: { householdId: inHh } },
      select: { id: true, label: true, balanceAmount: true, balanceFetchedAt: true, user: { select: { name: true, householdId: true } } },
    });
    for (const a of sbAccts) {
      const days = await check(`balanceCheck:sb:${a.id}`, a.balanceAmount!, a.balanceFetchedAt!, since => prisma.transaction.count({ where: { source: 'sparebank', sbTransactionId: { startsWith: `sb${a.id}|` }, ...win(since) } }));
      if (days) add(a.user.householdId, `SpareBank «${a.label}» (${a.user.name}): баланс змінився, а транзакцій за ${days} дн. немає — перевірте, що синхронізується потрібний рахунок.`);
    }
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
