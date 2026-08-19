import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/pin';
import { syncSparebankAccount, EnableBankingError } from '@/lib/sparebankSync';
import { sendMessage } from '@/lib/telegramBot';

// Unattended background sync, opt-in per user (User.sbAutoSync) — the cron
// counterpart to api/sparebank/sync's manual button. No end-user request
// exists behind a scheduled trigger, so this deliberately passes `null` as
// the PSU to lib/sparebankSync.ts's shared algorithm (see getTransactions'
// own comment on why faking a PSU would be dishonest, not just risky) — that
// routes every call here into Enable Banking's small ~4/day UNATTENDED
// quota, a separate bucket from what manual clicks use, by design.
//
// The scheduled trigger (.github/workflows/sparebank-sync.yml — Vercel
// Hobby's Cron Jobs hard-cap the whole config at one fire per day, which a
// two-candidate-per-day schedule violates, so GitHub Actions carries the
// schedule instead) always fires in UTC. Europe/Oslo's UTC offset flips
// between +1 (CET) and +2 (CEST) twice a year, so a single fixed UTC time
// would silently drift an hour off "Oslo midnight" across the DST boundary.
// The workflow fires at BOTH UTC candidate hours for each Oslo target; this
// handler is the real gate — it only does anything when the current Oslo
// wall-clock hour actually matches TARGET_HOURS_OSLO.
//
// A single exact hour (just [0]) turned out to be too narrow: confirmed live
// 2026-07-31, after 6 days of daily runs, that EVERY run had silently no-op'd
// — `gh run list` showed all of them "success", but every response body was
// {"skipped":"not a target hour"}. GitHub Actions' own scheduled-workflow
// docs warn triggers are best-effort and "may be delayed during periods of
// high load"; both daily fires were consistently landing 55–70 minutes after
// their nominal time (the 22:00 UTC entry executing around 22:55–23:12, the
// 23:00 UTC entry around 00:01–00:07 the next day) — just far enough past
// midnight in Oslo that neither ever matched hour 0 exactly. Widened to a
// window rather than a point; MIN_GAP_HOURS below already stops the other
// daily fire (they land about an hour apart) from double-triggering once one
// of them lands inside it.
//
// Week 1 (2026-07-25) ran a single midnight window only, to watch how Enable
// Banking's undocumented unattended quota behaves in practice. Held up clean
// (0 failures), so a second (noon) window was added 2026-08-19 — each window
// is its own 4-hour band for the same reason the midnight one is: GitHub
// Actions' scheduled triggers land 55-70 min late (see the dated comment
// above), so a single exact hour would silently never match.
const TARGET_HOURS_OSLO = [23, 0, 1, 2, 11, 12, 13, 14];

// Guards against the same window's two DST-candidate cron fires both
// matching (a stray manual re-trigger or Vercel retry could still
// double-fire) while still letting the midnight and noon windows both run —
// must clear the ~2-3h worst-case gap between two candidates in the SAME
// window, but stay under the shortest gap BETWEEN windows (a run landing at
// the very end of the midnight window, e.g. 02:59 Oslo, and the next firing
// at the very start of noon's, e.g. 11:00 Oslo, are only ~8h01m apart). 12h
// used to be safe when there was only one window a day; halved to 6h so it
// still clears same-window double-fires without also blocking the noon run.
const MIN_GAP_HOURS = 6;

// Reminders at exactly these thresholds, not every day of the final week —
// a person doesn't need "expires in 6 days", "5 days", "4 days"... daily.
const CONSENT_WARN_DAYS = [7, 3, 1];

function osloHourNow(): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Oslo', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  return Number(parts.find(p => p.type === 'hour')?.value);
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

  if (!TARGET_HOURS_OSLO.includes(osloHourNow())) {
    return NextResponse.json({ ok: true, skipped: 'not a target hour in Europe/Oslo' });
  }

  const users = await prisma.user.findMany({
    where: { sbAutoSync: true, sbSessionEnc: { not: null }, sparebankAccounts: { some: { syncEnabled: true } } },
    select: {
      id: true, name: true, householdId: true, telegramId: true, sbValidUntil: true,
      sbLastAutoSyncAt: true, sbSyncFailCount: true,
      sparebankAccounts: { where: { syncEnabled: true }, select: { id: true, userId: true, accountUid: true, lastSyncedAt: true, syncFloor: true } },
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
        if (user.telegramId) {
          await sendMessage(Number(user.telegramId), `⚠️ Доступ SpareBank 1 для ${user.name} прострочено — автосинхронізація зупинена. Перепідключіть банк у Налаштуваннях.`);
        }
        continue;
      }
      if (user.telegramId && CONSENT_WARN_DAYS.includes(daysLeft)) {
        await sendMessage(Number(user.telegramId), `⏳ Доступ SpareBank 1 для ${user.name} закінчується через ${daysLeft} дн. Перепідключіть банк заздалегідь у Налаштуваннях, щоб не перервати автосинхронізацію.`);
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
      } catch (e) {
        userFailed = true;
        lastMessage = e instanceof EnableBankingError ? e.message : 'невідома помилка';
        console.error('[cron/sparebank-sync] sync failed for account', account.id, 'user', user.id, e);
      }
    }

    if (!userFailed) {
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: 0 } });
      results.push({ userId: user.id, created: userCreated, checked: userChecked });
    } else {
      const newFailCount = user.sbSyncFailCount + 1;
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: newFailCount } });
      results.push({ userId: user.id, error: lastMessage });
      // First failure pages immediately; after that, only every 3rd
      // consecutive one — a single-day blip shouldn't notify anyone, but a
      // sync that's been broken for days must not stay silently unnoticed.
      if (user.telegramId && (newFailCount === 1 || newFailCount % 3 === 0)) {
        await sendMessage(Number(user.telegramId), `⚠️ Автосинхронізація SpareBank 1 для ${user.name} не вдалась (${newFailCount}-й раз поспіль): ${lastMessage}`);
      }
    }
  }

  return NextResponse.json({ ok: true, results });
}
