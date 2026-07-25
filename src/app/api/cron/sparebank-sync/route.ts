import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { safeEqual } from '@/lib/pin';
import { syncSparebankUser, EnableBankingError } from '@/lib/sparebankSync';
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
// The workflow instead fires at BOTH UTC candidate hours for each Oslo
// target; this handler is the real gate — it only does anything when the
// current Oslo wall-clock hour actually matches TARGET_HOURS_OSLO, so
// exactly one of the daily fires does real work per target and the other is
// a harmless no-op.
//
// Week 1 (2026-07-25): a single midnight slot only, per explicit user
// decision to watch how Enable Banking's undocumented unattended quota
// behaves in practice before adding the second (noon) slot.
const TARGET_HOURS_OSLO = [0];

// Guards against the same day's two DST-candidate cron fires both matching
// (shouldn't happen since only one can equal a TARGET_HOURS_OSLO value on
// any given day, but a stray manual re-trigger or Vercel retry could still
// double-fire) — a wasted unattended-quota call is not recoverable today.
const MIN_GAP_HOURS = 12;

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
    where: { sbAutoSync: true, sbAccountUid: { not: null }, sbSessionEnc: { not: null } },
    select: {
      id: true, name: true, householdId: true, telegramId: true,
      sbAccountUid: true, sbLastSyncedAt: true, sbSyncFloor: true, sbValidUntil: true,
      sbLastAutoSyncAt: true, sbSyncFailCount: true,
    },
  });

  const results: Array<Record<string, unknown>> = [];

  for (const user of users) {
    if (!user.householdId || !user.sbAccountUid) continue; // schema allows null; an opted-in row always has both set in practice

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

    try {
      const result = await syncSparebankUser(
        { id: user.id, sbAccountUid: user.sbAccountUid, sbLastSyncedAt: user.sbLastSyncedAt, sbSyncFloor: user.sbSyncFloor },
        user.householdId,
        null, // unattended — no real end-user behind a scheduled job
      );
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: 0 } });
      results.push({ userId: user.id, created: result.createdIds.length, checked: result.checked });
    } catch (e) {
      const newFailCount = user.sbSyncFailCount + 1;
      await prisma.user.update({ where: { id: user.id }, data: { sbLastAutoSyncAt: new Date(), sbSyncFailCount: newFailCount } });
      const message = e instanceof EnableBankingError ? e.message : 'невідома помилка';
      console.error('[cron/sparebank-sync] sync failed for user', user.id, e);
      results.push({ userId: user.id, error: message });
      // First failure pages immediately; after that, only every 3rd
      // consecutive one — a single-day blip shouldn't notify anyone, but a
      // sync that's been broken for days must not stay silently unnoticed.
      if (user.telegramId && (newFailCount === 1 || newFailCount % 3 === 0)) {
        await sendMessage(Number(user.telegramId), `⚠️ Автосинхронізація SpareBank 1 для ${user.name} не вдалась (${newFailCount}-й раз поспіль): ${message}`);
      }
    }
  }

  return NextResponse.json({ ok: true, results });
}
