'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Plus, TrendingUp, TrendingDown, PiggyBank, Wallet, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Target, ArrowUp, ArrowDown, Download, Pencil, RefreshCw, Landmark } from 'lucide-react';
import { MONTH_NAMES, TYPE_COLORS, type Period, PERIOD_LABELS } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import TransactionForm from '@/components/TransactionForm';
import RecurringModal from '@/components/RecurringModal';
import CategoryIcon from '@/components/CategoryIcon';
import { useDashboardPrefs } from '@/lib/dashboardPrefs';
import { toast } from '@/lib/toast';

const ExpenseDonut = dynamic(() => import('@/components/charts/ExpenseDonut'), { ssr: false });
const BalanceTrend = dynamic(() => import('@/components/charts/BalanceTrend'), { ssr: false });

interface Stats {
  income: number; expenses: number; savings: number;
  balance: number; cumBalance: number;
  byCategory: { name: string; amount: number; color: string; icon: string; planned: number }[];
  byUser: { name: string; income: number; expenses: number; savings: number; net: number }[];
  trend: { month: string; income: number; expenses: number; savings: number; balance: number }[];
  recent: {
    id: number; date: string; amount: number; details: string; source: string;
    savingsWithdrawal: boolean;
    category: { id: number; name: string; type: string; color: string; icon: string };
    user: { id: number; name: string } | null;
  }[];
  lastByUser: { userId: number; name: string; date: string | null }[];
  prev: { income: number; expenses: number; savings: number; balance: number } | null;
}

