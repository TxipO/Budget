import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const MONTHS_SHORT = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];

async function sumByType(start: Date, end: Date) {
  const txs = await prisma.transaction.findMany({
    where: { date: { gte: start, lt: end } },
    include: { category: true, user: { select: { id: true, name: true } } },
  });
  const income   = txs.filter(t => t.category.type === 'income')  .reduce((s, t) => s + t.amount, 0);
  const expenses = txs.filter(t => t.category.type === 'expense') .reduce((s, t) => s + t.amount, 0);
  const savings  = txs.filter(t => t.category.type === 'savings') .reduce((s, t) => s + t.amount, 0);
  return { income, expenses, savings, balance: income - expenses - savings, txs };
}

export async function GET(req: NextRequest) {
  try {
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
    const first = await prisma.transaction.findFirst({ orderBy: { date: 'asc' } });
    rangeStart  = first ? new Date(Date.UTC(first.date.getUTCFullYear(), first.date.getUTCMonth(), 1)) : new Date(Date.UTC(year, 0, 1));
    rangeEnd    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    prevStart   = rangeStart;
    prevEnd     = rangeStart;
    const diffMonths = (rangeEnd.getUTCFullYear() - rangeStart.getUTCFullYear()) * 12
                     + rangeEnd.getUTCMonth() - rangeStart.getUTCMonth();
    trendMonths = Math.max(diffMonths, 1);
  }

  // Current & previous period
  const current = await sumByType(rangeStart, rangeEnd);
  const prev    = period !== 'all' ? await sumByType(prevStart, prevEnd) : null;

  const { income, expenses, savings, balance, txs } = current;

  // Cumulative balance
  const allTxs = await prisma.transaction.findMany({
    where: { date: { lt: rangeEnd } },
    include: { category: true },
  });
  const cumBalance = allTxs.reduce((s, t) => {
    if (t.category.type === 'income')  return s + t.amount;
    if (t.category.type === 'expense') return s - t.amount;
    if (t.category.type === 'savings') return s - t.amount;
    return s;
  }, 0);

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
    if (t.category.type === 'savings') bucket.savings  += t.amount;
  }
  const byUser = [...userAgg.values()]
    .map(u => ({ ...u, net: u.income - u.expenses - u.savings }))
    .sort((a, b) => b.income + b.expenses - (a.income + a.expenses));

  // Attach monthly plans for the period
  if (period === 'month') {
    const plans = await prisma.monthlyPlan.findMany({
      where: { year, month, categoryId: { in: Object.keys(expenseByCategory).map(Number) } },
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
    where: { date: { gte: trendStart, lt: rangeEnd } },
    include: { category: true },
  });
  const trend = [];
  for (let i = trendMonths - 1; i >= 0; i--) {
    const d   = new Date(Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth() - 1 - i, 1));
    const ym  = d.getUTCFullYear() * 100 + d.getUTCMonth();
    const mTxs = trendTxs.filter(t => {
      const td = new Date(t.date);
      return td.getUTCFullYear() * 100 + td.getUTCMonth() === ym;
    });
    const inc = mTxs.filter(t => t.category.type === 'income') .reduce((s, t) => s + t.amount, 0);
    const exp = mTxs.filter(t => t.category.type === 'expense').reduce((s, t) => s + t.amount, 0);
    const sav = mTxs.filter(t => t.category.type === 'savings').reduce((s, t) => s + t.amount, 0);
    trend.push({
      month: MONTHS_SHORT[d.getUTCMonth()] + (period === 'year' || period === 'all' ? ` '${String(d.getUTCFullYear()).slice(2)}` : ''),
      income: inc, expenses: exp, savings: sav, balance: inc - exp - sav,
    });
  }

  // Recent (last 8)
  const recent = await prisma.transaction.findMany({
    where: { date: { gte: rangeStart, lt: rangeEnd } },
    include: { category: true, user: { select: { id: true, name: true } } },
    orderBy: { date: 'desc' },
    take: 8,
  });

  // End-of-month forecast (only for month view)
  let forecast: number | null = null;
  if (period === 'month') {
    const today       = new Date();
    const isCurrentMonth = today.getUTCFullYear() === year && today.getUTCMonth() + 1 === month;
    if (isCurrentMonth && today.getUTCDate() > 1) {
      const dayOfMonth  = today.getUTCDate();
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      // Income and savings usually land as one-off payments (salary, transfers),
      // not a steady daily trickle — extrapolating them by day/month wildly
      // overshoots early in the month. Only expenses accrue gradually, so only
      // they get projected forward; income/savings are taken as already-realized.
      const expenseRate      = expenses / dayOfMonth;
      const projectedExpense = expenseRate * (daysInMonth - dayOfMonth);
      forecast = Math.round(balance - projectedExpense);
    }
  }

  return NextResponse.json({
    income, expenses, savings, balance, cumBalance,
    byCategory, byUser, trend, recent, forecast,
    prev: prev ? { income: prev.income, expenses: prev.expenses, savings: prev.savings, balance: prev.balance } : null,
  });
  } catch (e) {
    console.error('[stats GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
