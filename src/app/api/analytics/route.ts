import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireHouseholdId } from '@/lib/household';
import { savingsAmount } from '@/lib/validate';

const MONTHS_UA = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];
const MONTHS_UA_LOC = ['січні','лютому','березні','квітні','травні','червні','липні','серпні','вересні','жовтні','листопаді','грудні'];
const MONTHS_UA_GEN = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];

interface Insight { text: string; tone: 'good' | 'warn' | 'info' }

export async function GET(req: NextRequest) {
  try {
    const householdId = requireHouseholdId(req);
    if (!householdId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const yearParam = parseInt(req.nextUrl.searchParams.get('year') || String(new Date().getFullYear()));
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();

    const txs = await prisma.transaction.findMany({
      where: {
        householdId,
        date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
      },
      select: { date: true, amount: true, details: true, savingsWithdrawal: true, category: { select: { name: true, type: true } } },
    });

    const months = Array.from({ length: 12 }, () => ({
      income: 0, expenses: 0, savings: 0, balance: 0,
    }));

    // per-month per-category expense sums for MoM insight
    const catByMonth: Record<number, Record<string, number>> = {};

    let biggestExpense: { amount: number; details: string; name: string; date: Date } | null = null;

    for (const tx of txs) {
      const m = tx.date.getUTCMonth();
      const { type, name } = tx.category;
      if (type === 'income')  { months[m].income   += tx.amount; }
      if (type === 'expense') {
        months[m].expenses += tx.amount;
        catByMonth[m] = catByMonth[m] || {};
        catByMonth[m][name] = (catByMonth[m][name] || 0) + tx.amount;
        // '[імпорт]' rows are aggregated monthly sums, not single expenses
        if (tx.details !== '[імпорт]' && (!biggestExpense || tx.amount > biggestExpense.amount)) {
          biggestExpense = { amount: tx.amount, details: tx.details, name, date: tx.date };
        }
      }
      if (type === 'savings') { months[m].savings  += savingsAmount(tx); }
    }

    for (const m of months) {
      m.balance = m.income - m.expenses - m.savings;
    }

    // --- Insights ---
    const insights: Insight[] = [];
    const fmt = (n: number) => new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(Math.round(n)) + ' kr';
    const active = months.map((m, i) => ({ ...m, i })).filter(m => m.income > 0 || m.expenses > 0 || m.savings > 0);

    if (active.length > 0) {
      // Most expensive month
      const maxExp = active.reduce((a, b) => (b.expenses > a.expenses ? b : a));
      if (maxExp.expenses > 0) {
        insights.push({ text: `Найдорожчий місяць — ${MONTHS_UA[maxExp.i]}: ${fmt(maxExp.expenses)} витрат`, tone: 'info' });
      }

      // Top category of latest month WITH expenses + MoM change
      const expActive = active.filter(m => m.expenses > 0);
      const last = expActive[expActive.length - 1];
      const lastCats = last ? catByMonth[last.i] || {} : {};
      const top = Object.entries(lastCats).sort((a, b) => b[1] - a[1])[0];
      if (top) {
        const [topName, topSum] = top;
        let momText = '';
        let tone: Insight['tone'] = 'info';
        const prev = expActive.length > 1 ? expActive[expActive.length - 2] : null;
        const prevSum = prev ? (catByMonth[prev.i] || {})[topName] || 0 : 0;
        if (prev && prevSum > 0) {
          const pct = Math.round(((topSum - prevSum) / prevSum) * 100);
          if (Math.abs(pct) >= 1) {
            momText = ` (${pct > 0 ? '+' : ''}${pct}% до ${MONTHS_UA_GEN[prev.i]})`;
            tone = pct > 0 ? 'warn' : 'good';
          }
        }
        insights.push({ text: `Топ-категорія у ${MONTHS_UA_LOC[last.i]} — ${topName}: ${fmt(topSum)}${momText}`, tone });
      }

      // Biggest single expense
      if (biggestExpense) {
        const d = biggestExpense.date;
        const dateStr = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const label = biggestExpense.details ? `${biggestExpense.details} (${biggestExpense.name})` : biggestExpense.name;
        insights.push({ text: `Найбільша разова витрата — ${label}: ${fmt(biggestExpense.amount)}, ${dateStr}`, tone: 'info' });
      }

      // Average monthly expenses
      const expMonths = active.filter(m => m.expenses > 0);
      if (expMonths.length > 1) {
        const avg = expMonths.reduce((s, m) => s + m.expenses, 0) / expMonths.length;
        insights.push({ text: `Середні витрати: ${fmt(avg)} на місяць`, tone: 'info' });
      }

      // Savings rate
      const totalIncome  = active.reduce((s, m) => s + m.income, 0);
      const totalSavings = active.reduce((s, m) => s + m.savings, 0);
      if (totalIncome > 0 && totalSavings > 0) {
        const rate = Math.round((totalSavings / totalIncome) * 100);
        insights.push({ text: `Відкладено ${rate}% доходу за рік (${fmt(totalSavings)})`, tone: rate >= 10 ? 'good' : 'info' });
      }
    }

    return NextResponse.json({ months, insights });
  } catch (e) {
    console.error('[analytics GET]', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
