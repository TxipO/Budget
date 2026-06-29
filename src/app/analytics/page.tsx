'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { formatMoney, MONTH_SHORT } from '@/lib/utils';

const MonthlyBarChart = dynamic(() => import('@/components/charts/MonthlyBarChart'), { ssr: false });

interface MonthData {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  balance: number;
}

export default function AnalyticsPage() {
  const [year, setYear] = useState(2026);
  const [data, setData] = useState<MonthData[]>([]);

  useEffect(() => {
    fetch(`/api/analytics?year=${year}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((months: { income: number; expenses: number; savings: number; balance: number }[]) =>
        Array.isArray(months) && setData(months.map((m, i) => ({ month: MONTH_SHORT[i], ...m })))
      )
      .catch(() => {});
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
          <p style={{ color: '#475569', fontSize: 14 }}>Річна статистика</p>
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

      {/* Year totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 28 }}>
        {[
          { label: 'Всього дохід', value: totalIncome, color: '#22C55E' },
          { label: 'Всього витрати', value: totalExpenses, color: '#EF4444' },
          { label: 'Всього збереження', value: totalSavings, color: '#F59E0B' },
          { label: 'Чистий залишок', value: totalBalance, color: totalBalance >= 0 ? '#FB923C' : '#EF4444' },
        ].map(c => (
          <div key={c.label} className="stat-card">
            <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12, fontWeight: 600 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(c.value)}
            </div>
          </div>
        ))}
      </div>

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
              <div style={{ fontSize: 11, color: '#64748B', marginBottom: 6 }}>{d.month}</div>
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
