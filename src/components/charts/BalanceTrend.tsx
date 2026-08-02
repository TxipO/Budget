'use client';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { useCurrency } from '@/lib/useCurrency';

interface TrendPoint {
  month: string;
  income: number;
  expenses: number;
  savings: number;
  balance: number;
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

export default function BalanceTrend({ data }: { data: TrendPoint[] }) {
  if (!data.length) return (
    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 14 }}>
      Немає даних
    </div>
  );

  return (
    <div style={{ height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="gIncome" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#22C55E" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22C55E" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gExpense" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--c-border)" />
          <XAxis
            dataKey="month"
            tick={{ fill: '#475569', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: '#475569', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => `${(v / 1000).toFixed(0)}к`}
          />
          <Tooltip content={<CustomTooltip />} />
          {/* Витрати gets a dashed stroke, not just a different hue — the two
              lines cross and run parallel often enough that red/green alone
              (the most common color-blindness pair) isn't a reliable way to
              tell them apart at a glance. */}
          <Area type="monotone" dataKey="income"   name="Дохід"   stroke="#22C55E" fill="url(#gIncome)"  strokeWidth={2} />
          <Area type="monotone" dataKey="expenses" name="Витрати" stroke="#EF4444" fill="url(#gExpense)" strokeWidth={2} strokeDasharray="5 3" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
