'use client';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useCurrency } from '@/lib/useCurrency';
import CountUp, { prefersReducedMotion } from '@/components/CountUp';

interface Item { name: string; amount: number; color: string }

interface Props {
  data: Item[];
  total: number;
}

const CustomTooltip = ({ active, payload }: any) => {
  const { formatMoney } = useCurrency();
  if (!active || !payload?.length) return null;
  const { name, value, payload: p } = payload[0];
  const pct = p.total > 0 ? Math.round((value / p.total) * 100) : 0;
  return (
    <div style={{
      background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)',
      borderRadius: 14, padding: '10px 14px', fontSize: 13,
    }}>
      <p style={{ color: p.color, fontWeight: 700 }}>{name}</p>
      <p style={{ color: 'var(--c-text)', fontWeight: 600 }}>{formatMoney(value)}</p>
      <p style={{ color: 'var(--c-text-muted)' }}>{pct}% від витрат</p>
    </div>
  );
};

// Ring with the period total in the centre and a name / amount / share legend.
// Data colours arrive already mapped to display hues (see lib/displayColor).
export default function ExpenseDonut({ data, total }: Props) {
  const { formatMoney } = useCurrency();
  if (!data.length) return (
    <div className="d-empty">Немає витрат за цей період</div>
  );

  const chartData = data.map(d => ({ ...d, value: d.amount, total }));
  const animate = !prefersReducedMotion();

  return (
    <>
      <div className="d-ring">
        <div style={{ position: 'absolute', inset: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart key={chartData.map(d => `${d.name}:${d.amount}`).join('|')}>
            {/* Clockwise from 12 o'clock; the library's own sweep animation is the load moment. */}
            <Pie
              data={chartData}
              cx="50%" cy="50%"
              innerRadius="69%" outerRadius="91%"
              startAngle={90} endAngle={-270}
              paddingAngle={chartData.length > 1 ? 1.2 : 0}
              dataKey="value"
              stroke="none"
              animationBegin={0}
              isAnimationActive={animate}
              animationDuration={900}
              animationEasing="ease-out"
            >
              {chartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        </div>
        <div className="d-ring-c">
          <span className="d-lb" style={{ fontSize: 13 }}>Витрати</span>
          <b><CountUp value={total} /></b>
        </div>
      </div>

      <div className="d-lg">
        {chartData.map((item, i) => {
          const share = total > 0 ? (item.amount / total) * 100 : 0;
          return (
            <div key={item.name + i}>
              <i style={{ background: item.color }} />
              <span className="nm">{item.name}</span>
              <span className="am">{formatMoney(item.amount)}</span>
              <span className="pc">{share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
