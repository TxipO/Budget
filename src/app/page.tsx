'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Plus, TrendingUp, TrendingDown, PiggyBank, Wallet, ChevronLeft, ChevronRight, Target, ArrowUp, ArrowDown, Download, Pencil, RefreshCw } from 'lucide-react';
import { formatMoney, MONTH_NAMES, TYPE_COLORS, type Period, PERIOD_LABELS } from '@/lib/utils';
import TransactionForm from '@/components/TransactionForm';
import RecurringModal from '@/components/RecurringModal';

const ExpenseDonut = dynamic(() => import('@/components/charts/ExpenseDonut'), { ssr: false });
const BalanceTrend = dynamic(() => import('@/components/charts/BalanceTrend'), { ssr: false });

interface Stats {
  income: number; expenses: number; savings: number;
  balance: number; cumBalance: number; forecast: number | null;
  byCategory: { name: string; amount: number; color: string; planned: number }[];
  trend: { month: string; income: number; expenses: number; savings: number; balance: number }[];
  recent: {
    id: number; date: string; amount: number; details: string;
    category: { id: number; name: string; type: string; color: string };
    user: { id: number; name: string } | null;
  }[];
  prev: { income: number; expenses: number; savings: number; balance: number } | null;
}

const PERIODS: Period[] = ['month', 'quarter', '6m', 'year', 'all'];

function pctChange(current: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((current - prev) / Math.abs(prev)) * 100);
}

function DeltaBadge({ current, prev, invertGood = false }: { current: number; prev: number; invertGood?: boolean }) {
  const pct = pctChange(current, prev);
  if (pct === null || Math.abs(pct) < 1) return null;
  const up = pct > 0;
  const good = invertGood ? !up : up;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
      background: good ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
      color: good ? '#4ADE80' : '#FCA5A5',
    }}>
      {up ? <ArrowUp size={9} /> : <ArrowDown size={9} />}
      {Math.abs(pct)}%
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="stat-card" style={{ animation: 'pulse 1.5s infinite' }}>
      <div style={{ height: 13, width: '50%', background: 'var(--c-hover)', borderRadius: 6, marginBottom: 14 }} />
      <div style={{ height: 28, width: '70%', background: 'var(--c-hover)', borderRadius: 8 }} />
    </div>
  );
}

