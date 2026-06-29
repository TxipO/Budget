import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const MONTHS_SHORT = ['Січ','Лют','Бер','Кві','Тра','Чер','Лип','Сер','Вер','Жов','Лис','Гру'];

async function sumByType(start: Date, end: Date) {
  const txs = await prisma.transaction.findMany({
    where: { date: { gte: start, lt: end } },
    include: { category: true },
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
  const year   = parseInt(searchParams.get('year')  || String(now.getFullYear()));
  const month  = parseInt(searchParams.get('month') || String(now.getMonth() + 1));

  let rangeStart: Date;
  let rangeEnd: Date;
  let prevStart: Date;
  let prevEnd: Date;
  let trendMonths: number;

  if (period === 'month') {
    rangeStart = new Date(year, month - 1, 1);
    rangeEnd   = new Date(year, month, 1);
    prevStart  = new Date(year, month - 2, 1);
    prevEnd    = new Date(year, month - 1, 1);
    trendMonths = 6;
  } else if (period === 'quarter') {
    rangeEnd   = new Date(year, month, 1);
    rangeStart = new Date(year, month - 3, 1);
    prevEnd    = rangeStart;
    prevStart  = new Date(year, month - 6, 1);
    trendMonths = 3;
  } else if (period === '6m') {
    rangeEnd   = new Date(year, month, 1);
    rangeStart = new Date(year, month - 6, 1);
    prevEnd    = rangeStart;
    prevStart  = new Date(year, month - 12, 1);
    trendMonths = 6;
  } else if (period === 'year') {
    rangeStart = new Date(year, 0, 1);
    rangeEnd   = new Date(year + 1, 0, 1);
    prevStart  = new Date(year - 1, 0, 1);
    prevEnd    = new Date(year, 0, 1);
    trendMonths = 12;
  } else { // all
    const first = await prisma.transaction.findFirst({ orderBy: { date: 'asc' } });
    rangeStart  = first ? new Date(first.date.getFullYear(), first.date.getMonth(), 1) : new Date(year, 0, 1);
    rangeEnd    = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    prevStart   = rangeStart;
    prevEnd     = rangeStart;
    const diffMonths = (rangeEnd.getFullYear() - rangeStart.getFullYear()) * 12
                     + rangeEnd.getMonth() - rangeStart.getMonth();
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
  const expenseByCategory: Record<number, { name: string; amount: number; color: string; planned: number }> = {};
  txs.filter(t => t.category.type === 'expense').forEach(t => {
    if (!expenseByCategory[t.categoryId]) {
      expenseByCategory[t.categoryId] = { name: t.category.name, amount: 0, color: t.category.color, planned: 0 };
    }
    expenseByCategory[t.categoryId].amount += t.amount;
  });

  // Attach monthly plans for the period
  if (period === 'month') {
    const plans = await prisma.monthlyPlan.findMany({
      where: { year, month, categoryId: { in: Object.keys(expenseByCategory).map(Number) } },
    });
    for (const p of plans) {
      if (expenseByCategory[p.categoryId]) {
        expenseByCategory[p.categoryId].planned = p.amount;
      }
    }
  }

  const byCategory = Object.values(expenseByCategory).sort((a, b) => b.amount - a.amount);

  // Trend
  const trend = [];
  for (let i = trendMonths - 1; i >= 0; i--) {
    const d     = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth() - 1 - i, 1);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const m     = await sumByType(start, end);
    trend.push({
      month: MONTHS_SHORT[d.getMonth()] + (period === 'year' || period === 'all' ? ` '${String(d.getFullYear()).slice(2)}` : ''),
      income: m.income, expenses: m.expenses, savings: m.savings,
      balance: m.balance,
    });
  }

  // Recent (last 8)
  const recent = await prisma.transaction.findMany({
    where: { date: { gte: rangeStart, lt: rangeEnd } },
    include: { category: true, user: true },
    orderBy: { date: 'desc' },
    take: 8,
  });

  // End-of-month forecast (only for month view)
  let forecast: number | null = null;
  if (period === 'month') {
    const today       = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() + 1 === month;
    if (isCurrentMonth && today.getDate() > 1) {
      const dayOfMonth  = today.getDate();
      const daysInMonth = new Date(year, month, 0).getDate();
      const dailyRate   = balance / dayOfMonth;
      forecast = Math.round(balance + dailyRate * (daysInMonth - dayOfMonth));
    }
  }

  return NextResponse.json({
    income, expenses, savings, balance, cumBalance,
    byCategory, trend, recent, forecast,
    prev: prev ? { income: prev.income, expenses: prev.expenses, savings: prev.savings, balance: prev.balance } : null,
  });
  } catch (e) {
    console.error('[stats GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
