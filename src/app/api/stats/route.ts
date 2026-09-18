import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';
import { savingsAmount, isBudgetRelevant } from '@/lib/validate';

const MONTHS_SHORT = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];

async function sumByType(householdId: number, start: Date, end: Date) {
  const txs = await prisma.transaction.findMany({
    where: { householdId, date: { gte: start, lt: end } },
    include: { category: true, user: { select: { id: true, name: true } } },
  });
  // Every downstream consumer of the returned `txs` (expense-by-category,
  // per-user breakdown) only ever needs budget-relevant rows — an internal
  // transfer between two of the same person's own accounts (see
  // isBudgetRelevant's own comment) has no business in any of them, so it's
  // filtered out once here rather than at every call site.
  const budgetTxs = txs.filter(isBudgetRelevant);
  const income   = budgetTxs.filter(t => t.category.type === 'income')  .reduce((s, t) => s + t.amount, 0);
  const expenses = budgetTxs.filter(t => t.category.type === 'expense') .reduce((s, t) => s + t.amount, 0);
  const savings  = budgetTxs.filter(t => t.category.type === 'savings') .reduce((s, t) => s + savingsAmount(t), 0);
  // Deliberately from the FULL `txs`, not `budgetTxs` — isBudgetRelevant
  // excludes every 'transfer'-type row by design (see its own comment), so
  // this is the one sum that has to read type 'transfer' rows directly.
  // Transfers land in pairs (one outgoing leg, one incoming), so summing
  // both would double the real moved amount — only the outgoing
  // (savingsWithdrawal: false) leg of each pair is counted, same
  // "count each real movement once" reasoning as savingsAmount().
  const transfers = txs.filter(t => t.category.type === 'transfer' && !t.savingsWithdrawal).reduce((s, t) => s + t.amount, 0);
  return { income, expenses, savings, transfers, balance: income - expenses - savings, txs: budgetTxs };
}

