'use client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { formatMoney } from '@/lib/utils';

interface Item { name: string; amount: number; color: string; planned?: number }

interface Props {
  data: Item[];
  total: number;
}

const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const { name, value, payload: p } = payload[0];
  const pct = p.total > 0 ? Math.round((value / p.total) * 100) : 0;
  return (
    <div style={{
      background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)',
      borderRadius: 10, padding: '10px 14px', fontSize: 13,
    }}>
      <p style={{ color: p.color, fontWeight: 600 }}>{name}</p>
      <p style={{ color: 'var(--c-text)' }}>{formatMoney(value)}</p>
      <p style={{ color: '#64748B' }}>{pct}% від витрат</p>
    </div>
  );
};

export default function ExpenseDonut({ data, total }: Props) {
  if (!data.length) return (
    <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 14 }}>
      Немає витрат за цей місяць
    </div>
  );

  const chartData = data.map(d => ({ ...d, value: d.amount, total }));

  return (
    <div className="donut-row" style={{ display: 'flex', gap: 20, alignItems: 'center', minHeight: 240 }}>
      {/* Pie */}
      <div className="donut-chart-box" style={{ width: 180, height: 180, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={82}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry, i) => (
                <Cell key={i} fill={entry.color} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      {/* Custom legend */}
      <div className="donut-legend" style={{
        flex: 1, minWidth: 0, overflowY: 'auto', maxHeight: 240,
        display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        {chartData.map(item => {
          const pct = total > 0 ? Math.round((item.amount / total) * 100) : 0;
          return (
            <div key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                background: item.color,
              }} />
              <span style={{
                flex: 1, fontSize: 12, color: 'var(--c-text-sec)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {item.name}
              </span>
              <span style={{
                fontSize: 12, color: '#64748B',
                fontVariantNumeric: 'tabular-nums', flexShrink: 0,
              }}>
                {formatMoney(item.amount)}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 700, flexShrink: 0,
                padding: '1px 6px', borderRadius: 4,
                background: 'rgba(255,255,255,0.06)', color: '#94A3B8',
                minWidth: 34, textAlign: 'center',
              }}>
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
