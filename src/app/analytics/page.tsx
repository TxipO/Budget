'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, PiggyBank, Wallet } from 'lucide-react';
import { MONTH_SHORT } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import { formatCompact, roundCompact, formatMoney as formatMoneyIn } from '@/lib/currencies';
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
interface SavingsCategoryBalance { name: string; color: string; icon: string; balance: number; bank: { amount: number; currency: string; fetchedAt: string } | null }

const INSIGHT_STYLE: Record<Insight['tone'], { bg: string; border: string; color: string }> = {
  good: { bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.2)',  color: 'var(--c-pos-text)' },
  warn: { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.2)',  color: 'var(--c-neg-text)' },
  info: { bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.2)', color: 'var(--c-accent-hi)' },
};

// Big stat numbers: same hues, darker on the light theme (see globals.css).
const NUM_VAR: Record<string, string> = {
  '#22C55E': 'var(--c-income-num)', '#EF4444': 'var(--c-expense-num)', '#F59E0B': 'var(--c-savings-num)',
};

const BAR_SERIES = [['Дохід', '#22C55E'], ['Витрати', '#EF4444'], ['Збереження', '#F59E0B']];

// "DD.MM" of the UTC calendar day (balanceFetchedAt is a UTC instant).
const formatDdMm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export default function AnalyticsPage() {
  const { currency, formatMoney, formatMoneySign } = useCurrency();
  // UTC, like the server's year boundaries and the planning page.
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<MonthData[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [savingsByCategory, setSavingsByCategory] = useState<SavingsCategoryBalance[]>([]);
  // True until the first response for the selected year lands (or fails): without it the
  // empty initial state reads as a real year of zeroes and "Немає даних".
  const [loading, setLoading] = useState(true);

  const loadSeq = useRef(0); // a slower response for a previously picked year must not overwrite the current one
  useEffect(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    fetch(`/api/analytics?year=${year}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((res: { months: { income: number; expenses: number; savings: number; balance: number }[]; insights: Insight[]; savingsByCategory: SavingsCategoryBalance[] }) => {
        if (seq !== loadSeq.current) return;
        if (Array.isArray(res.months)) setData(res.months.map((m, i) => ({ month: MONTH_SHORT[i], ...m })));
        setInsights(Array.isArray(res.insights) ? res.insights : []);
        setSavingsByCategory(Array.isArray(res.savingsByCategory) ? res.savingsByCategory : []);
        setLoading(false);
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setData([]); setInsights([]); setSavingsByCategory([]); // not the previous year's numbers under this heading
        setLoading(false);
        toast('Помилка завантаження аналітики', 'error');
      });
  }, [year]);

  const totalIncome   = data.reduce((s, d) => s + d.income, 0);
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0);
  const totalSavings  = data.reduce((s, d) => s + d.savings, 0);
  const totalBalance  = totalIncome - totalExpenses - totalSavings;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Аналітика</h1>
          <p style={{ color: 'var(--c-text-sub)', fontSize: 14 }}>Річна статистика</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[thisYear - 1, thisYear, thisYear + 1].map(y => (
            <button key={y} onClick={() => setYear(y)} className="btn-ghost"
              style={{ background: year === y ? 'rgba(249,115,22,0.2)' : undefined, color: year === y ? 'var(--c-accent-hi)' : undefined }}>
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
          // Same number and name as Головна's "Вільний залишок" card, same
          // semantic colour (green >= 0, red < 0) — it used to be orange here.
          { label: 'Вільний залишок',   value: totalBalance,  color: totalBalance >= 0 ? '#22C55E' : '#EF4444', icon: Wallet, bg: 'rgba(249,115,22,0.08)', signed: true },
        ].map(c => (
          <div key={c.label} className="stat-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--c-text-muted)', fontWeight: 600 }}>{c.label}</span>
              <div style={{ background: c.bg, borderRadius: 9, padding: 8 }}>
                <c.icon size={16} color={c.color} />
              </div>
            </div>
            {loading ? <div className="skel" style={{ height: 28, width: '70%' }} /> : (
              <div style={{ fontSize: 22, fontWeight: 800, color: NUM_VAR[c.color] ?? c.color, fontVariantNumeric: 'tabular-nums' }}>
                {c.signed ? formatMoneySign(c.value) : formatMoney(c.value)}
              </div>
            )}
            {/* Per-pool chips, savings card only — "Всього збереження" above
                is a within-year FLOW (deposits minus withdrawals); this is
                each pool's actual standing balance as of the end of the
                selected year, the answer to "скільки лежить у подушці,
                скільки в Dual Invest" (asked live 2026-09-18, previously
                answerable only via a direct DB query — nowhere in the UI).
                One row per pool (round violet icon chip, name, amount right, optional bank-balance line) — this card sits in a 4-column grid (~240px), so the rows are full-width and the name wraps instead of truncating. */}
            {c.label === 'Всього збереження' && !loading && savingsByCategory.length > 0 && (
              <div className="pool-list">
                {savingsByCategory.map(s => {
                  // Difference only when the bank balance is in the ledger currency (no conversion here).
                  const diff = s.bank && s.bank.currency === currency ? Math.round(s.bank.amount - s.balance) : 0;
                  return (
                    <div key={s.name} className="pool-row">
                      <span className="pool-chip"><PiggyBank size={15} /></span>
                      <span className="pool-name">{s.name}</span>
                      <span className="pool-amt">{formatMoneySign(s.balance)}</span>
                      {s.bank && (
                        // Secondary line: the bank's own stored balance for the account(s) mapped
                        // to this pool, dated by the (UTC) fetch day. Each fragment is nowrap so a
                        // wrap can only fall between them, never orphaning "· 11.11".
                        <div className="pool-bank">
                          <span>На рахунку SpareBank {formatMoneyIn(s.bank.amount, s.bank.currency)}</span>{' '}
                          <span>· {formatDdMm(s.bank.fetchedAt)}</span>
                          {diff !== 0 && <>{' '}<span className="diff">· різниця {diff > 0 ? '+' : '−'}{formatMoneyIn(diff, s.bank.currency)}</span></>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Insights */}
      {!loading && insights.length > 0 && (
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
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '8px 16px', marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)' }}>
            Дохід vs Витрати по місяцях
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
            {BAR_SERIES.map(([name, color]) => (
              <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--c-text-muted)' }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
                {name}
              </span>
            ))}
          </div>
        </div>
        {loading ? <div className="skel" style={{ height: 280, borderRadius: 12 }} /> : <MonthlyBarChart data={data} />}
      </div>

      {/* Balance by month */}
      <div className="card card-pad">
        <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Вільний залишок по місяцях</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {loading && <div className="skel" style={{ height: 70, width: '100%', borderRadius: 10 }} />}
          {!loading && data.map(d => {
            // Colour follows the rounded figure that's shown, so "0" is never red.
            const shown = roundCompact(d.balance);
            const good = shown >= 0;
            // No data for the month: neutral, not the green of a real zero-or-better balance.
            const empty = d.balance === 0;
            return (
              <div key={d.month} style={{
                flex: '1 1 60px', minWidth: 60,
                background: empty ? 'var(--c-hover)' : good ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${empty ? 'var(--c-border)' : good ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
                borderRadius: 10, padding: '12px 8px', textAlign: 'center',
              }}>
                <div style={{ fontSize: 12, color: 'var(--c-text-muted)', marginBottom: 6 }}>{d.month}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: empty ? 'var(--c-text-muted)' : good ? 'var(--c-pos-text)' : 'var(--c-neg-text)', fontVariantNumeric: 'tabular-nums' }}>
                  {d.balance !== 0 ? `${shown > 0 ? '+' : ''}${formatCompact(d.balance)}` : '—'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