export async function GET(req: NextRequest) {
  try {
  const householdId = requireHouseholdId(req);
  if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { searchParams } = req.nextUrl;
  const now    = new Date();
  const period = searchParams.get('period') || 'month';
  const yearP  = parseInt(searchParams.get('year')  || String(now.getFullYear()));
  const monthP = parseInt(searchParams.get('month') || String(now.getMonth() + 1));
  const year   = Number.isFinite(yearP) ? yearP : now.getFullYear();
  const month  = Number.isFinite(monthP) && monthP >= 1 && monthP <= 12 ? monthP : now.getMonth() + 1;

  let rangeStart: Date;
  let rangeEnd: Date;
  let prevStart: Date;
  let prevEnd: Date;
  let trendMonths: number;

  // All range boundaries use Date.UTC so month buckets are identical no
  // matter what timezone the Node process itself is running in (local dev
  // vs Vercel's UTC) — otherwise the same transaction can land in a
  // different month depending on where the server happens to run.
  if (period === 'month') {
    rangeStart = new Date(Date.UTC(year, month - 1, 1));
    rangeEnd   = new Date(Date.UTC(year, month, 1));
    prevStart  = new Date(Date.UTC(year, month - 2, 1));
    prevEnd    = new Date(Date.UTC(year, month - 1, 1));
    trendMonths = 6;

    // Viewing the still-in-progress current month against a FULL previous
    // month always reads as a huge swing early on (2 days of data vs 30) —
    // not a real signal, and exactly the wrong kind of alarming on a
    // dashboard meant to reassure. Clip the previous month's comparison
    // window to the same day-of-month so the delta is apples-to-apples.
    // Past, fully-elapsed months are unaffected.
    if (year === now.getUTCFullYear() && month === now.getUTCMonth() + 1) {
      const daysInPrevMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
      const cutoffDay = Math.min(now.getUTCDate(), daysInPrevMonth);
      prevEnd = new Date(Date.UTC(year, month - 2, cutoffDay + 1));
    }
  } else if (period === 'quarter') {
    rangeEnd   = new Date(Date.UTC(year, month, 1));
    rangeStart = new Date(Date.UTC(year, month - 3, 1));
    prevEnd    = rangeStart;
    prevStart  = new Date(Date.UTC(year, month - 6, 1));
    trendMonths = 3;
  } else if (period === '6m') {
    rangeEnd   = new Date(Date.UTC(year, month, 1));
    rangeStart = new Date(Date.UTC(year, month - 6, 1));
    prevEnd    = rangeStart;
    prevStart  = new Date(Date.UTC(year, month - 12, 1));
    trendMonths = 6;
  } else if (period === 'year') {
    rangeStart = new Date(Date.UTC(year, 0, 1));
    rangeEnd   = new Date(Date.UTC(year + 1, 0, 1));
    prevStart  = new Date(Date.UTC(year - 1, 0, 1));
    prevEnd    = new Date(Date.UTC(year, 0, 1));
    trendMonths = 12;
  } else { // all
    const first = await prisma.transaction.findFirst({ where: { householdId }, orderBy: { date: 'asc' } });
    rangeStart  = first ? new Date(Date.UTC(first.date.getUTCFullYear(), first.date.getUTCMonth(), 1)) : new Date(Date.UTC(year, 0, 1));
    rangeEnd    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    prevStart   = rangeStart;
    prevEnd     = rangeStart;
    const diffMonths = (rangeEnd.getUTCFullYear() - rangeStart.getUTCFullYear()) * 12
                     + rangeEnd.getUTCMonth() - rangeStart.getUTCMonth();
    trendMonths = Math.max(diffMonths, 1);
  }

  // Current & previous period
  const current = await sumByType(householdId, rangeStart, rangeEnd);
  const prev    = period !== 'all' ? await sumByType(householdId, prevStart, prevEnd) : null;

  const { income, expenses, savings, transfers, balance, txs } = current;

  // Cumulative balance
  const allTxs = await prisma.transaction.findMany({
    where: { householdId, date: { lt: rangeEnd } },
    include: { category: true },
  });
  const cumBalance = allTxs.filter(isBudgetRelevant).reduce((s, t) => {
    if (t.category.type === 'income')  return s + t.amount;
    if (t.category.type === 'expense') return s - t.amount;
    if (t.category.type === 'savings') return s - savingsAmount(t);
    return s;
  }, 0);

  // Running balance PER savings category (as of the same rangeEnd cutoff as
  // cumBalance above, from the same already-fetched allTxs) — "скільки
  // лежить у кожному пулі" is a running-total question, not a this-period-
  // flow one, so this deliberately doesn't reset per period the way
  // `savings`/`sumByType` above does. Found live 2026-09-18: the only
  // savings number the dashboard ever showed was one combined total across
  // every pool — "Фінансова подушка" vs "Dual Invest" vs "Акції" was
  // nowhere in the UI, DB-only. Same sign convention as savingsAmount()
  // itself (a deposit grows the pool, a withdrawal shrinks it) — POSITIVE
  // here, unlike cumBalance's own use of savingsAmount() which SUBTRACTS it
  // (money going into savings reduces free cash; this is the pool's own
  // balance, the opposite side of that same movement).
  const savingsByCategory: Record<number, { name: string; color: string; icon: string; balance: number }> = {};
  allTxs.filter(isBudgetRelevant).filter(t => t.category.type === 'savings').forEach(t => {
    if (!savingsByCategory[t.categoryId]) {
      savingsByCategory[t.categoryId] = { name: t.category.name, color: t.category.color, icon: t.category.icon, balance: 0 };
    }
    savingsByCategory[t.categoryId].balance += savingsAmount(t);
  });

  // Category breakdown (expenses) + plan
  const expenseByCategory: Record<number, { name: string; amount: number; color: string; icon: string; planned: number }> = {};
  txs.filter(t => t.category.type === 'expense').forEach(t => {
    if (!expenseByCategory[t.categoryId]) {
      expenseByCategory[t.categoryId] = { name: t.category.name, amount: 0, color: t.category.color, icon: t.category.icon, planned: 0 };
    }
    expenseByCategory[t.categoryId].amount += t.amount;
  });

  // Per-user breakdown for the period (хто скільки)
  const userAgg = new Map<string, { name: string; income: number; expenses: number; savings: number }>();
  for (const t of txs) {
    const key = t.user?.name ?? '__shared__';
    const label = t.user?.name ?? 'Спільні';
    if (!userAgg.has(key)) userAgg.set(key, { name: label, income: 0, expenses: 0, savings: 0 });
    const bucket = userAgg.get(key)!;
    if (t.category.type === 'income')  bucket.income   += t.amount;
    if (t.category.type === 'expense') bucket.expenses += t.amount;
    if (t.category.type === 'savings') bucket.savings  += savingsAmount(t);
  }
  const byUser = [...userAgg.values()]
    .map(u => ({ ...u, net: u.income - u.expenses - u.savings }))
    .sort((a, b) => b.income + b.expenses - (a.income + a.expenses));

  // Attach monthly plans for the period
  if (period === 'month') {
    const plans = await prisma.monthlyPlan.findMany({
      where: { year, month, householdId, categoryId: { in: Object.keys(expenseByCategory).map(Number) } },
    });
    for (const p of plans) {
      if (expenseByCategory[p.categoryId]) {
        expenseByCategory[p.categoryId].planned = p.plannedAmount;
      }
    }
  }

  const byCategory = Object.values(expenseByCategory).sort((a, b) => b.amount - a.amount);

  // Trend — single query, then bucket by month in memory
  const trendStart = new Date(Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - trendMonths, 1));
  const trendTxs = await prisma.transaction.findMany({
    where: { householdId, date: { gte: trendStart, lt: rangeEnd } },
    include: { category: true },
  });
  const trend = [];
  for (let i = trendMonths - 1; i >= 0; i--) {
    const d   = new Date(Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - 1 - i, 1));
    const ym  = d.getUTCFullYear() * 100 + d.getUTCMonth();
    const mTxs = trendTxs.filter(t => {
      const td = new Date(t.date);
      return td.getUTCFullYear() * 100 + td.getUTCMonth() === ym;
    }).filter(isBudgetRelevant);
    const inc = mTxs.filter(t => t.category.type === 'income') .reduce((s, t) => s + t.amount, 0);
    const exp = mTxs.filter(t => t.category.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const sav = mTxs.filter(t => t.category.type === 'savings').reduce((s, t) => s + savingsAmount(t), 0);
    trend.push({
      month: MONTHS_SHORT[d.getUTCMonth()] + (period === 'year' || period === 'all' ? ` '${String(d.getUTCFullYear()).slice(2)}` : ''),
      income: inc, expenses: exp, savings: sav, balance: inc - exp - sav,
    });
  }

  // Recent (last 8) — date alone ties for every transaction on the same
  // calendar day (it's truncated to UTC midnight/noon, see monoIngest.ts),
  // so without a tiebreaker Postgres returns same-date rows in whatever
  // order it happens to find them, not the order they were actually added.
  // createdAt breaks the tie with the real insertion order.
  const recent = await prisma.transaction.findMany({
    // isTransfer excluded — a redundant transfer-mirror leg (see
    // Transaction.isTransfer's schema comment) isn't budget activity, and
    // showing it here reads as an unexplained duplicate of its counted
    // counterpart. Filtered at the query itself, not just hidden in the UI,
    // so it can't also silently push a real transaction out of the top 8.
    // category.type 'transfer' excluded too, independent of isTransfer — see
    // isBudgetRelevant's own comment on why both checks matter.
    where: { householdId, date: { gte: rangeStart, lt: rangeEnd }, isTransfer: false, category: { type: { not: 'transfer' } } },
    include: { category: true, user: { select: { id: true, name: true } } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 8,
  });

  // Per-user last-transaction date — deliberately ALL-TIME, not scoped to
  // rangeStart/rangeEnd like everything else above. `recent` can't answer
  // this: it's both period-filtered and capped at 8 total (not per-user), so
  // a less-active person's genuinely most recent entry can silently fall
  // outside the window or get pushed out of the top-8 by the other person's
  // activity. "When did each person last log anything" is an absolute fact,
  // not relative to whatever period the dashboard happens to be showing.
  const householdUsers = await prisma.user.findMany({ where: { householdId }, select: { id: true, name: true } });
  const lastDatesByUser = await prisma.transaction.groupBy({
    by: ['userId'],
    where: { householdId, userId: { not: null } },
    _max: { date: true },
  });
  const lastByUser = householdUsers.map(u => ({
    userId: u.id,
    name: u.name,
    date: lastDatesByUser.find(d => d.userId === u.id)?._max.date ?? null,
  }));

  return NextResponse.json({
    income, expenses, savings, transfers, balance, cumBalance,
    byCategory, byUser, trend, recent, lastByUser,
    savingsByCategory: Object.values(savingsByCategory).sort((a, b) => b.balance - a.balance),
    prev: prev ? { income: prev.income, expenses: prev.expenses, savings: prev.savings, transfers: prev.transfers, balance: prev.balance } : null,
  });
  } catch (e) {
    console.error('[stats GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
