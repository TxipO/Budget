'use client';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Plus, TrendingUp, TrendingDown, PiggyBank, Layers, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowUp, ArrowDown, Pencil, RefreshCw, AlertCircle, Landmark, LineChart, ArrowLeftRight, Clock, Target } from 'lucide-react';
import { MONTH_NAMES, MONTH_SHORT, CATEGORY_PALETTE, BANK_SYNC_COLOR, type Period, PERIOD_LABELS } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import { displayColor } from '@/lib/displayColor';
import TransactionForm from '@/components/TransactionForm';
import CategoryIcon from '@/components/CategoryIcon';
import CountUp from '@/components/CountUp';
import { useDashboardPrefs } from '@/lib/dashboardPrefs';
import { toast } from '@/lib/toast';

const ExpenseDonut = dynamic(() => import('@/components/charts/ExpenseDonut'), { ssr: false });
const BalanceTrend = dynamic(() => import('@/components/charts/BalanceTrend'), { ssr: false });

interface Stats {
  income: number; expenses: number; savings: number; transfers: number;
  balance: number; cumBalance: number;
  pools?: { categoryId: number; name: string; balance: number }[];
  byCategory: { categoryId: number; name: string; amount: number; color: string; icon: string; planned: number }[];
  byUser: { name: string; income: number; expenses: number; savings: number; net: number }[];
  trend: { month: string; income: number; expenses: number; savings: number; balance: number }[];
  recent: {
    id: number; date: string; amount: number; details: string; source: string;
    savingsWithdrawal: boolean;
    isTransfer: boolean;
    category: { id: number; name: string; type: string; color: string; icon: string };
    user: { id: number; name: string } | null;
  }[];
  lastByUser: { userId: number; name: string; date: string | null }[];
  prev: { income: number; expenses: number; savings: number; transfers: number; balance: number } | null;
}
type Tx = Stats['recent'][0];

interface PlanRow { year: number; month: number; categoryId: number; plannedAmount: number; category: { id: number; name: string; type: string; color: string; icon: string } }

// SpareBank 1 consent lapses periodically (needs BankID again); warn this far ahead.
const CONSENT_WARN_MS = 7 * 24 * 3600 * 1000;
// Daily cron — more than 36 h since its last attempt means it stopped running.
const AUTOSYNC_STALE_MS = 36 * 3600 * 1000;
// Server-side weekly check (cron) is overdue past this.
const WEEKLY_CHECK_STALE_MS = 8 * 24 * 3600 * 1000;
// Balances refresh on every sync; 3 days old means the bank link is quietly failing.
const BALANCE_ISSUE_MS = 3 * 24 * 3600 * 1000;

const PERIODS: Period[] = ['month', 'quarter', '6m', 'year', 'all'];
// Household member avatar colors — drawn from the documented category
// palette instead of a bespoke set, and picked to skip the shades this page
// already uses semantically (red/green/orange/amber = expense/income/brand/
// savings): blue, purple, teal, pink.
const USER_COLORS = [CATEGORY_PALETTE[10], CATEGORY_PALETTE[11], CATEGORY_PALETTE[7], CATEGORY_PALETTE[6]];

const TX_PREVIEW = 3;      // rows visible while the list is collapsed
const PLAN_ROWS_MAX = 6;   // plan bars shown; the rest live on /planning

const vars = (o: Record<string, string | number>) => o as CSSProperties;

