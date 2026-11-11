'use client';
import { useState } from 'react';
import { PieChart, Pie, Cell, Sector, ResponsiveContainer } from 'recharts';
import { useCurrency } from '@/lib/useCurrency';
import CountUp, { prefersReducedMotion } from '@/components/CountUp';

interface Item { name: string; amount: number; color: string }

interface Props {
  data: Item[];
  total: number;
}

const pctText = (share: number) => (share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`);

// The hovered slice grows a little; the rest dims via CSS (.d-ring.has-active) —
// not via Cell props, which would make Recharts treat the data as changed and replay the sweep.
const activeShape = (p: any) => <Sector {...p} className="on" outerRadius={p.outerRadius + 4} />;

// Ring with the period total in the centre and a name / amount / share legend.
// Hovering or focusing a slice or a legend row highlights that category and
// swaps the centre to it (no floating tooltip: it used to cover the centre).
// Data colours arrive already mapped to display hues (see lib/displayColor).
export default function ExpenseDonut({ data, total }: Props) {
  const { formatMoney } = useCurrency();
  const [active, setActive] = useState<number | null>(null);
  if (!data.length) return (
    <div className="d-empty">Немає витрат за цей період</div>
  );

  const chartData = data.map(d => ({ ...d, value: d.amount }));
  const animate = !prefersReducedMotion();
  const cur = active !== null ? chartData[active] : null;
  const share = (amount: number) => (total > 0 ? (amount / total) * 100 : 0);

  return (
    <div className="d-donut-body">
      <div className={`d-ring${cur ? ' has-active' : ''}`}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart key={chartData.map(d => `${d.name}:${d.amount}`).join('|')}>
              {/* Clockwise from 12 o'clock; the library's own sweep animation is the load moment. */}
              <Pie
                data={chartData}
                cx="50%" cy="50%"
                innerRadius="69%" outerRadius="87%"
                startAngle={90} endAngle={-270}
                paddingAngle={chartData.length > 1 ? 1.2 : 0}
                dataKey="value"
                stroke="none"
                animationBegin={0}
                isAnimationActive={animate}
                animationDuration={900}
                animationEasing="ease-out"
                activeIndex={active ?? undefined}
                activeShape={activeShape}
                onMouseEnter={(_: unknown, i: number) => setActive(i)}
                onMouseLeave={() => setActive(null)}
              >
                {chartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </div>
        {/* Both layers stay mounted so the total's count-up is not replayed on every hover. */}
        <div className="d-ring-c" style={{ opacity: cur ? 0 : 1 }} aria-hidden={!!cur}>
          <span className="d-lb" style={{ fontSize: 13 }}>Витрати</span>
          <b><CountUp value={total} /></b>
        </div>
        <div className="d-ring-c d-ring-cat" style={{ opacity: cur ? 1 : 0 }} aria-live="polite">
          {cur && (
            <>
              <span className="d-lb d-ring-name" style={{ color: `color-mix(in oklab, ${cur.color} 70%, var(--c-text))` }}>{cur.name}</span>
              <b>{formatMoney(cur.amount)}</b>
              <span className="d-lb" style={{ fontSize: 13 }}>{pctText(share(cur.amount))} від витрат</span>
            </>
          )}
        </div>
      </div>

      <div className={`d-lg${cur ? ' has-active' : ''}`}>
        {chartData.map((item, i) => (
          <div
            key={item.name + i}
            tabIndex={0}
            className={active === i ? 'on' : undefined}
            aria-label={`${item.name}: ${formatMoney(item.amount)}, ${pctText(share(item.amount))}`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <i style={{ background: item.color }} />
            <span className="nm">{item.name}</span>
            <span className="am">{formatMoney(item.amount)}</span>
            <span className="pc">{pctText(share(item.amount))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