const PERIODS: Period[] = ['month', 'quarter', '6m', 'year', 'all'];
const USER_COLORS = ['#F97316', '#3B82F6', '#A855F7', '#14B8A6'];

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
  const { formatMoney, formatMoneySign } = useCurrency();
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
  const [userSectionOpen, setUserSectionOpen] = useState(true);
  const [sections] = useDashboardPrefs();
  const [pending, setPending] = useState<{ id: string; description: string; amount: number; currency: string }[]>([]);

  interface BankConnection { key: string; userId: number; name: string; bank: 'mono' | 'sparebank'; bankLabel: string }
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncSelected, setSyncSelected] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);

  // Pending Monobank holds — never recorded as a Transaction (see
  // monoIngest.ts, they can still be declined/cancelled), but a purchase
  // that's genuinely just waiting to settle looking identical to "the sync
  // is broken" is exactly what kept generating repeat "не підтягнуло"
  // reports. Shown separately, greyed out, never counted in any total.
  useEffect(() => {
    fetch('/api/monobank/status')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((rows: { userId: number; connected: boolean }[]) => {
        const connected = rows.filter(r => r.connected);
        return Promise.all(connected.map(r => fetch(`/api/monobank/pending?userId=${r.userId}`).then(res => res.ok ? res.json() : [])));
      })
      .then(lists => setPending(lists.flat()))
      .catch(() => {}); // decorative — dashboard works fine without this list
  }, []);

  // One-click "sync all" widget in the header — same connect status this app
  // already exposes in Settings, just aggregated here so syncing doesn't
  // require a trip to Settings. Expired SpareBank 1 sessions are excluded
  // (need reconnecting there first, syncing one would just error).
  useEffect(() => {
    Promise.all([
      fetch('/api/monobank/status').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/sparebank/status').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([mono, sb]: [{ userId: number; name: string; connected: boolean }[], { userId: number; name: string; connected: boolean; expired: boolean }[]]) => {
      const conns: BankConnection[] = [
        ...mono.filter(m => m.connected).map(m => ({ key: `mono-${m.userId}`, userId: m.userId, name: m.name, bank: 'mono' as const, bankLabel: 'Monobank' })),
        ...sb.filter(s => s.connected && !s.expired).map(s => ({ key: `sparebank-${s.userId}`, userId: s.userId, name: s.name, bank: 'sparebank' as const, bankLabel: 'SpareBank 1' })),
      ];
      setBankConnections(conns);
      setSyncSelected(Object.fromEntries(conns.map(c => [c.key, true])));
    });
  }, []);

  // Sequential, not Promise.all — SpareBank 1's ASPSP enforces a strict daily
  // call cap (see project memory), so this app never fires concurrent
  // requests at the same account/bank if it can avoid it.
  async function runBankSync() {
    const toSync = bankConnections.filter(c => syncSelected[c.key]);
    if (toSync.length === 0 || syncing) return;
    setSyncing(true);
    setSyncMenuOpen(false);
    let monoTotalCreated = 0;
    let anyCreated = false;
    const errors: string[] = [];
    for (const c of toSync) {
      try {
        const endpoint = c.bank === 'mono' ? '/api/monobank/sync' : '/api/sparebank/sync';
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: c.userId }) });
        const data = await res.json().catch(() => null);
        if (!res.ok) { errors.push(`${c.name} (${c.bankLabel}): ${data?.error || 'помилка'}`); continue; }
        if (c.bank === 'mono') {
          monoTotalCreated += data.created ?? 0;
          if (data.created > 0) anyCreated = true;
        } else if (data.created > 0) {
          anyCreated = true;
          // Same undo mechanism as Settings' syncSb — sync already committed
          // the rows, so "Скасувати" is a real reversal call, not just
          // clearing a pending timer.
          toast(`${c.name} (SpareBank 1): додано ${data.created}`, 'info', {
            label: 'Скасувати',
            onClick: async () => {
              try {
                const undoRes = await fetch('/api/sparebank/undo-sync', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: c.userId, transactionIds: data.createdIds, previousSyncedAt: data.previousSyncedAt }),
                });
                if (!undoRes.ok) { toast('Не вдалося скасувати', 'error'); return; }
                toast('Скасовано', 'info');
                loadStats();
              } catch {
                toast('Помилка з’єднання', 'error');
              }
            },
          }, 5000);
        }
      } catch {
        errors.push(`${c.name} (${c.bankLabel}): помилка з'єднання`);
      }
    }
    setSyncing(false);
    if (monoTotalCreated > 0) toast(`Monobank: додано ${monoTotalCreated}`);
    if (errors.length > 0) toast(errors.join('; '), 'error');
    if (!anyCreated && errors.length === 0) toast('Нових транзакцій немає');
    loadStats();
  }

  useEffect(() => {
    if (period !== 'month') { setPendingRecurring(0); return; }
    fetch(`/api/recurring?year=${year}&month=${month}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: { applied: boolean }[]) => setPendingRecurring(data.filter(t => !t.applied).length))
      .catch(() => {});
  }, [year, month, period]);

  function loadStats() {
    setLoading(true);
    const params = new URLSearchParams({ period, year: String(year), month: String(month) });
    fetch(`/api/stats?${params}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(data => { setStats(data); setLoading(false); })
      .catch(() => { setLoading(false); toast('Помилка завантаження даних', 'error'); });
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
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Головна</h1>
          <p style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Огляд фінансів · {periodLabel()}</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {bankConnections.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setSyncMenuOpen(o => !o)}
                className="btn-ghost"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600 }}
              >
                <RefreshCw size={15} className={syncing ? 'spin' : undefined} />
                <span className="hide-on-xs">Синхронізувати</span>
              </button>
              {syncMenuOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20,
                  background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)', borderRadius: 10,
                  padding: 12, minWidth: 220, boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                }}>
                  {bankConnections.map(c => (
                    <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', cursor: 'pointer', color: 'var(--c-text-sec)' }}>
                      <input
                        type="checkbox"
                        checked={syncSelected[c.key] ?? true}
                        onChange={e => setSyncSelected(prev => ({ ...prev, [c.key]: e.target.checked }))}
                      />
                      {c.name} — {c.bankLabel}
                    </label>
                  ))}
                  <button
                    className="btn-primary" style={{ width: '100%', marginTop: 10, padding: '8px 0', fontSize: 13, justifyContent: 'center' }}
                    disabled={syncing || !bankConnections.some(c => syncSelected[c.key])}
                    onClick={runBankSync}
                  >
                    {syncing ? 'Синхронізація…' : 'Синхронізувати'}
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setShowRecurring(true)}
            className="btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 600, position: 'relative' }}
          >
            <RefreshCw size={15} />
            <span className="hide-on-xs">Шаблони</span>
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
            <Download size={15} /> <span className="hide-on-xs">Експорт</span>
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
                    {/* "Вільний залишок" (balance) is the only one of these
                        4 cards that can genuinely go negative — color alone
                        wasn't enough to tell, since red/green/orange are
                        used for other reasons across this dashboard too. */}
                    {c.key === 'balance' ? formatMoneySign(val) : formatMoney(val)}
                  </div>
                  {stats!.prev && (
                    <DeltaBadge current={val} prev={stats!.prev![c.key]} invertGood={c.invertGood} />
                  )}
                </div>
              );
            })
        }
      </div>

      {/* Cumulative balance banner */}
      {sections.banners && stats && (
        <div style={{ marginBottom: 24 }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(249,115,22,0.15), rgba(245,158,11,0.1))',
            border: '1px solid rgba(249,115,22,0.2)', borderRadius: 16,
            padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Накопичений залишок (з початку)</span>
            <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
              color: stats.cumBalance >= 0 ? '#FB923C' : '#EF4444' }}>
              {formatMoneySign(stats.cumBalance)}
            </span>
          </div>
        </div>
      )}

      {/* Budget progress bars (month view only, when plans exist) */}
      {sections.budget && stats && period === 'month' && categoriesWithPlan.length > 0 && (
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
                      <CategoryIcon name={cat.icon} color={cat.color} size={14} />
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
      {sections.charts && (
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
      )}

      {/* Хто скільки — per-user breakdown, collapsible */}
      {sections.byUser && stats && stats.byUser.length > 0 && (stats.byUser.length > 1 || stats.byUser[0].name !== 'Спільні') && (
        <div className="card" style={{ marginBottom: 24, overflow: 'hidden' }}>
          <button
            onClick={() => setUserSectionOpen(v => !v)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: 24, background: 'none', border: 'none', cursor: 'pointer',
              textAlign: 'left', paddingBottom: userSectionOpen ? 4 : 24,
            }}
          >
            <Wallet size={16} color="#FB923C" />
            <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', flex: 1 }}>Хто скільки</h3>
            {userSectionOpen
              ? <ChevronUp size={16} color="var(--c-text-muted)" />
              : <ChevronDown size={16} color="var(--c-text-muted)" />}
          </button>
          {userSectionOpen && (
            <div style={{ padding: '0 24px 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
              {stats.byUser.map((u, i) => {
                const uColor = u.name === 'Спільні' ? '#64748B' : USER_COLORS[i % USER_COLORS.length];
                const flow = u.income + u.expenses + u.savings;
                const incPct = flow > 0 ? (u.income   / flow) * 100 : 0;
                const expPct = flow > 0 ? (u.expenses / flow) * 100 : 0;
                const savPct = flow > 0 ? (u.savings  / flow) * 100 : 0;
                return (
                  <div key={u.name} style={{
                    border: '1px solid var(--c-border)', borderRadius: 14, padding: 16,
                    background: 'var(--c-elevated)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                        background: `${uColor}22`, color: uColor,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 13, fontWeight: 800,
                      }}>{u.name.charAt(0)}</div>
                      <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)' }}>{u.name}</span>
                      <span style={{
                        marginLeft: 'auto', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
                        color: u.net >= 0 ? '#4ADE80' : '#FCA5A5',
                      }}>{formatMoneySign(u.net)}</span>
                    </div>
                    <div style={{ display: 'flex', height: 6, borderRadius: 4, overflow: 'hidden', marginBottom: 12, background: 'var(--c-border-mid)' }}>
                      <div style={{ width: `${incPct}%`, background: '#22C55E' }} />
                      <div style={{ width: `${expPct}%`, background: '#EF4444' }} />
                      <div style={{ width: `${savPct}%`, background: '#F59E0B' }} />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {[
                        { label: 'Дохід',      val: u.income,   c: '#4ADE80' },
                        { label: 'Витрати',    val: u.expenses, c: '#FCA5A5' },
                        { label: 'Збереження', val: u.savings,  c: '#FCD34D' },
                      ].filter(r => r.val > 0).map(r => (
                        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                          <span style={{ color: 'var(--c-text-muted)' }}>{r.label}</span>
                          <span style={{ color: r.c, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatMoney(r.val)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Pending Monobank holds — not counted anywhere, purely informational */}
      {pending.length > 0 && (
        <div className="card" style={{ padding: 24, marginBottom: 24, opacity: 0.75 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 4 }}>
            Очікують підтвердження
          </h3>
          <p style={{ fontSize: 12, color: '#64748B', marginBottom: 16 }}>
            Банк ще не підтвердив ці покупки — не входять у підсумки, з'являться автоматично після підтвердження.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map(p => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                <span style={{ color: 'var(--c-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.description || 'Без опису'}
                </span>
                <span style={{ color: 'var(--c-text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {formatMoney(p.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent transactions */}
      {sections.recent && (
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
            <CategoryIcon name={tx.category.icon} color={tx.category.color} size={16} tile />

            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', display: 'flex', alignItems: 'center', gap: 5 }}>
                {tx.category.name}
                {(tx.source === 'mono' || tx.source === 'sparebank') && <span title={`Автоматично підтягнуто з ${tx.source === 'mono' ? 'Monobank' : 'SpareBank 1'}`} style={{ display: 'flex' }}><Landmark size={11} color="#38BDF8" /></span>}
              </div>
              <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>
                {new Date(tx.date).toLocaleDateString('uk-UA')}
                {tx.details && tx.details !== '[імпорт]' && ` · ${tx.details}`}
                {tx.user && ` · ${tx.user.name}`}
              </div>
            </div>
            <span style={{
              fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: tx.category.type === 'income' || (tx.category.type === 'savings' && tx.savingsWithdrawal) ? '#4ADE80'
                   : tx.category.type === 'expense' ? '#FCA5A5' : '#FCD34D',
            }}>
              {tx.category.type === 'income' || (tx.category.type === 'savings' && tx.savingsWithdrawal) ? '+' : '-'}{formatMoney(tx.amount)}
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

        {/* All-time per-user last entry — deliberately NOT scoped to the
            period filter above (stats.lastByUser is computed all-time
            server-side): the point is "did someone forget to log
            something recently", which a period-filtered answer would
            silently hide if it's been longer than the current view. */}
        {!loading && stats && stats.lastByUser.length > 0 && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--c-border)', fontSize: 13, color: 'var(--c-text-muted)' }}>
            <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--c-text-sec)' }}>Останнє додавання:</div>
            {stats.lastByUser.map(u => (
              <div key={u.userId}>
                {u.name} — {u.date ? new Date(u.date).toLocaleDateString('uk-UA') : 'ще немає транзакцій'}
              </div>
            ))}
          </div>
        )}
      </div>
      )}

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
            savingsWithdrawal: editing.savingsWithdrawal,
          } : undefined}
        />
      )}

      {showRecurring && (
        <RecurringModal
          year={year} month={month}
          onClose={() => setShowRecurring(false)}
          onApplied={() => { loadStats(); fetch(`/api/recurring?year=${year}&month=${month}`).then(r => r.ok ? r.json() : Promise.reject()).then((d: { applied: boolean }[]) => setPendingRecurring(d.filter(t => !t.applied).length)).catch(() => {}); }}
        />
      )}
    </div>
  );
}
