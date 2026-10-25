import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/pin';
import { syncSparebankAccount, EnableBankingError } from '@/lib/sparebankSync';
import { notifyHousehold } from '@/lib/telegramBot';
import { refreshSparebankBalances } from '@/lib/sparebankBalances';
import { refreshStaleMonoBalances } from '@/lib/monoBalance';

// Unattended background sync, opt-in per user (User.sbAutoSync) — the cron
// counterpart to api/sparebank/sync's manual button. No end-user request
// exists behind a scheduled trigger, so this deliberately passes `null` as
// the PSU to lib/sparebankSync.ts's shared algorithm (see getTransactions'
// own comment on why faking a PSU would be dishonest, not just risky) — that
// routes every call here into Enable Banking's small ~4/day UNATTENDED
// quota, a separate bucket from what manual clicks use, by design.
//
// The scheduled trigger (.github/workflows/sparebank-sync.yml — Vercel
// Hobby's Cron Jobs hard-cap the whole config at one fire per day, so GitHub
// Actions carries the schedule) fires up to four times a day, each possibly
// hours late. This handler is the real gate: see MIN_GAP_HOURS below — it only
// syncs a user whose last auto-sync is old enough, whatever time it is.
// No wall-clock window any more (2026-10-12). GitHub Actions' scheduled
// triggers drift far more than any fixed band could absorb: the "noon" runs
// began landing at ~16:00 UTC and the "midnight" ones at ~01:00-02:00 UTC
// (Oslo hours 18 and 3-4), all of which the old hour gate skipped as "not a
// target hour" — auto-sync silently produced nothing for ~36 hours (the
// 07-31 widening had hit the same wall once already). What actually has to be
// protected is the small unattended bank quota, which is a rate, not a time of
// day — so the gate is the time since this user's last auto-sync: about two real
// syncs a day no matter when GitHub gets around to firing, and the two DST
// candidate fires per window are harmless (the second finds the user "too soon").
// 8, not 10: GitHub fires jitter up to ~2h late, and a 10h gap skipped the
// on-time fire that followed a late one. Failed runs stamp sbLastAutoSyncAt too,
// so a persistently failing user is still retried at most ~3x/day, never hammered.
const MIN_GAP_HOURS = 8;

// Balance refresh (added 2026-10-12, after a stored balance sat 2.5 months stale
// because only a manual button ever updated it). Rides on the same unattended
// quota as the sync, so it is rationed: per syncEnabled account at most ONE
// balance call per ~day, and only right after that user's sync succeeded. The
// windows fire every 12h; the sync itself already spends 1 call/account/window
// (2/day) against a ~4/day cap, and balance-on-every-window would sit exactly
// on that cap — with GitHub's 55-70 min jitter a rolling 24h window then
// catches a 5th call and the TRANSACTION sync (the thing that matters) gets
// the 429. 18h < 24h so the same window slot recurs daily; > 12h so the other
// window of the day skips. A failed balance call never touches userFailed /
// sbSyncFailCount / Telegram — console only — and (not stored) leaves
// balanceFetchedAt old, so the next window retries.
const BALANCE_MIN_AGE_MS = 18 * 3600 * 1000;

// Reminders at exactly these thresholds, not every day of the final week —
// a person doesn't need "expires in 6 days", "5 days", "4 days"... daily.
const CONSENT_WARN_DAYS = [7, 3, 1];

