'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, PiggyBank, Wallet } from 'lucide-react';
import { MONTH_SHORT } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import { toast } from '@/lib/toast';

const MonthlyBarChart = dynamic(() => import('@/components/charts/MonthlyBarChart'), { ssr: false });

interface MonthData {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  balance: number;
}

interface Insight { text: string; tone: 'good' | 'warn' | 'info' }
interface SavingsCategoryBalance { name: string; color: string; icon: string; balance: number }

const INSIGHT_STYLE: Record<Insight['tone'], { bg: string; border: string; color: string }> = {
  good: { bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.2)',  color: '#4ADE80' },
  warn: { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.2)',  color: '#FCA5A5' },
  info: { bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.2)', color: '#FB923C' },
};

export default function AnalyticsPage() {
  const { formatMoney, formatMoneySign } = useCurrency();
  const [year, setYear] = useState(2026);
  const [data, setData] = useState<MonthData[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [savingsByCategory, setSavingsByCategory] = useState<SavingsCategoryBalance[]>([]);

  useEffect(() => {
    fetch(`/api/analytics?year=${year}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((res: { months: { income: number; expenses: number; savings: number; balance: number }[]; insights: Insight[]; savingsByCategory: SavingsCategoryBalance[] }) => {
        if (Array.isArray(res.months)) setData(res.months.map((m, i) => ({ month: MONTH_SHORT[i], ...m })));
        setInsights(Array.isArray(res.insights) ? res.insights : []);
        setSavingsByCategory(Array.isArray(res.savingsByCategory) ? res.savingsByCategory : []);
      })
      .catch(() => toast('Помилка завантаження аналітики', 'error'));
  }, [year]);

  const totalIncome   = data.reduce((s, d) => s + d.income, 0);
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0);
  const totalSavings  = data.reduce((s, d) => s + d.savings, 0);
  const totalBalance  = totalIncome - totalExpenses - totalSavings;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Аналітика</h1>
          <p style={{ color: 'var(--c-text-sub)', fontSize: 14 }}>Річна статистика</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[2025, 2026, 2027].map(y => (
            <button key={y} onClick={() => setYear(y)} className="btn-ghost"
              style={{ background: year === y ? 'rgba(249,115,22,0.2)' : undefined, color: year === y ? '#FB923C' : undefined }}>
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Year totals — same stat-card shape as Головна: label + icon tile
          on top, value below. Was text-only here, breaking the pattern. */}
      <div className="grid-4" style={{ marginBottom: 28 }}>
        {[
          { label: 'Всього дохід',      value: totalIncome,   color: '#22C55E', icon: TrendingUp,   bg: 'rgba(34,197,94,0.08)',  signed: false },
          { label: 'Всього витрати',    value: totalExpenses, color: '#EF4444', icon: TrendingDown, bg: 'rgba(239,68,68,0.08)',  signed: false },
          // Savings and balance can both genuinely go negative (a
          // withdrawal-heavy year; spending more than earned) — unlike
          // income/expenses, always non-negative sums by construction.
          // formatMoney() alone drops the sign (Math.abs under the hood),
          // which used to show a real net withdrawal/deficit as a plain
          // positive number. Found live 2026-09-07 on the dashboard's own
          // matching card, which had the same bug.
          { label: 'Всього збереження', value: totalSavings,  color: '#F59E0B', icon: PiggyBank,    bg: 'rgba(245,158,11,0.08)', signed: true },
          { label: 'Чистий залишок',    value: totalBalance,  color: totalBalance >= 0 ? '#FB923C' : '#EF4444', icon: Wallet, bg: 'rgba(249,115,22,0.08)', signed: true },
        ].map(c => (
          <div key={c.label} className="stat-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--c-text-muted)', fontWeight: 600 }}>{c.label}</span>
              <div style={{ background: c.bg, borderRadius: 9, padding: 8 }}>
                <c.icon size={16} color={c.color} />
              </div>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color, fontVariantNumeric: 'tabular-nums' }}>
              {c.signed ? formatMoneySign(c.value) : formatMoney(c.value)}
            </div>
            {/* Small footnote, savings card only — "Всього збереження" above
                is a within-year FLOW (deposits minus withdrawals); this is
                each pool's actual standing balance as of the end of the
                selected year, the answer to "скільки лежить у подушці,
                скільки в Dual Invest" (asked live 2026-09-18, previously
                answerable only via a direct DB query — nowhere in the UI). */}
            {c.label === 'Всього збереження' && savingsByCategory.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
                {savingsByCategory.map(s => `${s.name}: ${formatMoneySign(s.balance)}`).join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 28 }}>
          {insights.map((ins, i) => {
            const s = INSIGHT_STYLE[ins.tone];
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12,
                padding: '10px 16px', fontSize: 13, color: 'var(--c-text-sec)',
              }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                {ins.text}
              </div>
            );
          })}
        </div>
      )}

      {/* Monthly income vs expenses bar chart */}
      <div className="card" style={{ padding: 24, marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 20 }}>
          Дохід vs Витрати по місяцях
        </h3>
        <MonthlyBarChart data={data} />
      </div>

      {/* Balance by month */}
      <div className="card" style={{ padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Вільний залишок по місяцях</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data.map(d => (
            <div key={d.month} style={{
              flex: '1 1 60px', minWidth: 60,
              background: d.balance >= 0 ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${d.balance >= 0 ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
              borderRadius: 10, padding: '12px 8px', textAlign: 'center',
            }}>
              <div style={{ fontSize: 11, color: 'var(--c-text-muted)', marginBottom: 6 }}>{d.month}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: d.balance >= 0 ? '#4ADE80' : '#FCA5A5', fontVariantNumeric: 'tabular-nums' }}>
                {d.balance !== 0 ? `${d.balance >= 0 ? '+' : ''}${Math.round(d.balance / 1000)}к` : '—'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
