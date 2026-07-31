import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { badRequest, isPositiveInt } from '@/lib/validate';
import { getBalances, EnableBankingError } from '@/lib/enableBanking';
import { requireHouseholdId } from '@/lib/household';

// User-triggered (a button click in Settings), so a real PSU is genuinely
// present — same attended-access reasoning as the manual sync route's.
// Fetches EVERY account under the user's consent, not just syncEnabled
// ones — the whole point is letting the user SEE a not-yet-enabled
// account's balance (e.g. a savings "pillow") before deciding whether to
// also pull its transactions.
export async function POST(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { userId } = body;
    if (!isPositiveInt(Number(userId))) return badRequest('Невалідний користувач');

    const user = await prisma.user.findUnique({
      where: { id: Number(userId) },
      select: { householdId: true, sbSessionEnc: true, sparebankAccounts: { select: { id: true, accountUid: true } } },
    });
    if (!user || user.householdId !== householdId) return badRequest('Користувача не знайдено');
    if (!user.sbSessionEnc || user.sparebankAccounts.length === 0) return badRequest('Не підключено');

    const psuIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
    const psuUserAgent = req.headers.get('user-agent') || undefined;
    const psu = { ipAddress: psuIp, userAgent: psuUserAgent };

    const results: Array<{ accountId: number; amount: number | null; currency: string | null }> = [];
    for (const account of user.sparebankAccounts) {
      try {
        const data = await getBalances(account.accountUid, psu);
        // "CLBD" (closing booked) is the settled balance, not "expected"
        // (XPCD, which includes still-pending holds) — see SbBalance's own
        // comment. Falls back to whatever the bank returned first if it
        // doesn't label a CLBD entry, rather than showing nothing.
        const chosen = data.balances?.find(b => b.balance_type === 'CLBD') ?? data.balances?.[0];
        const amount = chosen ? Number(chosen.balance_amount.amount) : null;
        const currency = chosen?.balance_amount.currency ?? null;
        await prisma.sparebankAccount.update({
          where: { id: account.id },
          data: { balanceAmount: Number.isFinite(amount) ? amount : null, balanceCurrency: currency, balanceFetchedAt: new Date() },
        });
        results.push({ accountId: account.id, amount: Number.isFinite(amount) ? amount : null, currency });
      } catch (e) {
        console.error('[sparebank/refresh-balances] failed for account', account.id, e);
        if (e instanceof EnableBankingError && e.status === 429) {
          return NextResponse.json({ error: e.message }, { status: 429 });
        }
        results.push({ accountId: account.id, amount: null, currency: null });
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e) {
    console.error('[sparebank/refresh-balances POST]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
