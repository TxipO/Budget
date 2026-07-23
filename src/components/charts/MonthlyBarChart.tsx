'use client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { useCurrency } from '@/lib/useCurrency';

interface MonthData {
  month: string;
  income: number;
  expenses: number;
  savings: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  const { formatMoney } = useCurrency();
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)',
      borderRadius: 10, padding: '10px 14px', fontSize: 13, minWidth: 160,
    }}>
      <p style={{ color: '#94A3B8', marginBottom: 8, fontWeight: 600 }}>{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span style={{ color: 'var(--c-text)', fontWeight: 500 }}>{formatMoney(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function MonthlyBarChart({ data }: { data: MonthData[] }) {
  if (!data.length) return (
    <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 14 }}>
      Немає даних
    </div>
  );

  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }} barGap={4}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
          <XAxis dataKey="month" tick={{ fill: '#475569', fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#475569', fontSize: 11 }} axisLine={false} tickLine={false}
            tickFormatter={v => `${(v / 1000).toFixed(0)}к`} />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="income"   name="Дохід"       fill="#22C55E" radius={[4, 4, 0, 0]} />
          <Bar dataKey="expenses" name="Витрати"     fill="#EF4444" radius={[4, 4, 0, 0]} />
          <Bar dataKey="savings"  name="Збереження"  fill="#F59E0B" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
