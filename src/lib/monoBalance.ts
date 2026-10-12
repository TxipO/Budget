import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { getClientInfo, pickMonoAccount, MonobankError } from '@/lib/monobank';
import { MONO_CCY_NAMES } from '@/lib/monoIngest';

// Reads the tracked card's balance from Monobank's client-info and stores it on
// the User row (monoBalance*). One call, ~1/60s per token at Monobank's end.
// NEVER throws — same contract as lib/sparebankBalances.ts: a balance is a
// nice-to-have riding on a sync/cron, never a reason to fail it. The amount is
// in the ACCOUNT's own currency (UAH for a normal card), not the household's.
export interface MonoBalanceResult {
  ok: boolean;
  amount: number | null;
  currency: string | null;
  status?: number; // Monobank HTTP status of a failed call (429 = rate-limited)
  error?: string;
}

export async function refreshMonoBalance(userId: number): Promise<MonoBalanceResult> {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { monoTokenEnc: true, monoAccountId: true } });
    if (!user?.monoTokenEnc) return { ok: false, amount: null, currency: null, error: 'not connected' };
    const info = await getClientInfo(decrypt(user.monoTokenEnc));
    const accounts = info.accounts ?? [];
    const account = accounts.find(a => a.id === user.monoAccountId) ?? pickMonoAccount(accounts);
    if (!account || !Number.isFinite(account.balance)) return { ok: false, amount: null, currency: null, error: 'no account' };
    const amount = Math.round(account.balance) / 100; // kopecks -> UAH, exactly 2 decimals
    const currency = MONO_CCY_NAMES[account.currencyCode] ?? String(account.currencyCode);
    await prisma.user.update({
      where: { id: userId },
      data: { monoBalanceAmount: amount, monoBalanceCurrency: currency, monoBalanceFetchedAt: new Date() },
    });
    return { ok: true, amount, currency };
  } catch (e) {
    console.error('[monoBalance] failed for user', userId, e instanceof MonobankError ? `${e.status} ${e.message}` : e);
    if (e instanceof MonobankError) return { ok: false, amount: null, currency: null, status: e.status, error: e.message };
    return { ok: false, amount: null, currency: null };
  }
}

// Cron entry: every connected user whose stored balance is older than maxAgeMs
// (or never fetched), sequentially, each isolated. Independent of SpareBank
// settings — a Monobank-only user has no row in the SpareBank cron query.
// userIds narrows the scan (tests; the cron passes nothing = everyone).
// Summary rows carry no amounts (the cron response lands in Actions logs).
export const MONO_BALANCE_MAX_AGE_MS = 5 * 3600 * 1000;

export async function refreshStaleMonoBalances(opts?: { maxAgeMs?: number; userIds?: number[] }) {
  const cutoff = new Date(Date.now() - (opts?.maxAgeMs ?? MONO_BALANCE_MAX_AGE_MS));
  const users = await prisma.user.findMany({
    where: {
      monoTokenEnc: { not: null },
      ...(opts?.userIds ? { id: { in: opts.userIds } } : {}),
      OR: [{ monoBalanceFetchedAt: null }, { monoBalanceFetchedAt: { lt: cutoff } }],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const out: Array<{ userId: number; ok: boolean; status?: number }> = [];
  for (const u of users) {
    const r = await refreshMonoBalance(u.id);
    out.push({ userId: u.id, ok: r.ok, ...(r.status ? { status: r.status } : {}) });
  }
  return out;
}
