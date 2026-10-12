import { prisma } from '@/lib/prisma';
import { getBalances, EnableBankingError, type Psu } from '@/lib/enableBanking';

// Shared by the attended routes (refresh-balances button, manual sync) and the
// unattended cron. One account in, one stored balance out, and it NEVER throws:
// a balance is a nice-to-have riding on top of a sync, so a failure here
// (incl. a 429 from the ASPSP) must not be able to fail the caller's real work.
// The caller decides what a failure means (the button route turns a 429 into an
// HTTP 429; the cron just logs it).
//
// `psu` follows getTransactions' rule exactly (see its comment): null for the
// cron — NO psu headers, i.e. the small unattended bucket, never a faked
// attended request — and the real IP/user-agent for a person's button click.
export interface BalanceResult {
  ok: boolean;
  amount: number | null;
  currency: string | null;
  status?: number; // HTTP status of a failed bank call (429 = rate-limited)
  error?: string;
}

export async function refreshSparebankBalance(account: { id: number; accountUid: string }, psu: Psu): Promise<BalanceResult> {
  try {
    const data = await getBalances(account.accountUid, psu);
    // "CLBD" (closing booked) is the settled balance, not "expected" (XPCD,
    // which includes still-pending holds) — see SbBalance's own comment. Falls
    // back to whatever the bank returned first if it doesn't label a CLBD
    // entry, rather than showing nothing.
    const chosen = data.balances?.find(b => b.balance_type === 'CLBD') ?? data.balances?.[0];
    const amount = chosen ? Number(chosen.balance_amount.amount) : NaN;
    // Nothing usable came back: keep the previous balance + its timestamp
    // rather than blanking it behind a fresh "fetched just now" (the weekly
    // check and the stale marker both trust balanceFetchedAt).
    if (!chosen || !Number.isFinite(amount)) return { ok: false, amount: null, currency: null };
    const currency = chosen.balance_amount.currency ?? null;
    await prisma.sparebankAccount.update({
      where: { id: account.id },
      data: { balanceAmount: amount, balanceCurrency: currency, balanceFetchedAt: new Date() },
    });
    return { ok: true, amount, currency };
  } catch (e) {
    console.error('[sparebankBalances] failed for account', account.id, e);
    if (e instanceof EnableBankingError) return { ok: false, amount: null, currency: null, status: e.status, error: e.message };
    return { ok: false, amount: null, currency: null };
  }
}

// Sequential (the bank throttles per consent; no parallel bursts), each call
// isolated. minAgeMs makes it a no-op for an account whose stored balance is
// already fresh — the cron uses it to spend at most ~1 unattended balance call
// per account per day (see BALANCE_MIN_AGE_MS in api/cron/sparebank-sync).
// Summary rows carry no amounts: the cron response lands in GitHub Actions logs.
export async function refreshSparebankBalances(
  accounts: Array<{ id: number; accountUid: string; balanceFetchedAt?: Date | null }>,
  psu: Psu,
  opts?: { minAgeMs?: number },
): Promise<Array<{ accountId: number; ok: boolean; skipped?: 'fresh'; status?: number }>> {
  const out: Array<{ accountId: number; ok: boolean; skipped?: 'fresh'; status?: number }> = [];
  for (const account of accounts) {
    if (opts?.minAgeMs && account.balanceFetchedAt && Date.now() - account.balanceFetchedAt.getTime() < opts.minAgeMs) {
      out.push({ accountId: account.id, ok: true, skipped: 'fresh' });
      continue;
    }
    const r = await refreshSparebankBalance(account, psu);
    out.push({ accountId: account.id, ok: r.ok, ...(r.status ? { status: r.status } : {}) });
  }
  return out;
}
