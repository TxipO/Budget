import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getStatement, MonobankError, recordMonoSyncError } from '@/lib/monobank';
import { ingestStatementItem, MonoStatementItem } from '@/lib/monoIngest';
import { refreshMonoBalance } from '@/lib/monoBalance';
import { notifyHousehold } from '@/lib/telegramBot';

// Push delivery has no guarantee of arriving — Monobank's webhook is
// best-effort, and there is no dashboard or API to inspect missed/failed
// deliveries after the fact. Found live: two settled transfers never
// created a transaction despite a healthy webhook registration, with no
// error logged anywhere (Vercel's log retention had already rolled past
// the window by the time it was noticed). This is the safety net — it
// re-derives from Monobank's own statement (the source of truth) using
// the exact same ingestStatementItem() the webhook uses, so anything the
// push missed gets picked up here, and anything it already recorded is
// skipped via the monoStatementId uniqueness check inside that function.
// Shared by the manual route (api/monobank/sync) and the scheduled one
// (syncMonoUsers below, from the cron route) so the two can never drift.
//
// 30 days, not 7 — widened 2026-07-23 after finding two real UAH
// transactions (01.07, 12.07) still missing three weeks later: the
// per-item batch-abort bug (fixed same day — one bad currency threw and
// silently dropped every OLDER item in that same call, since Monobank
// returns newest-first) had already caused a gap wider than the old 7-day
// window could ever re-cover on its own. 30 is Monobank's own max span for
// a single statement call, so this costs no extra API calls, just a
// bigger one-time response.
const LOOKBACK_DAYS = 30;

export const monoSkippedMsg = (n: number) => `не вдалось обробити ${n} транзакцій (див. логи)`;

export interface MonoSyncUser { id: number; monoTokenEnc: string; monoAccountId: string; monoSyncFloor: Date | null }

export type MonoSyncResult =
  | { ok: true; created: number; skippedHold: number; skippedExisting: number; skippedError: number; checked: number; balance: { ok: boolean; status?: number } }
  | { ok: false; status: number; error: string };

// A Monobank API failure comes back as {ok:false}; anything else (decrypt, DB) throws.
export async function syncMonoUser(user: MonoSyncUser, householdId: number): Promise<MonoSyncResult> {
  const token = decrypt(user.monoTokenEnc);
  const to = Math.floor(Date.now() / 1000);
  // Never let the rolling window cross below a user-set floor — see the
  // field's own schema comment. Without this, every sync re-touches the
  // same rolling 30 days regardless of what was already manually
  // reconciled or deliberately deleted in that range.
  const rollingFrom = to - LOOKBACK_DAYS * 24 * 3600;
  const floorFrom = user.monoSyncFloor ? Math.floor(user.monoSyncFloor.getTime() / 1000) : null;
  const from = floorFrom !== null ? Math.max(rollingFrom, floorFrom) : rollingFrom;

  let items: MonoStatementItem[];
  try {
    items = await getStatement(token, user.monoAccountId, from, to);
  } catch (e) {
    if (e instanceof MonobankError) {
      if (e.status !== 429) await recordMonoSyncError(user.id, e.message); // 429 = rate limit, not a broken link
      return { ok: false, status: e.status, error: e.message };
    }
    throw e;
  }

  let created = 0;
  let skippedHold = 0;
  let skippedExisting = 0;
  let skippedError = 0;
  for (const item of items) {
    // One bad item (e.g. a currency with no rate available at all) must
    // never abort the whole batch — found live 2026-07-23: a single USD
    // transaction's exchange-rate throw 500'd the entire sync, silently
    // hiding every OTHER legitimate transaction in the same 7-day window
    // behind it, not just the one that actually failed.
    try {
      const result = await ingestStatementItem(user.id, householdId, item);
      if (result === 'created') created++;
      else if (result === 'skipped_hold') skippedHold++;
      else if (result === 'skipped_duplicate') skippedExisting++;
    } catch (e) {
      console.error('[monoSync] item failed, continuing with the rest', item.id, e);
      skippedError++;
    }
  }
  // Skipped items stay visible (badge + cron counter) — they would otherwise vanish until a later run happens to succeed.
  await recordMonoSyncError(user.id, skippedError ? monoSkippedMsg(skippedError) : null);

  // Best-effort and last (the statement call above is the one that matters;
  // never throws). A 429 here just means the 60s window hasn't reopened.
  const balance = await refreshMonoBalance(user.id);

  return { ok: true, created, skippedHold, skippedExisting, skippedError, checked: items.length, balance: { ok: balance.ok, ...(balance.status ? { status: balance.status } : {}) } };
}

// Cron entry: every connected user, sequentially, each isolated (one failure never
// reaches the next user or the caller). Statement fetches are ~1 req/60s per token,
// so one per user per run, and only when the last attempt is 6h+ old. Counter and
// alert policy mirror the SpareBank auto-sync: page on the 2nd consecutive failure,
// then every 3rd. userIds narrows the scan (tests; the cron passes nothing).
export const MONO_SYNC_MIN_GAP_MS = 6 * 3600 * 1000;

export async function syncMonoUsers(opts?: { userIds?: number[] }) {
  const users = await prisma.user.findMany({
    where: { monoTokenEnc: { not: null }, monoAccountId: { not: null }, householdId: { not: null }, ...(opts?.userIds ? { id: { in: opts.userIds } } : {}) },
    select: { id: true, name: true, householdId: true, monoTokenEnc: true, monoAccountId: true, monoSyncFloor: true, monoLastSyncAt: true, monoSyncFailCount: true },
    orderBy: { id: 'asc' },
  });
  const out: Array<Record<string, unknown>> = [];
  for (const u of users) {
    if (u.monoLastSyncAt && Date.now() - u.monoLastSyncAt.getTime() < MONO_SYNC_MIN_GAP_MS) { out.push({ userId: u.id, skipped: 'too soon' }); continue; }
    let failure: string | null = null;
    let created = 0;
    try {
      const r = await syncMonoUser({ id: u.id, monoTokenEnc: u.monoTokenEnc!, monoAccountId: u.monoAccountId!, monoSyncFloor: u.monoSyncFloor }, u.householdId!);
      if (!r.ok && r.status === 429) { out.push({ userId: u.id, skipped: 'rate limited' }); continue; } // not a failure, not an attempt
      if (!r.ok) failure = r.error;
      else if (r.skippedError > 0) failure = monoSkippedMsg(r.skippedError);
      else created = r.created;
    } catch (e) {
      failure = 'невідома помилка';
      console.error('[monoSync] cron sync failed for user', u.id, e);
      await recordMonoSyncError(u.id, failure);
    }
    const failCount = failure ? u.monoSyncFailCount + 1 : 0;
    await prisma.user.update({ where: { id: u.id }, data: { monoLastSyncAt: new Date(), monoSyncFailCount: failCount } });
    if (failure && (failCount === 2 || failCount % 3 === 0)) {
      await notifyHousehold(u.householdId!, `⚠️ Синхронізація Monobank для ${u.name} не вдалась (${failCount}-й раз поспіль): ${failure}`);
    }
    out.push(failure ? { userId: u.id, error: failure } : { userId: u.id, created });
  }
  return out;
}
