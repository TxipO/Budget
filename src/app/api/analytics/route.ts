import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  try {
    const year = parseInt(req.nextUrl.searchParams.get('year') || String(new Date().getFullYear()));

    const txs = await prisma.transaction.findMany({
      where: {
        date: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) },
      },
      select: { date: true, amount: true, category: { select: { type: true } } },
    });

    const months = Array.from({ length: 12 }, () => ({
      income: 0, expenses: 0, savings: 0, balance: 0,
    }));

    for (const tx of txs) {
      const m = tx.date.getMonth();
      const { type } = tx.category;
      if (type === 'income')  { months[m].income   += tx.amount; }
      if (type === 'expense') { months[m].expenses += tx.amount; }
      if (type === 'savings') { months[m].savings  += tx.amount; }
    }

    for (const m of months) {
      m.balance = m.income - m.expenses - m.savings;
    }

    return NextResponse.json(months);
  } catch (e) {
    console.error('[analytics GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