// Months a dashboard period covers, matching api/stats' range maths (rolling
// quarter / 6 months ending at `month`; the calendar year). 'all' has no
// bounded month set, so no plan can be summed for it.
function planMonths(period: Period, year: number, month: number): { y: number; m: number }[] | null {
  if (period === 'month') return [{ y: year, m: month }];
  if (period === 'year') return Array.from({ length: 12 }, (_, i) => ({ y: year, m: i + 1 }));
  if (period === 'all') return null;
  const n = period === 'quarter' ? 3 : 6;
  return Array.from({ length: n }, (_, k) => {
    const d = new Date(Date.UTC(year, month - n + k, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  });
}

// "143300 COOP PRIX BALESTRA" — terminal digits first; keep the raw text but
// mute the code so the merchant reads first.
function splitCode(desc: string): [string, string] {
  const m = /^(\d{4,})\s+(.+)$/.exec(desc);
  return m ? [m[1], m[2]] : ['', desc];
}

function HeroSkeleton() {
  return (
    <div className="d-card d-hero">
      <span className="skel" style={{ height: 14, width: 110 }} />
      <span className="skel" style={{ height: 64, width: '70%', marginTop: 12 }} />
      <span className="skel" style={{ height: 34, width: '80%', marginTop: 14, borderRadius: 999 }} />
      <span className="d-grow" />
      <div className="d-hfoot">
        <div><span className="skel" style={{ height: 12, width: 70 }} /><span className="skel" style={{ height: 20, width: 90, marginTop: 8 }} /></div>
        <div><span className="skel" style={{ height: 12, width: 70 }} /><span className="skel" style={{ height: 20, width: 90, marginTop: 8 }} /></div>
      </div>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="d-card d-stat">
      <span className="d-chip skel" />
      <div style={{ flex: 1 }}>
        <span className="skel" style={{ height: 12, width: '50%' }} />
        <span className="skel" style={{ height: 22, width: '75%', marginTop: 8 }} />
      </div>
    </div>
  );
}

function TxSkeleton() {
  return (
    <div className="d-tx-list">
      {[0, 1, 2].map(i => (
        <div key={i} className="d-skel-row">
          <span className="skel" style={{ width: 44, height: 44, borderRadius: '50%', flex: 'none' }} />
          <div style={{ flex: 1 }}>
            <span className="skel" style={{ height: 14, width: '55%' }} />
            <span className="skel" style={{ height: 12, width: '35%', marginTop: 8 }} />
          </div>
          <span className="skel" style={{ height: 16, width: 64 }} />
        </div>
      ))}
    </div>
  );
}

// First 3 rows always visible; the rest unfold in place (height animates, rows
// fade up with a short stagger). Clipped rows are inert so they cannot take focus.
function RecentList({ rows, onEdit }: { rows: Tx[]; onEdit: (tx: Tx) => void }) {
  const { formatMoney } = useCurrency();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const [h, setH] = useState<{ collapsed: number; full: number } | null>(null);
  const extra = rows.length - TX_PREVIEW;

  useLayoutEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const measure = () => {
      const third = ul.children[TX_PREVIEW - 1] as HTMLElement | undefined;
      setH({ full: ul.offsetHeight, collapsed: third ? third.offsetTop + third.offsetHeight : ul.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [rows]);

  return (
    <>
      <div className={`d-tx-wrap${open ? ' open' : ''}`} style={extra > 0 && h ? { height: open ? h.full : h.collapsed } : undefined}>
        <ul ref={listRef} id="recent-tx" className="d-tx-list">
          {rows.map((tx, i) => {
            const isExtra = i >= TX_PREVIEW;
            const type = tx.category.type;
            // A leading long terminal/bank code ("143300 COOP PRIX") is noise in a title: dropped for display only.
            const cleaned = tx.details && tx.details !== '[імпорт]' ? tx.details.replace(/^\d{5,}\s+/, '').trim() : '';
            const meaningful = !!cleaned;
            // People-named income categories repeat the person ("Паша · Паша"): show a name once.
            const seen = new Set<string>();
            const meta = [meaningful ? tx.category.name : null, tx.user?.name]
              .filter((x): x is string => !!x && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase())).join(' · ');
            const date = new Date(tx.date).toLocaleDateString('uk-UA', { timeZone: 'UTC', day: 'numeric', month: 'short' });
            const label = meaningful ? cleaned : tx.category.name;
            return (
              <li key={tx.id} className={`d-tx-row${isExtra ? ' extra' : ''}`} style={vars({ '--k': i - TX_PREVIEW })} inert={isExtra && !open}>
                {/* The whole row is the edit control (button semantics): on phones a separate 40px pencil ate the width. */}
                <button type="button" className="d-tx-hit" onClick={() => onEdit(tx)} aria-label={`Редагувати: ${label}, ${type === 'income' ? 'надходження' : type === 'expense' ? 'витрата' : 'збереження'} ${formatMoney(tx.amount)}`}>
                  <span className="d-chip d-cat-chip" style={vars({ '--cc': displayColor(tx.category.color, tx.category.id) })}>
                    <CategoryIcon name={tx.category.icon} color="currentColor" size={20} />
                  </span>
                  <span className="d-tx-main">
                    <b>{label}</b>
                    <small>
                      {(tx.source === 'mono' || tx.source === 'sparebank') && <Landmark size={11} color={BANK_SYNC_COLOR} aria-label={`Автоматично підтягнуто з ${tx.source === 'mono' ? 'Monobank' : 'SpareBank 1'}`} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 5 }} />}
                      {meta}<span className="d-date">{meta ? ' · ' : ''}{date}</span>
                    </small>
                  </span>
                  {/* A savings row's sign is the POT's perspective, not the
                      wallet's: a deposit is positive, a withdrawal negative —
                      the same convention as the "Збереження" tile it rolls up
                      into (found live 2026-08-29: these once disagreed). */}
                  <span className={`d-amt ${type === 'income' ? 'inc' : type === 'expense' ? 'exp' : 'sav'}`}>
                    {type === 'income' || (type === 'savings' && !tx.savingsWithdrawal) ? '+' : '−'}{formatMoney(tx.amount)}
                  </span>
                  <Pencil size={15} className="d-tx-pen" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {extra > 0 && (
        <button className="d-more" aria-expanded={open} aria-controls="recent-tx" onClick={() => setOpen(o => !o)}>
          {open ? 'Згорнути' : `Показати ще ${extra}`}
          <ChevronDown size={16} />
        </button>
      )}
    </>
  );
}

export default function Dashboard() {
  const { formatMoney, formatMoneySign } = useCurrency();
  // UTC getters: the server and the planning page work in UTC months, and it
  // makes the SSR and client initial values agree whatever the browser's zone.
  const now = new Date();
  const [year,     setYear]     = useState(now.getUTCFullYear());
  const [month,    setMonth]    = useState(now.getUTCMonth() + 1);
  const [period,   setPeriod]   = useState<Period>('month');
  const [stats,    setStats]    = useState<Stats | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Only the newest loadStats response may land; paramsRef lets callers that
  // outlive a render (sync, undo toast) still fetch the CURRENT period.
  const statsSeq = useRef(0);
  const paramsRef = useRef({ period: 'month' as Period, year, month });
  paramsRef.current = { period, year, month };
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);
  // Collapsed by default — one of 6+ simultaneous dashboard blocks (critique
  // 2026-08-02, P1); still one click away, nothing lost.
  const [userSectionOpen, setUserSectionOpen] = useState(false);
  const [sections] = useDashboardPrefs();
  const [pending, setPending] = useState<{ id: string; description: string; amount: number; currency: string }[]>([]);

  interface BankConnection { key: string; userId: number; name: string; bank: 'mono' | 'sparebank'; bankLabel: string }
  const [bankConnections, setBankConnections] = useState<BankConnection[]>([]);
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [quarterMenuOpen, setQuarterMenuOpen] = useState(false);
  // Red "needs attention" badge by the sync button: hover previews, click/tap pins
  // (touch has no hover), so the two are tracked apart.
  const [issues, setIssues] = useState<string[]>([]);
  const [warnHover, setWarnHover] = useState(false);
  const [warnPinned, setWarnPinned] = useState(false);
  const warnRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<HTMLDivElement>(null);
  const quarterRef = useRef<HTMLDivElement>(null);

  // Outside tap/click closes the header dropdowns. On phones they are fixed
  // bottom sheets with no backdrop, so without this the only way out was
  // re-tapping the small trigger. touchstart too: iOS Safari doesn't always
  // synthesize mousedown for taps on non-interactive areas.
  useEffect(() => {
    if (!syncMenuOpen && !quarterMenuOpen && !warnPinned && !warnHover) return;
    function onOutside(e: Event) {
      const t = e.target as Node;
      if (warnPinned && !warnRef.current?.contains(t)) setWarnPinned(false);
      if (syncMenuOpen && !syncRef.current?.contains(t)) setSyncMenuOpen(false);
      if (quarterMenuOpen && !quarterRef.current?.contains(t)) setQuarterMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setWarnPinned(false); setWarnHover(false); setSyncMenuOpen(false); setQuarterMenuOpen(false); }
    }
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [syncMenuOpen, quarterMenuOpen, warnPinned, warnHover]);
  const [syncSelected, setSyncSelected] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState(false);
  // Only visible feedback once the dropdown auto-closes at sync start
  // (critique 2026-08-02, P2): per-account progress while syncing, then a
  // "last synced" timestamp that stays put until the next run.
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Pending Monobank holds — never recorded as a Transaction (see
  // monoIngest.ts, they can still be declined/cancelled), but a purchase
  // that's genuinely just waiting to settle looking identical to "the sync
  // is broken" is exactly what kept generating repeat "не підтягнуло"
  // reports. Shown separately, never counted in any total.
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
  // (need reconnecting there first, syncing one would just error). The same
  // two responses feed the "needs attention" badge, so no second request.
  // Re-run after a sync so the badge clears once the bank link is healthy again.
  function loadBankStatus() {
    Promise.all([
      fetch('/api/monobank/status').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/sparebank/status').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([mono, sb]: [
      { userId: number; name: string; connected: boolean; balanceFetchedAt: string | null; lastSyncError: string | null }[],
      { userId: number; name: string; connected: boolean; expired: boolean; validUntil: string | null; autoSync: boolean; lastAutoSyncAt: string | null; autoSyncFailCount: number; lastSyncError: string | null; weeklyCheckAt?: string | null; accounts: { syncEnabled: boolean; balanceFetchedAt: string | null }[] }[],
    ]) => {
      const conns: BankConnection[] = [
        ...mono.filter(m => m.connected).map(m => ({ key: `mono-${m.userId}`, userId: m.userId, name: m.name, bank: 'mono' as const, bankLabel: 'Monobank' })),
        ...sb.filter(s => s.connected && !s.expired).map(s => ({ key: `sparebank-${s.userId}`, userId: s.userId, name: s.name, bank: 'sparebank' as const, bankLabel: 'SpareBank 1' })),
      ];
      setBankConnections(conns);
      setSyncSelected(prev => Object.fromEntries(conns.map(c => [c.key, prev[c.key] ?? true])));

      const t = Date.now();
      const dm = (d: string | number) => new Date(d).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' });
      const found: string[] = [];
      for (const s of sb.filter(s => s.connected)) {
        if (s.expired) { found.push(`${s.name}: доступ SpareBank 1 прострочено — перепідключи в Налаштуваннях (BankID)`); continue; }
        if (s.validUntil && new Date(s.validUntil).getTime() - t < CONSENT_WARN_MS) found.push(`${s.name}: доступ SpareBank 1 спливає ${dm(s.validUntil)} — перепідключи в Налаштуваннях`);
        // lastAutoSyncAt is the last ATTEMPT (set on failure too), so with a fail count it dates the last try.
        if (s.autoSync && s.autoSyncFailCount > 0) found.push(`${s.name}: автосинхронізація SpareBank 1 завершується помилкою${s.lastAutoSyncAt ? ` (остання спроба ${dm(s.lastAutoSyncAt)})` : ''}${s.lastSyncError ? `: ${s.lastSyncError}` : ''}`);
        else if (s.autoSync && s.lastAutoSyncAt && t - new Date(s.lastAutoSyncAt).getTime() > AUTOSYNC_STALE_MS) found.push(`${s.name}: автосинхронізація SpareBank 1 не запускалась з ${dm(s.lastAutoSyncAt)}`);
        const old = s.accounts.filter(a => a.syncEnabled && a.balanceFetchedAt && t - new Date(a.balanceFetchedAt).getTime() > BALANCE_ISSUE_MS).map(a => new Date(a.balanceFetchedAt!).getTime());
        if (old.length) found.push(`${s.name}: баланс SpareBank 1 не оновлювався з ${dm(Math.min(...old))}`);
      }
      for (const m of mono.filter(m => m.connected && m.lastSyncError)) found.push(`Monobank ${m.name}: не вдається отримати виписку — ${m.lastSyncError}`);
      for (const m of mono.filter(m => m.connected && m.balanceFetchedAt && t - new Date(m.balanceFetchedAt).getTime() > BALANCE_ISSUE_MS)) {
        found.push(`${m.name}: баланс Monobank не оновлювався з ${dm(m.balanceFetchedAt!)}`);
      }
      const wc = sb[0]?.weeklyCheckAt;
      if (wc && t - new Date(wc).getTime() > WEEKLY_CHECK_STALE_MS) found.push(`Щотижнева перевірка не запускалась з ${dm(wc)}`);
      setIssues(found);
    });
  }
  useEffect(() => { loadBankStatus(); }, []);

  // Sequential, not Promise.all — SpareBank 1's ASPSP enforces a strict daily
  // call cap (see project memory), so this app never fires concurrent
  // requests at the same account/bank if it can avoid it.
  async function runBankSync() {
    const toSync = bankConnections.filter(c => syncSelected[c.key]);
    if (toSync.length === 0 || syncing) return;
    setSyncing(true);
    setSyncMenuOpen(false);
    setSyncStatus(`Синхронізація 0/${toSync.length}…`);
    let monoTotalCreated = 0;
    let anyCreated = false;
    const errors: string[] = [];
    for (let i = 0; i < toSync.length; i++) {
      const c = toSync[i];
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
          // clearing a pending timer. undo-sync rewinds ONE account's
          // watermark and so needs that account's own id + previous
          // watermark, which only exist per-entry in `perAccount` — there is
          // no top-level previousSyncedAt since a user can own several
          // syncEnabled accounts. Offered only when exactly one account
          // actually synced, matching Settings' identical guard.
          const single = data.perAccount?.length === 1 ? data.perAccount[0] : null;
          toast(`${c.name} (SpareBank 1): додано ${data.created}`, 'info', single ? {
            label: 'Скасувати',
            onClick: async () => {
              try {
                const undoRes = await fetch('/api/sparebank/undo-sync', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: c.userId, accountId: single.accountId, transactionIds: data.createdIds, previousSyncedAt: single.previousSyncedAt }),
                });
                if (!undoRes.ok) { toast('Не вдалося скасувати', 'error'); return; }
                toast('Скасовано', 'info');
                loadStats();
              } catch {
                toast('Помилка з’єднання', 'error');
              }
            },
          } : undefined, 10000);
        }
      } catch {
        errors.push(`${c.name} (${c.bankLabel}): помилка з'єднання`);
      }
      setSyncStatus(`Синхронізація ${i + 1}/${toSync.length}…`);
    }
    setSyncing(false);
    setSyncStatus(`Останній синк: ${new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`);
    if (monoTotalCreated > 0) toast(`Monobank: додано ${monoTotalCreated}`);
    errors.forEach(e => toast(e, 'error'));
    if (!anyCreated && errors.length === 0) toast('Нових транзакцій немає');
    loadStats();
    loadBankStatus();
  }

  function loadStats() {
    const seq = ++statsSeq.current;
    setLoading(true);
    setLoadError(false);
    const { period, year, month } = paramsRef.current;
    const params = new URLSearchParams({ period, year: String(year), month: String(month) });
    fetch(`/api/stats?${params}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(data => { if (seq !== statsSeq.current) return; setStats(data); setLoading(false); })
      .catch(() => {
        if (seq !== statsSeq.current) return;
        // Drop the old numbers: they belong to another period than the heading.
        setStats(null); setLoadError(true); setLoading(false);
        toast('Помилка завантаження даних', 'error');
      });
  }

  useEffect(() => { loadStats(); }, [year, month, period]);

  // Plans for the months the period covers. Same source as the planning page
  // (/api/plans?year=…, one request per calendar year touched, cached for the
  // life of the page); the per-category sum over the range is the "plan".
  const planCache = useRef<Record<number, Promise<PlanRow[]>>>({});
  const planKey = `${period}|${year}|${month}`;
  const [planState, setPlanState] = useState<{ key: string; rows: PlanRow[] | 'error' | null }>({ key: '', rows: null });
  useEffect(() => {
    const months = planMonths(period, year, month);
    if (!months) { setPlanState({ key: planKey, rows: [] }); return; }
    setPlanState({ key: planKey, rows: null });
    let cancelled = false;
    const years = [...new Set(months.map(m => m.y))];
    Promise.all(years.map(y => {
      planCache.current[y] ??= fetch(`/api/plans?year=${y}`)
        .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json() as Promise<PlanRow[]>; })
        .catch(e => { delete planCache.current[y]; throw e; });
      return planCache.current[y];
    }))
      .then(lists => {
        if (cancelled) return;
        setPlanState({ key: planKey, rows: lists.flat().filter(p => months.some(m => m.y === p.year && m.m === p.month)) });
      })
      .catch(() => { if (!cancelled) setPlanState({ key: planKey, rows: 'error' }); });
    return () => { cancelled = true; };
  }, [planKey]);

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

  // Hero "Вільний залишок": words instead of a % pill — a % of a negative or
  // sign-flipping base ("↓560%") says nothing, a krone amount always does.
  const PREV_LABEL: Partial<Record<Period, string>> = { month: 'минулого місяця', quarter: 'попереднього кварталу', '6m': 'попередніх 6 міс.', year: 'минулого року' };
  const balanceDiff = stats?.prev ? Math.round(stats.balance - stats.prev.balance) : null;

  // "Подушка": the standing balance of the pillow pot(s) as of the period end
  // (stats.pools). No pot named like a pillow -> all pots as "Накопичення";
  // no pots at all -> the card falls back to Перекази.
  const pools = stats?.pools ?? [];
  const pillow = pools.filter(p => /подушк/i.test(p.name));
  const poolCard = pillow.length || pools.length
    ? { label: pillow.length ? 'Подушка' : 'Накопичення', value: (pillow.length ? pillow : pools).reduce((s, p) => s + p.balance, 0) }
    : null;
  const statCards: { key: string; label: string; icon: typeof TrendingUp; tone: string; value: number; signed: boolean }[] = stats ? [
    { key: 'income',   label: 'Дохід',      icon: TrendingUp,   tone: 'gr', value: stats.income,   signed: false },
    { key: 'expenses', label: 'Витрати',    icon: TrendingDown, tone: 'rd', value: stats.expenses, signed: false },
    // "Збереження" can net negative (more withdrawals than deposits) and
    // formatMoney() drops the sign — found live 2026-09-07.
    { key: 'savings',  label: 'Збереження', icon: PiggyBank,    tone: 'am', value: stats.savings,  signed: true },
    poolCard
      ? { key: 'pool', label: poolCard.label, icon: Layers, tone: 'vi', value: poolCard.value, signed: poolCard.value < 0 }
      : { key: 'transfers', label: 'Перекази', icon: ArrowLeftRight, tone: '', value: stats.transfers, signed: false },
  ] : [];

  // Plan vs fact: every expense category with a plan in the period.
  const planReady = !loading && stats && planState.key === planKey && planState.rows !== null;
  let planRows: { id: number; name: string; color: string; planned: number; fact: number }[] = [];
  if (stats && planReady && Array.isArray(planState.rows)) {
    const planned = new Map<number, { cat: PlanRow['category']; sum: number }>();
    for (const p of planState.rows) {
      if (p.category?.type !== 'expense' || !(p.plannedAmount > 0)) continue;
      const cur = planned.get(p.categoryId);
      if (cur) cur.sum += p.plannedAmount; else planned.set(p.categoryId, { cat: p.category, sum: p.plannedAmount });
    }
    const fact = new Map(stats.byCategory.map(c => [c.categoryId, c.amount]));
    planRows = [...planned.entries()]
      .map(([id, { cat, sum }]) => ({ id, name: cat.name, color: displayColor(cat.color, id), planned: sum, fact: fact.get(id) ?? 0 }))
      .sort((a, b) => b.fact / b.planned - a.fact / a.planned);
  }

  const donutData = stats?.byCategory.map(c => ({ name: c.name, amount: c.amount, color: displayColor(c.color, c.categoryId) })) ?? [];
  const showDonut = sections.charts;
  const showPlan = sections.budget;
  const hasTwo = showDonut || showPlan;
  const showByUser = sections.byUser && !!stats && stats.byUser.length > 0 && (stats.byUser.length > 1 || stats.byUser[0].name !== 'Спільні');
  const failed = !loading && !stats;

  return (
    <div className="dash dash-stack">
      {/* Header */}
      <div className="dash-head">
        <div className="dash-title">
          <h1>{periodLabel()}</h1>
          {(period === 'month' || period === '6m') && (
            <>
              <button onClick={prevMonth} className="d-round" title="Попередній місяць" aria-label="Попередній місяць"><ChevronLeft size={18} /></button>
              <button onClick={nextMonth} className="d-round" title="Наступний місяць" aria-label="Наступний місяць"><ChevronRight size={18} /></button>
            </>
          )}

          {/* Quarter is a fixed calendar quarter (Січ-Бер / Кві-Чер / Лип-Вер
              / Жов-Гру), not "3 months back from wherever the month stepper
              happens to be". Picking quarter N just sets month=N*3, which
              api/stats already treats as a rolling 3-month window ending
              there, so no backend change was needed. */}
          {period === 'quarter' && (
            <div ref={quarterRef} style={{ position: 'relative' }}>
              <button onClick={() => setQuarterMenuOpen(o => !o)} className="d-btn" style={{ height: 36, padding: '0 14px', fontSize: 13 }} aria-expanded={quarterMenuOpen}>
                {Math.ceil(month / 3)} квартал · {year}
                <ChevronDown size={14} />
              </button>
              {quarterMenuOpen && (
                <div className="header-dropdown" style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 6, zIndex: 20,
                  background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)', borderRadius: 16,
                  padding: 10, minWidth: 200, boxShadow: '0 12px 32px -8px rgba(0,0,0,0.45)',
                }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                    {[year - 1, year, year + 1].map(y => (
                      <button
                        key={y}
                        onClick={() => setYear(y)}
                        className="btn-ghost"
                        style={{
                          // .btn-ghost is inline-flex with no justify-content,
                          // so the label sat at flex-start once the horizontal
                          // padding was zeroed out.
                          flex: 1, justifyContent: 'center',
                          padding: '5px 0', borderRadius: 999, fontSize: 12, fontWeight: 600,
                          background: year === y ? 'var(--c-brand)' : 'transparent',
                          color: year === y ? 'var(--c-on-brand)' : 'var(--c-text-muted)',
                        }}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                  {[1, 2, 3, 4].map(q => (
                    <button
                      key={q}
                      onClick={() => { setMonth(q * 3); setQuarterMenuOpen(false); }}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                        borderRadius: 12, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                        fontSize: 13, fontWeight: 600,
                        background: Math.ceil(month / 3) === q ? 'var(--c-brand)' : 'transparent',
                        color: Math.ceil(month / 3) === q ? 'var(--c-on-brand)' : 'var(--c-text-sec)',
                      }}
                    >
                      {q} квартал · {MONTH_SHORT[q * 3 - 3]}–{MONTH_SHORT[q * 3 - 1]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {period === 'year' && (
            <div className="d-pills">
              {[now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1].map(y => (
                <button key={y} aria-pressed={year === y} onClick={() => setYear(y)} style={{ padding: '0 14px', fontSize: 13 }}>{y}</button>
              ))}
            </div>
          )}
        </div>

        {/* 5 labels measured ~393px, wider than a 375px phone: on mobile the
            buttons tighten so they fit at 360+, and the pill row still
            scrolls (scrollbar hidden) on anything narrower. */}
        <div className="d-pills">
          {PERIODS.map(p => (
            <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{PERIOD_LABELS[p]}</button>
          ))}
        </div>

        <div className="dash-actions">
          {bankConnections.length > 0 && (
            <div ref={syncRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setSyncMenuOpen(o => !o)}
                className="d-btn"
                title="Синхронізувати" aria-label="Синхронізувати" aria-expanded={syncMenuOpen}
              >
                <RefreshCw size={16} className={syncing ? 'spin' : undefined} />
                <span className="hide-on-xs">Синхронізувати</span>
              </button>
              {syncMenuOpen && (
                <div className="header-dropdown" style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20,
                  background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)', borderRadius: 16,
                  padding: 14, minWidth: 220, boxShadow: '0 12px 32px -8px rgba(0,0,0,0.45)',
                }}>
                  {bankConnections.map(c => (
                    <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '10px 0', cursor: 'pointer', color: 'var(--c-text-sec)' }}>
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
              {!syncMenuOpen && syncStatus && (
                <div className="sync-status-label" style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  fontSize: 12, color: 'var(--c-text-muted)', whiteSpace: 'nowrap',
                }}>
                  {syncStatus}
                </div>
              )}
            </div>
          )}
          {/* Independent of bankConnections: an expired-only SpareBank has none. */}
          {issues.length > 0 && (
            <div
              ref={warnRef} style={{ position: 'relative' }}
              onPointerEnter={e => { if (e.pointerType === 'mouse') setWarnHover(true); }}
              onPointerLeave={e => { if (e.pointerType === 'mouse') setWarnHover(false); }}
            >
              <button
                onClick={() => setWarnPinned(p => !p)}
                className="attn-btn d-attn" title="Потрібна увага" aria-label="Потрібна увага" aria-expanded={warnHover || warnPinned}
              >
                <AlertCircle size={22} />
              </button>
              {(warnHover || warnPinned) && (
                <div className="header-dropdown" role="status" style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 20,
                  background: 'var(--c-raised)', border: '1px solid rgba(239,68,68,0.55)', borderRadius: 16,
                  padding: 14, width: 300, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 12px 32px -8px rgba(0,0,0,0.45)',
                }}>
                  <ul style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--c-text)' }}>
                    {issues.map(i => <li key={i}>{i}</li>)}
                  </ul>
                  <a href="/settings" style={{ display: 'inline-block', marginTop: 10, fontSize: 13, fontWeight: 600, color: 'var(--c-accent-text)' }}>Відкрити Налаштування</a>
                </div>
              )}
            </div>
          )}
          <button className="d-btn pr" onClick={() => { setEditing(null); setShowForm(true); }} title="Додати (Alt+N)">
            <Plus size={18} /> Додати
          </button>
        </div>
      </div>

      {failed ? (
        <div className="d-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>
            {loadError ? 'Не вдалося завантажити дані за цей період' : 'Немає даних'}
          </span>
          <button className="d-btn" onClick={loadStats}>Спробувати ще раз</button>
        </div>
      ) : (
        <>
          <div className={`dash-grid${hasTwo ? ' wide' : ''}`}>
            {/* Left: free balance hero over the four period figures. */}
            <div className="dash-col">
              {loading || !stats ? (
                <>
                  <HeroSkeleton />
                  <div className="d-stats">{[0, 1, 2, 3].map(i => <StatSkeleton key={i} />)}</div>
                </>
              ) : (
                <>
                  <section className="d-card d-hero d-rise" style={vars({ '--i': 0 })}>
                    <span className="d-lb">Вільний залишок</span>
                    {/* formatMoney() alone drops the sign (Math.abs inside) — a
                        net-negative period must read "−", so the signed variant. */}
                    <div className="d-big"><CountUp value={stats.balance} signed={stats.balance < 0} /></div>
                    {balanceDiff !== null && PREV_LABEL[period] && (
                      <span className={`d-delta ${balanceDiff === 0 ? 'zero' : balanceDiff > 0 ? 'pos' : 'neg'}`}>
                        {balanceDiff !== 0 && (balanceDiff > 0 ? <ArrowUp size={16} /> : <ArrowDown size={16} />)}
                        {balanceDiff === 0
                          ? `Так само, як ${PREV_LABEL[period]}`
                          : `На ${formatMoney(balanceDiff)} ${balanceDiff > 0 ? 'більше' : 'менше'}, ніж ${PREV_LABEL[period]}`}
                      </span>
                    )}
                    {/* Cumulative (all-time) balance + transfers: readable second
                        numbers, not footnotes. "З початку" hides with the
                        "Накопичений залишок" dashboard preference; Перекази moves
                        here only while the fourth card is the pool. */}
                    {(sections.banners || poolCard) && <span className="d-grow" />}
                    {(sections.banners || poolCard) && (
                      <div className="d-hfoot">
                        {sections.banners && (
                          <div>
                            <span className="d-lb">З початку</span>
                            <b><CountUp value={stats.cumBalance} signed /></b>
                          </div>
                        )}
                        {poolCard && (
                          <div>
                            <span className="d-lb">Перекази</span>
                            <b><CountUp value={stats.transfers} /></b>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                  <div className="d-stats">
                    {statCards.map((c, i) => (
                      <section key={c.key} className="d-card d-stat d-rise" style={vars({ '--i': i + 1 })}>
                        <span className={`d-chip ${c.tone}`}><c.icon size={20} /></span>
                        <div>
                          <span className="d-lb">{c.label}</span>
                          <b><CountUp value={c.value} signed={c.signed} /></b>
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Right: where the money went + how each category stands against its plan. */}
            {hasTwo && (
              <div className={`dash-two${showDonut && showPlan ? ' both' : ''}`}>
                {showDonut && (
                  <section className={`d-card d-pane${loading ? '' : ' d-rise'}`} style={vars({ '--i': 5 })}>
                    <div className="d-ch"><h2>Витрати за категоріями</h2></div>
                    {loading || !stats ? (
                      <>
                        <span className="skel" style={{ width: '100%', maxWidth: 244, aspectRatio: '1', margin: '6px auto 0', borderRadius: '50%' }} />
                        <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {[0, 1, 2, 3].map(i => <span key={i} className="skel" style={{ height: 16 }} />)}
                        </div>
                      </>
                    ) : <ExpenseDonut data={donutData} total={stats.expenses} />}
                  </section>
                )}
                {showPlan && (
                  <section className={`d-card d-pane${loading ? '' : ' d-rise'}`} style={vars({ '--i': 6 })}>
                    <div className="d-ch">
                      <h2>Категорії проти плану</h2>
                      {planRows.length > 0 && <Link href="/planning" aria-label="Відкрити Планування">План →</Link>}
                    </div>
                    {!planReady ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                        {[0, 1, 2, 3].map(i => <span key={i} className="skel" style={{ height: 38 }} />)}
                      </div>
                    ) : period === 'all' ? (
                      <div className="d-empty top"><span className="d-chip or"><Target size={20} /></span><span>План рахується по місяцях — оберіть місяць, квартал, півріччя або рік.</span></div>
                    ) : planState.rows === 'error' ? (
                      <div className="d-empty top"><span className="d-chip rd"><AlertCircle size={20} /></span><span>Не вдалося завантажити план.</span></div>
                    ) : planRows.length === 0 ? (
                      <div className="d-empty top"><span className="d-chip or"><Target size={20} /></span><b>На цей період плану ще немає</b><span>Задай суми на сторінці Планування — тут з&apos;явиться, скільки лишилось по кожній категорії.</span><Link href="/planning" className="d-link">Задати план</Link></div>
                    ) : (
                      <>
                        {period !== 'month' && <p className="d-note" style={{ marginBottom: 12 }}>План за період — сума по місяцях.</p>}
                        <div className="d-plan">
                          {planRows.slice(0, PLAN_ROWS_MAX).map((r, i) => {
                            const left = r.planned - r.fact;
                            const over = r.fact - r.planned >= 0.5;
                            const near = !over && r.fact / r.planned >= 0.9;
                            const planX = over ? (r.planned / r.fact) * 100 : 100;
                            return (
                              <div key={r.id} className="d-plan-row">
                                <div className="d-ct">
                                  <span><i className="d-cdot" style={{ background: r.color }} />{r.name}</span>
                                  <span><b>{formatMoney(r.fact)}</b> / {formatMoney(r.planned)}</span>
                                </div>
                                <div className="d-trkw">
                                  {/* Honest scale: the track spans max(fact, plan); past the plan tick the bar is red. */}
                                  <div className="d-trk">
                                    {over ? (
                                      <>
                                        <div className="d-fill sq" style={vars({ '--p': planX, '--i': i, background: 'var(--c-bar)' })} />
                                        <div className="d-fill ov" style={vars({ '--l': planX, '--p': 100 - planX, '--i': i + 5, background: 'var(--chip-rd-fg)' })} />
                                      </>
                                    ) : (
                                      <div className="d-fill" style={vars({ '--p': (r.fact / r.planned) * 100, '--i': i, background: near ? 'var(--chip-am-fg)' : 'var(--c-bar)' })} />
                                    )}
                                  </div>
                                  {over && <i className="d-tick" style={{ left: `${planX}%` }} aria-hidden="true" />}
                                </div>
                                <div className={`d-rm${over ? ' ov' : near ? ' am' : ''}`}>
                                  {over ? `+${formatMoney(-left)} понад план` : `залишилось ${formatMoney(Math.max(0, left))}${near ? ' · майже ліміт' : ''}`}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {planRows.length > PLAN_ROWS_MAX && (
                          <Link href="/planning" className="d-link" style={{ marginTop: 10, alignSelf: 'flex-start' }}>
                            Ще {planRows.length - PLAN_ROWS_MAX} у Плануванні
                          </Link>
                        )}
                      </>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>

          {/* Recent transactions — 3 rows, unfolds in place to the latest 20 of the period. */}
          {sections.recent && (
            <section className={`d-card d-tx${loading ? '' : ' d-rise'}`} style={vars({ '--i': 7 })}>
              <div className="d-ch">
                <h2>Останні транзакції</h2>
                <Link href="/transactions">Усі транзакції</Link>
              </div>
              {loading || !stats ? <TxSkeleton /> : stats.recent.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--c-text-sub)', padding: '32px 0', fontSize: 14 }}>
                  Немає транзакцій за цей період
                </div>
              ) : (
                <RecentList rows={stats.recent} onEdit={tx => { setEditing(tx); setShowForm(true); }} />
              )}

              {/* All-time per-user last entry — deliberately NOT scoped to the
                  period filter: the point is "did someone forget to log
                  something recently", which a period-filtered answer would
                  silently hide if it's been longer than the current view. */}
              {!loading && stats && stats.lastByUser.length > 0 && (
                <div className="d-lastby">
                  <b>Останнє додавання:</b>
                  {stats.lastByUser.map(u => (
                    <span key={u.userId}>
                      {u.name} — {u.date ? new Date(u.date).toLocaleDateString('uk-UA', { timeZone: 'UTC' }) : 'ще немає транзакцій'}
                    </span>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Pending Monobank holds — not counted anywhere, purely informational.
              Sits below everything that matters and loads async, so it can never
              shift the stats above it. */}
          {pending.length > 0 && (
            <section className="d-card d-pend d-rise" style={vars({ '--i': 7 })} aria-label="Очікують підтвердження">
              <div className="d-ch" style={{ marginBottom: 6 }}>
                <h2><span className="d-dot" aria-hidden="true" />Очікують підтвердження<span className="d-count">{pending.length}</span></h2>
              </div>
              <p className="d-note">Банк ще не підтвердив ці покупки — не входять у підсумки, з&apos;являться автоматично після підтвердження.</p>
              <ul className="d-pend-list">
                {pending.map(p => {
                  const [code, name] = splitCode(p.description || 'Без опису');
                  return (
                    <li key={p.id} className="d-pend-row">
                      <span className="d-chip am"><Clock size={17} /></span>
                      <div className="d-tx-main">
                        <b title={p.description}>{code && <span className="code">{code}</span>}{name}</b>
                      </div>
                      <span className="d-hold">
                        <span className="d-amt">&minus;{formatMoney(p.amount)}</span>
                        <small>очікує</small>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* Хто скільки — per-user breakdown, collapsible */}
          {showByUser && stats && (
            <section className="d-card">
              <button className="d-user-toggle" onClick={() => setUserSectionOpen(v => !v)} aria-expanded={userSectionOpen}>
                <h2>Хто скільки</h2>
                {userSectionOpen ? <ChevronUp size={18} color="var(--c-text-muted)" /> : <ChevronDown size={18} color="var(--c-text-muted)" />}
              </button>
              {userSectionOpen && (
                <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                  {stats.byUser.map((u, i) => {
                    const uColor = u.name === 'Спільні' ? 'var(--c-text-muted)' : USER_COLORS[i % USER_COLORS.length];
                    // Absolute values: a net savings withdrawal is negative and would push the bar past 100%.
                    const flow = Math.abs(u.income) + Math.abs(u.expenses) + Math.abs(u.savings);
                    const incPct = flow > 0 ? (Math.abs(u.income)   / flow) * 100 : 0;
                    const expPct = flow > 0 ? (Math.abs(u.expenses) / flow) * 100 : 0;
                    const savPct = flow > 0 ? (Math.abs(u.savings)  / flow) * 100 : 0;
                    return (
                      <div key={u.name} style={{ borderRadius: 18, padding: 16, background: 'var(--c-raised)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                            background: `color-mix(in srgb, ${uColor} 18%, transparent)`, color: uColor,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 13, fontWeight: 800,
                          }}>{u.name.charAt(0)}</div>
                          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)' }}>{u.name}</span>
                          <span style={{
                            marginLeft: 'auto', fontSize: 13, fontWeight: 700,
                            color: u.net >= 0 ? 'var(--c-pos-text)' : 'var(--c-neg-text)',
                          }}>{formatMoneySign(u.net)}</span>
                        </div>
                        <div style={{ display: 'flex', height: 6, borderRadius: 4, overflow: 'hidden', marginBottom: 12, background: 'var(--c-border-mid)' }}>
                          <div style={{ width: `${incPct}%`, background: 'var(--chip-gr-fg)' }} />
                          <div style={{ width: `${expPct}%`, background: 'var(--chip-rd-fg)' }} />
                          <div style={{ width: `${savPct}%`, background: 'var(--chip-am-fg)' }} />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {[
                            { label: 'Дохід',      val: u.income,   c: 'var(--c-pos-text)' },
                            { label: 'Витрати',    val: u.expenses, c: 'var(--c-neg-text)' },
                            { label: 'Збереження', val: u.savings,  c: 'var(--c-warn-text)' },
                          ].filter(r => r.val !== 0).map(r => (
                            <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                              <span style={{ color: 'var(--c-text-muted)' }}>{r.label}</span>
                              <span style={{ color: r.c, fontWeight: 600 }}>{r.val < 0 ? formatMoneySign(r.val) : formatMoney(r.val)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Income / expenses trend (part of the "Графіки" preference with the donut). */}
          {sections.charts && (
            <section className="d-card">
              <div className="d-ch" style={{ marginBottom: 18 }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <LineChart size={18} color="var(--c-accent-hi)" />Дохід та витрати
                </h2>
              </div>
              {stats ? <BalanceTrend data={stats.trend} /> : <span className="skel" style={{ height: 220 }} />}
            </section>
          )}
        </>
      )}

      {showForm && (
        <TransactionForm
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={loadStats}
          editId={editing?.id}
          source={editing?.source}
          initial={editing ? {
            date: editing.date.slice(0, 10),
            type: editing.category.type,
            categoryId: String(editing.category.id),
            amount: String(editing.amount),
            details: editing.details,
            userId: editing.user ? String(editing.user.id) : '',
            savingsWithdrawal: editing.savingsWithdrawal,
            isTransfer: editing.isTransfer,
          } : undefined}
        />
      )}

    </div>
  );
}