// "Already told them" marker, one AppSetting row per user: value is
// `<consent end ISO>:<daysLeft | expired>`. The cron fires several times a day
// and daysLeft only changes once per 24h, so without this every fire re-sent
// the same warning (and 'expired' on every fire forever). A reconnect moves
// sbValidUntil, which naturally re-arms it.
async function alertOnce(user: { id: number; name: string }, householdId: number, marker: string, text: string) {
  const key = `sbAlert:${user.id}:consent`;
  const prev = await prisma.appSetting.findUnique({ where: { key } });
  if (prev?.value === marker) return;
  await notifyHousehold(householdId, text);
  await prisma.appSetting.upsert({ where: { key }, create: { key, value: marker }, update: { value: marker } });
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron/sparebank-sync] CRON_SECRET not configured — refusing to run');
    return NextResponse.json({ error: 'Not configured' }, { status: 500 });
  }
  const auth = req.headers.get('authorization') ?? '';
  if (!safeEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    where: { sbAutoSync: true, sbSessionEnc: { not: null }, sparebankAccounts: { some: { syncEnabled: true } } },
    select: {
      id: true, name: true, householdId: true, sbValidUntil: true,
      sbLastAutoSyncAt: true, sbSyncFailCount: true,
      sparebankAccounts: { where: { syncEnabled: true }, select: { id: true, userId: true, accountUid: true, lastSyncedAt: true, syncFloor: true, balanceFetchedAt: true } },
    },
  });

  const results: Array<Record<string, unknown>> = [];

  for (const user of users) {
    if (!user.householdId) continue; // schema allows null; an opted-in row always has one in practice

    if (user.sbLastAutoSyncAt && Date.now() - user.sbLastAutoSyncAt.getTime() < MIN_GAP_HOURS * 3600 * 1000) {
      results.push({ userId: user.id, skipped: 'too soon since last auto-sync' });
      continue;
    }

    if (user.sbValidUntil) {
      const daysLeft = Math.ceil((user.sbValidUntil.getTime() - Date.now()) / (24 * 3600 * 1000));
      if (daysLeft <= 0) {
        results.push({ userId: user.id, skipped: 'consent expired' });
        await alertOnce(user, user.householdId, `${user.sbValidUntil.toISOString()}:expired`, `⚠️ Доступ SpareBank 1 для ${user.name} прострочено — автосинхронізація зупинена. Перепідключіть банк у Налаштуваннях.`);
        continue;
      }
      if (CONSENT_WARN_DAYS.includes(daysLeft)) {
        await alertOnce(user, user.householdId, `${user.sbValidUntil.toISOString()}:${daysLeft}`, `⏳ Доступ SpareBank 1 для ${user.name} закінчується через ${daysLeft} дн. Перепідключіть банк заздалегідь у Налаштуваннях, щоб не перервати автосинхронізацію.`);
      }
    }

    // One "too soon"/failure gate per USER, but every syncEnabled account
    // under them gets synced in the same run — same reasoning as the manual
    // sync route's per-account loop.
    let userCreated = 0, userChecked = 0;
    let userFailed = false, lastMessage = '';
    for (const account of user.sparebankAccounts) {
      try {
        const result = await syncSparebankAccount(account, user.householdId, null); // unattended — no real end-user behind a scheduled job
        userCreated += result.createdIds.length;
        userChecked += result.checked;
        // Watermark did not move (item threw / page cap hit) — count it as a
        // failed run so the counter + alert path below fires; see sparebankSync.ts.
        if (result.incomplete) {
          userFailed = true;
          lastMessage = result.skippedError > 0 ? `не вдалось обробити ${result.skippedError} транзакцій (див. логи)` : 'забагато сторінок виписки — синхронізацію обірвано';
          console.error('[cron/sparebank-sync] incomplete sync for account', account.id, 'user', user.id, lastMessage);
        }
      } catch (e) {
        userFailed = true;
        lastMessage = e instanceof EnableBankingError ? e.message : 'невідома помилка';
        console.error('[cron/sparebank-sync] sync failed for account', account.id, 'user', user.id, e);
      }
    }

    if (!userFailed) {
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: 0, sbLastSyncError: null } });
      // Never throws, never feeds the failure bookkeeping above — see
      // BALANCE_MIN_AGE_MS. psu=null: same unattended bucket as the sync.
      const balances = await refreshSparebankBalances(user.sparebankAccounts, null, { minAgeMs: BALANCE_MIN_AGE_MS });
      results.push({ userId: user.id, created: userCreated, checked: userChecked, balances });
    } else {
      const newFailCount = user.sbSyncFailCount + 1;
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: newFailCount, sbLastSyncError: lastMessage } });
      results.push({ userId: user.id, error: lastMessage });
      // A single failed run (a one-off night blip at the bank, 2026-10-25) must
      // not notify anyone — the dashboard badge already shows from the 1st. Page
      // on the 2nd consecutive failure, then every 3rd, so a sync that's been
      // broken for days still can't stay silently unnoticed.
      if (newFailCount === 2 || newFailCount % 3 === 0) {
        await notifyHousehold(user.householdId, `⚠️ Автосинхронізація SpareBank 1 для ${user.name} не вдалась (${newFailCount}-й раз поспіль): ${lastMessage}`);
      }
    }
  }

  // Monobank balances: no bank quota concern (token-based, ~1 req/60s), and
  // independent of SpareBank — a Monobank-only user isn't in the query above.
  // Runs on every authorized fire (GitHub fires up to 4x/day), each user
  // skipped while the stored balance is under 5h old.
  let monoBalances: Awaited<ReturnType<typeof refreshStaleMonoBalances>> = [];
  try {
    monoBalances = await refreshStaleMonoBalances();
  } catch (e) {
    console.error('[cron/sparebank-sync] mono balance refresh failed', e);
  }

  return NextResponse.json({ ok: true, results, monoBalances });
}