export default function Dashboard() {
  const now = new Date();
  const [year,     setYear]     = useState(now.getFullYear());
  const [month,    setMonth]    = useState(now.getMonth() + 1);
  const [period,   setPeriod]   = useState<Period>('month');
  const [stats,    setStats]    = useState<Stats | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Stats['recent'][0] | null>(null);
  const [showRecurring, setShowRecurring] = useState(false);
  const [pendingRecurring, setPendingRecurring] = useState(0);

  useEffect(() => {
    if (period !== 'month') { setPendingRecurring(0); return; }
    fetch(`/api/recurring?year=${year}&month=${month}`)
      .then(r => r.json())
      .then((data: { applied: boolean }[]) => setPendingRecurring(data.filter(t => !t.applied).length));
  }, [year, month, period]);

  function loadStats() {
    setLoading(true);
    const params = new URLSearchParams({ period, year: String(year), month: String(month) });
    fetch(`/api/stats?${params}`)
      .then(r => r.json())
      .then(data => { setStats(data); setLoading(false); });
  }

  useEffect(() => { loadStats(); }, [year, month, period]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setEditing(null);
        setShowForm(true);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  function periodLabel() {
    if (period === 'month')   return `${MONTH_NAMES[month - 1]} ${year}`;
    if (period === 'quarter') return `Квартал · ${MONTH_NAMES[month - 1]} ${year}`;
    if (period === '6m')      return `6 міс. · до ${MONTH_NAMES[month - 1]} ${year}`;
    if (period === 'year')    return `Рік ${year}`;
    return 'Весь час';
  }

  const cardDefs = [
    { label: 'Дохід',           key: 'income'   as const, color: TYPE_COLORS.income,   icon: TrendingUp,   bg: 'rgba(34,197,94,0.08)',   invertGood: false },
    { label: 'Витрати',         key: 'expenses' as const, color: TYPE_COLORS.expense,  icon: TrendingDown, bg: 'rgba(239,68,68,0.08)',   invertGood: true  },
    { label: 'Збереження',      key: 'savings'  as const, color: TYPE_COLORS.savings,  icon: PiggyBank,    bg: 'rgba(245,158,11,0.08)',  invertGood: false },
    { label: 'Вільний залишок', key: 'balance'  as const, color: '#FB923C',            icon: Wallet,       bg: 'rgba(249,115,22,0.08)', invertGood: false },
  ];

  const categoriesWithPlan = stats?.byCategory.filter(c => c.planned > 0) ?? [];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Головна</h1>
          <p style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Огляд фінансів · {periodLabel()}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowRecurring(true)}
            className="btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, position: 'relative' }}
          >
            <RefreshCw size={15} />
            Шаблони
            {pendingRecurring > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -6,
                background: '#F97316', color: 'white', fontSize: 10, fontWeight: 800,
                borderRadius: '50%', width: 16, height: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{pendingRecurring}</span>
            )}
          </button>
          <a
            href={
              period === 'month' ? `/api/export?year=${year}&month=${month}` :
              period === 'year'  ? `/api/export?year=${year}` :
              `/api/export`
            }
            download
            className="btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 6, textDecoration: 'none', fontSize: 14, fontWeight: 600 }}
          >
            <Download size={15} /> Експорт
          </a>
          <button className="btn-primary" onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus size={16} /> Додати
          </button>
        </div>
      </div>

      {/* Period selector */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', gap: 2, padding: 4,
          background: 'var(--c-elevated)', border: '1px solid var(--c-border)', borderRadius: 12,
        }}>
          {PERIODS.map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.2s',
                background: period === p ? '#F97316' : 'transparent',
                color:      period === p ? 'white' : 'var(--c-text-muted)',
              }}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        {period !== 'year' && period !== 'all' && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 2,
            background: 'var(--c-elevated)', border: '1px solid var(--c-border)', borderRadius: 12, padding: 4,
          }}>
            <button onClick={prevMonth} className="btn-ghost" style={{ padding: '6px 8px', border: 'none', borderRadius: 8 }}>
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text-sec)', padding: '0 8px', minWidth: 128, textAlign: 'center' }}>
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <button onClick={nextMonth} className="btn-ghost" style={{ padding: '6px 8px', border: 'none', borderRadius: 8 }}>
              <ChevronRight size={16} />
            </button>
          </div>
        )}

        {period === 'year' && (
          <div style={{ display: 'flex', gap: 6 }}>
            {[2025, 2026, 2027].map(y => (
              <button
                key={y}
                onClick={() => setYear(y)}
                className="btn-ghost"
                style={{
                  background: year === y ? 'rgba(249,115,22,0.2)' : undefined,
                  color: year === y ? '#FB923C' : undefined,
                  fontWeight: year === y ? 700 : undefined,
                  fontSize: 13,
                }}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div className="grid-4" style={{ marginBottom: 24 }}>
        {loading
          ? cardDefs.map(c => <SkeletonCard key={c.label} />)
          : cardDefs.map(c => {
              const val = stats![c.key];
              const cardColor = c.key === 'balance'
                ? (val >= 0 ? TYPE_COLORS.income : TYPE_COLORS.expense)
                : c.color;
              return (
                <div key={c.label} className="stat-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                    <span style={{ fontSize: 13, color: '#64748B', fontWeight: 600 }}>{c.label}</span>
                    <div style={{ background: c.bg, borderRadius: 9, padding: 8 }}>
                      <c.icon size={16} color={cardColor} />
                    </div>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: cardColor, fontVariantNumeric: 'tabular-nums', marginBottom: 8 }}>
                    {formatMoney(val)}
                  </div>
                  {stats!.prev && (
                    <DeltaBadge current={val} prev={stats!.prev![c.key]} invertGood={c.invertGood} />
                  )}
                </div>
              );
            })
        }
      </div>

      {/* Banners row: cumulative + forecast */}
      {stats && (
        <div className={stats.forecast !== null ? 'grid-2' : ''} style={{ marginBottom: 24 }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(249,115,22,0.15), rgba(245,158,11,0.1))',
            border: '1px solid rgba(249,115,22,0.2)', borderRadius: 16,
            padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Накопичений залишок (з початку)</span>
            <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
              color: stats.cumBalance >= 0 ? '#FB923C' : '#EF4444' }}>
              {formatMoney(stats.cumBalance)}
            </span>
          </div>

          {stats.forecast !== null && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(34,197,94,0.1), rgba(16,185,129,0.07))',
              border: '1px solid rgba(34,197,94,0.15)', borderRadius: 16,
              padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <div>
                <span style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Прогноз до кінця місяця</span>
                <div style={{ fontSize: 11, color: 'var(--c-text-sub)', marginTop: 2 }}>За поточним темпом</div>
              </div>
              <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                color: stats.forecast >= 0 ? '#4ADE80' : '#FCA5A5' }}>
                {formatMoney(stats.forecast)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Budget progress bars (month view only, when plans exist) */}
      {stats && period === 'month' && categoriesWithPlan.length > 0 && (
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
            <Target size={16} color="#FB923C" />
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)' }}>Бюджет по категоріях</h3>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {categoriesWithPlan.map(cat => {
              const pct = Math.min((cat.amount / cat.planned) * 100, 100);
              const over = cat.amount > cat.planned;
              return (
                <div key={cat.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 13, color: 'var(--c-text-sec)', fontWeight: 500 }}>{cat.name}</span>
                    </div>
                    <span style={{ fontSize: 12, color: over ? '#FCA5A5' : '#64748B', fontVariantNumeric: 'tabular-nums' }}>
                      {formatMoney(cat.amount)} / {formatMoney(cat.planned)}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: 'var(--c-border-mid)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: 4,
                      width: `${pct}%`,
                      background: over
                        ? 'linear-gradient(90deg, #EF4444, #F97316)'
                        : pct > 80
                        ? 'linear-gradient(90deg, #EAB308, #F97316)'
                        : `linear-gradient(90deg, ${cat.color}, ${cat.color}99)`,
                      transition: 'width 0.6s cubic-bezier(0.4,0,0.2,1)',
                    }} />
                  </div>
                  <div style={{ fontSize: 11, color: over ? '#FCA5A5' : pct > 80 ? '#FCD34D' : '#4ADE80', marginTop: 4, fontWeight: 600 }}>
                    {over ? `Перевищення на ${formatMoney(cat.amount - cat.planned)}` : `${Math.round(pct)}% використано`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Charts row */}
      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card" style={{ padding: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 20 }}>
            Витрати по категоріях
          </h3>
          {stats && <ExpenseDonut data={stats.byCategory} total={stats.expenses} />}
        </div>
        <div className="card" style={{ padding: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 20 }}>
            Дохід та витрати
          </h3>
          {stats && <BalanceTrend data={stats.trend} />}
        </div>
      </div>

      {/* Recent transactions */}
      <div className="card" style={{ padding: 24 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 20 }}>
          Останні транзакції
        </h3>
        {stats?.recent.length === 0 && (
          <div style={{ textAlign: 'center', color: '#475569', padding: '32px 0', fontSize: 14 }}>
            Немає транзакцій за цей період
          </div>
        )}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[...Array(4)].map((_, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--c-hover)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ height: 13, width: '40%', background: 'var(--c-hover)', borderRadius: 6, marginBottom: 6 }} />
                  <div style={{ height: 11, width: '25%', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }} />
                </div>
                <div style={{ height: 16, width: 80, background: 'var(--c-hover)', borderRadius: 6 }} />
              </div>
            ))}
          </div>
        )}
        {!loading && stats?.recent.map(tx => (
          <div key={tx.id} className="table-row" style={{ display: 'flex', alignItems: 'center', padding: '12px 0', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: `${tx.category.color}20`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: tx.category.color }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>{tx.category.name}</div>
              <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                {new Date(tx.date).toLocaleDateString('uk-UA')}
                {tx.details && tx.details !== '[імпорт]' && ` · ${tx.details}`}
                {tx.user && ` · ${tx.user.name}`}
              </div>
            </div>
            <span style={{
              fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: tx.category.type === 'income' ? '#4ADE80'
                   : tx.category.type === 'expense' ? '#FCA5A5' : '#FCD34D',
            }}>
              {tx.category.type === 'income' ? '+' : '-'}{formatMoney(tx.amount)}
            </span>
            <button
              className="btn-ghost"
              onClick={() => { setEditing(tx); setShowForm(true); }}
              style={{ padding: '6px', border: 'none', borderRadius: 8, opacity: 0.5 }}
              title="Редагувати"
            >
              <Pencil size={14} />
            </button>
          </div>
        ))}
      </div>

      {showForm && (
        <TransactionForm
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={loadStats}
          editId={editing?.id}
          initial={editing ? {
            date: editing.date.slice(0, 10),
            type: editing.category.type,
            categoryId: String(editing.category.id),
            amount: String(editing.amount),
            details: editing.details,
            userId: editing.user ? String(editing.user.id) : '',
          } : undefined}
        />
      )}

      {showRecurring && (
        <RecurringModal
          year={year} month={month}
          onClose={() => setShowRecurring(false)}
          onApplied={() => { loadStats(); fetch(`/api/recurring?year=${year}&month=${month}`).then(r => r.json()).then((d: { applied: boolean }[]) => setPendingRecurring(d.filter(t => !t.applied).length)); }}
        />
      )}
    </div>
  );
}
