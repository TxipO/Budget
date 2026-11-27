'use client';
import { useEffect, useState, useRef, Fragment, type CSSProperties } from 'react';
import { Plus, Search, Trash2, Pencil, ChevronLeft, ChevronRight, Download, Globe, AlertTriangle, Landmark, TrendingUp, TrendingDown, PiggyBank, ArrowLeftRight } from 'lucide-react';
import { MONTH_NAMES, TYPE_LABELS, BANK_SYNC_COLOR } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import TransactionForm from '@/components/TransactionForm';
import CategoryIcon from '@/components/CategoryIcon';
import { displayColor } from '@/lib/displayColor';
import { toast } from '@/lib/toast';
import { isBudgetRelevant, savingsAmount } from '@/lib/budgetRules';

interface Tx {
  id: number; date: string; amount: number; details: string; source: string;
  possibleDuplicateOf: number | null;
  savingsWithdrawal: boolean;
  isTransfer: boolean;
  poolCorrection: boolean;
  category: { id: number; name: string; type: string; color: string; icon: string };
  user: { id: number; name: string } | null;
}

const PAGE_SIZE = 25;

const vars = (o: Record<string, string | number>) => o as CSSProperties;

// Direction shown next to a row's amount; the CSV export uses the same sign.
function amountSign(tx: Tx): 1 | -1 {
  const isSavingsDeposit = tx.category.type === 'savings' && !tx.savingsWithdrawal;
  return tx.category.type === 'income' || isSavingsDeposit ? 1 : -1;
}

export default function TransactionsPage() {
  const { formatMoney, formatMoneySign, currency } = useCurrency();
  // UTC getters: same month boundaries as the server and the planning page.
  const now = new Date();
  const [year,  setYear]  = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [typeFilter, setTypeFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  // Two independent checkboxes, not a single toggle — lets "тільки банк" and
  // "тільки вручну" both be expressed (uncheck the other one), not just
  // "auto-imported or everything". Default both on = no filtering.
  const [showBank, setShowBank] = useState(true);
  const [showManual, setShowManual] = useState(true);
  const [search, setSearch] = useState('');
  const [globalSearch, setGlobalSearch] = useState(false);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);
  const [page, setPage] = useState(1);
  // True until the first response for the current month/filters lands (or fails), so
  // an in-flight fetch never reads as "0 записів" / "Немає транзакцій".
  const [loading, setLoading] = useState(true);
  const pendingDels = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // load() is also called from timers/toasts that outlive a render, so it reads
  // the CURRENT filters via a ref; loadSeq drops responses that arrive out of order.
  const loadSeq = useRef(0);
  const query = useRef({ year, month, typeFilter, globalSearch });
  query.current = { year, month, typeFilter, globalSearch };

  function load() {
    const seq = ++loadSeq.current;
    const { year, month, typeFilter, globalSearch } = query.current;
    const url = globalSearch
      ? `/api/transactions?limit=100000${typeFilter ? `&type=${typeFilter}` : ''}`
      : `/api/transactions?year=${year}&month=${month}${typeFilter ? `&type=${typeFilter}` : ''}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      // Rows whose delete is still inside the undo window stay hidden on reload.
      .then((rows: Tx[]) => { if (seq === loadSeq.current) { setTxs(rows.filter(t => !pendingDels.current.has(t.id))); setLoading(false); } })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setTxs([]); // old rows would sit under the new month's heading
        setLoading(false);
        toast('Помилка завантаження транзакцій', 'error');
      });
  }

  useEffect(() => { setLoading(true); load(); }, [year, month, typeFilter, globalSearch]);

  useEffect(() => {
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => {});
  }, []);

  useEffect(() => { setPage(1); }, [year, month, typeFilter, userFilter, showBank, showManual, search, globalSearch]);

  // Leaving the page (or closing the tab) inside the undo window must not drop
  // a delete the toast already announced: fire it now instead of cancelling it.
  useEffect(() => {
    function flush() {
      pendingDels.current.forEach((tid, id) => {
        clearTimeout(tid);
        fetch(`/api/transactions/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
      });
      pendingDels.current.clear();
    }
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);

  useEffect(() => {
    if (showForm) return; // a form is already open: Alt+N must not turn an edit into a create
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setEditing(null);
        setShowForm(true);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showForm]);

  function del(id: number) {
    const tx = txs.find(t => t.id === id);
    // Guards a double-click/double-tap on the same row: without this, two
    // fast clicks (React batches setTxs, so both see the same pre-update
    // txs) each schedule their own delete timer, and pendingDels.current.set
    // below overwrites the map entry — so "Скасувати" only cancels the
    // second timer while the first still fires and deletes anyway.
    if (!tx || pendingDels.current.has(id)) return;

    setTxs(prev => prev.filter(t => t.id !== id));

    const timeoutId = setTimeout(async () => {
      pendingDels.current.delete(id);
      try {
        const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          toast('Помилка видалення', 'error');
          load();
        }
      } catch {
        toast('Помилка з’єднання', 'error');
        load();
      }
    }, 5000);

    pendingDels.current.set(id, timeoutId);

    toast(
      'Транзакцію видалено',
      'info',
      {
        label: 'Скасувати',
        onClick: () => {
          const tid = pendingDels.current.get(id);
          if (tid !== undefined) {
            clearTimeout(tid);
            pendingDels.current.delete(id);
            load();
          }
        },
      },
      5000,
    );
  }

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  function exportCSV() {
    // Includes rows excluded from totals (hidden in the list) so the file can be reconciled; they're marked.
    const header = ['Дата', 'Категорія', 'Тип', `Сума (${currency})`, 'Деталі', 'Хто', 'Не враховано'];
    // Free text (bank counterparty names) must not open as a spreadsheet formula.
    const safe = (v: string) => /^(\s*[=+\-@]|[\t\r])/.test(v) ? `'${v}` : v;
    const rows = txs.filter(matchesFilters).map(tx => [
      new Date(tx.date).toLocaleDateString('uk-UA', { timeZone: 'UTC' }),
      safe(tx.category.name),
      TYPE_LABELS[tx.category.type],
      String(amountSign(tx) * tx.amount),
      safe(tx.details ?? ''),
      safe(tx.user?.name ?? ''),
      isBudgetRelevant(tx) ? '' : 'так',
    ]);
    const csv = [header, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = globalSearch ? 'бюджет_всі_роки.csv' : `бюджет_${MONTH_NAMES[month - 1]}_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('CSV збережено');
  }

  // Shared by both `filtered` (the visible list) and the transfers total
  // below (which needs the SAME search/user/source scoping, just without the
  // isTransfer/category-type exclusion those two disagree on).
  function matchesFilters(tx: Tx) {
    const matchesSearch = !search ||
      tx.category.name.toLowerCase().includes(search.toLowerCase()) ||
      (tx.details ?? '').toLowerCase().includes(search.toLowerCase()) ||
      String(tx.amount).includes(search.replace(/\s/g, ''));
    const matchesUser = !userFilter || tx.user?.id === Number(userFilter);
    const isBankSourced = tx.source === 'mono' || tx.source === 'sparebank';
    const matchesSource = isBankSourced ? showBank : showManual;
    return matchesSearch && matchesUser && matchesSource;
  }

  const filtered = txs.filter(tx => {
    // isTransfer rows (a self-transfer's redundant mirror leg, or a manually
    // excluded row) are real DB rows but never represent budget activity —
    // showing them next to their counted counterpart just reads as an
    // unexplained duplicate. Excluded from the list entirely, not just from
    // totals; still fully visible via a category edit or a direct DB query
    // if ever needed. Found confusing live 2026-08-14: two rows for one real
    // checking<->pillow transfer, distinguished only by a small icon.
    // category.type 'transfer' excluded too, independent of isTransfer — see
    // lib/validate.ts's isBudgetRelevant for why both checks matter (a
    // learned rule can file a row under "Перекази" before the automatic
    // isTransfer matcher catches up, or in cases it never does).
    // A poolCorrection row is listed (it is real, hand-entered, and the user
    // must be able to find and edit it) but `totals` below still skips it.
    return matchesFilters(tx) && (isBudgetRelevant(tx) || tx.poolCorrection);
  });

  const totalPages = loading ? 0 : Math.ceil(filtered.length / PAGE_SIZE);
  // Clamp: deleting the last row of the last page must not strand `page` past the end.
  const cur = Math.min(page, Math.max(1, totalPages));
  const paged = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  // `filtered` already holds only budget-relevant rows; isBudgetRelevant is kept
  // here as a guard in case that upstream filter ever changes.
  const totals = filtered.filter(isBudgetRelevant).reduce(
    (acc, tx) => {
      if (tx.category.type === 'income')   acc.income   += tx.amount;
      if (tx.category.type === 'expense')  acc.expenses += tx.amount;
      if (tx.category.type === 'savings')  acc.savings  += savingsAmount(tx);
      return acc;
    },
    { income: 0, expenses: 0, savings: 0 }
  );

  // Deliberately from `txs` (not `filtered`, which excludes every 'transfer'
  // row outright) with the same search/user/source scoping — matches
  // stats.ts's `transfers` sum exactly: only the outgoing leg of each
  // matched pair, so a transfer isn't counted twice.
  const transfersTotal = txs
    .filter(tx => matchesFilters(tx) && tx.category.type === 'transfer' && !tx.savingsWithdrawal)
    .reduce((s, tx) => s + tx.amount, 0);

  // Rows grouped by day (the API already returns them newest first); `i` is the
  // row's position on the page and drives the capped entrance animation below.
  const groups: { key: string; label: string; rows: { tx: Tx; i: number }[] }[] = [];
  paged.forEach((tx, i) => {
    const key = tx.date.slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push({ tx, i });
    else groups.push({
      key,
      label: new Date(tx.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', ...(globalSearch ? { year: 'numeric' } : {}), timeZone: 'UTC' }),
      rows: [{ tx, i }],
    });
  });

  const summary = [
    { label: 'Дохід', value: totals.income, tone: 'gr', icon: TrendingUp, signed: false },
    { label: 'Витрати', value: totals.expenses, tone: 'rd', icon: TrendingDown, signed: false },
    // Unlike income/expenses/transfers (always a sum of same-signed
    // rows by construction, never negative), savings can genuinely
    // net negative -- more withdrawals than deposits in the period.
    // formatMoney() alone drops the sign (Math.abs under the hood),
    // which used to show a real net WITHDRAWAL as a plain positive
    // number, reading as a deposit. Found live 2026-09-07.
    { label: 'Збереження', value: totals.savings, tone: 'am', icon: PiggyBank, signed: true },
    { label: 'Перекази', value: transfersTotal, tone: '', icon: ArrowLeftRight, signed: false },
  ];

  return (
    <div className="dash dash-stack">
      {/* Header */}
      <div className="dash-head">
        <div className="dash-title">
          <h1>Транзакції</h1>
          <span className="d-note">
            {loading ? <span className="skel" style={{ height: 14, width: 80 }} /> : `${filtered.length} записів`}
          </span>
        </div>
        <div className="tx-stepper" style={{ opacity: globalSearch ? 0.35 : 1, pointerEvents: globalSearch ? 'none' : 'auto' }}>
          <button onClick={prevMonth} className="d-round" title="Попередній місяць" aria-label="Попередній місяць"><ChevronLeft size={18} /></button>
          <span>{globalSearch ? 'Всі роки' : `${MONTH_NAMES[month - 1]} ${year}`}</span>
          <button onClick={nextMonth} className="d-round" title="Наступний місяць" aria-label="Наступний місяць"><ChevronRight size={18} /></button>
        </div>
        <div className="dash-actions">
          <button className="d-btn" onClick={exportCSV} title="Експорт CSV" aria-label="Експорт CSV">
            <Download size={16} /> <span className="hide-on-xs">CSV</span>
          </button>
          <button className="d-btn pr" onClick={() => { setEditing(null); setShowForm(true); }} title="Alt+N">
            <Plus size={16} /> Додати
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 280 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--c-text-muted)' }} />
          <input
            className="input-field"
            style={{ paddingLeft: 36 }}
            aria-label="Пошук по назві, деталям або сумі"
            placeholder="Пошук по назві, деталям або сумі…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="d-pills">
          <button
            onClick={() => setGlobalSearch(v => !v)}
            aria-pressed={globalSearch}
            title="Шукати по всіх роках, а не тільки в обраному місяці"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Globe size={14} /> Всі роки
          </button>
        </div>
        <div className="d-pills">
          {[['', 'Всі'], ['income', 'Дохід'], ['expense', 'Витрати'], ['savings', 'Збереження']].map(([val, label]) => (
            <button key={val} onClick={() => setTypeFilter(val)} aria-pressed={typeFilter === val}>{label}</button>
          ))}
        </div>
        {users.length > 0 && (
          <div className="d-pills">
            {[['', 'Всі'], ...users.map(u => [String(u.id), u.name])].map(([val, label]) => (
              <button key={val} onClick={() => setUserFilter(val)} aria-pressed={userFilter === val}>{label}</button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 4px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-sec)', cursor: 'pointer', padding: '10px 0' }}>
            <input type="checkbox" checked={showBank} onChange={e => setShowBank(e.target.checked)} />
            Банк
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-sec)', cursor: 'pointer', padding: '10px 0' }}>
            <input type="checkbox" checked={showManual} onChange={e => setShowManual(e.target.checked)} />
            Вручну
          </label>
        </div>
      </div>

      {/* Summary */}
      <div className="d-stats tx-stats">
        {summary.map(s => (
          <section key={s.label} className="d-card d-stat">
            <span className={`d-chip ${s.tone}`}><s.icon size={20} /></span>
            <div>
              <span className="d-lb">{s.label}</span>
              <b>
                {loading ? <span className="skel" style={{ height: 22, width: 72 }} /> : (s.signed ? formatMoneySign(s.value) : formatMoney(s.value))}
              </b>
            </div>
          </section>
        ))}
      </div>

      {/* Transactions, grouped by day */}
      <section className="d-card d-tx">
        {loading && (
          <div className="d-tx-list">
            {[0, 1, 2, 3, 4].map(i => (
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
        )}

        {!loading && filtered.length === 0 && (
          <div className="d-empty">Немає транзакцій</div>
        )}

        {(loading ? [] : groups).map(g => (
          <Fragment key={g.key}>
            <h3 className="tx-day">{g.label}</h3>
            <ul className="d-tx-list">
              {g.rows.map(({ tx, i }) => {
                const type = tx.category.type;
                // A leading long terminal/bank code ("143300 COOP PRIX") is noise in a title: dropped for display only.
                const cleaned = tx.details && tx.details !== '[імпорт]' ? tx.details.replace(/^\d{5,}\s+/, '').trim() : '';
                const label = cleaned || tx.category.name;
                // People-named categories repeat the person ("Паша · Паша"): show a name once.
                const seen = new Set<string>();
                const meta = [cleaned ? tx.category.name : null, tx.user?.name, TYPE_LABELS[type]]
                  .filter((x): x is string => !!x && !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase())).join(' · ');
                // A savings row's sign is the POT's perspective, not the wallet's.
                // The row is labelled with the pot's own category name, and both
                // the "Збереження" tile above and the dashboard's sum it into
                // (savingsAmount() in lib/validate.ts) count a deposit as positive
                // and a withdrawal as negative. This used to be inverted: a
                // withdrawal rendered "+" green while every total counted it as
                // negative, so one real event read as a gain here and a drop
                // there. Found live 2026-08-29 on a 300 kr "Фінансова подушка"
                // withdrawal showing "+300". Savings keeps its own colour in both
                // directions — a pot growing is not income.
                // isTransfer rows never reach here — filtered out above — so no
                // dimmed "excluded" colour branch is needed.
                const amountStr = `${amountSign(tx) > 0 ? '+' : '−'}${formatMoney(tx.amount)}`;
                const bank = tx.source === 'mono' || tx.source === 'sparebank';
                return (
                  // Only the first 20 rows animate in (cheap on phones); reduced motion is handled globally.
                  <li key={tx.id} className={`d-tx-row tx-act${i < 20 ? ' d-rise' : ''}`} style={vars({ '--i': i })}>
                    {/* The whole row is the edit control; delete is a sibling (no nested buttons). */}
                    <button type="button" className="d-tx-hit" onClick={() => { setEditing(tx); setShowForm(true); }} aria-label={`Редагувати: ${label}, ${TYPE_LABELS[type]} ${amountStr}${tx.possibleDuplicateOf ? ', можливий дубль' : ''}`}>
                      <span className="d-chip d-cat-chip" style={vars({ '--cc': displayColor(tx.category.color, tx.category.id, tx.category.name) })}>
                        <CategoryIcon name={tx.category.icon} color="currentColor" size={20} />
                      </span>
                      <span className="d-tx-main">
                        <b>
                          {label}
                          {tx.possibleDuplicateOf && <span title="Можливий дубль — вже є імпортована транзакція в цій категорії за цей місяць" style={{ marginLeft: 6 }}><AlertTriangle size={12} color="var(--c-warn-text)" style={{ display: 'inline', verticalAlign: '-1px' }} /></span>}
                        </b>
                        <small>
                          {bank && <Landmark size={11} color={BANK_SYNC_COLOR} aria-label={`Автоматично підтягнуто з ${tx.source === 'mono' ? 'Monobank' : 'SpareBank 1'}`} style={{ display: 'inline', verticalAlign: '-1px', marginRight: 5 }} />}
                          {meta}
                        </small>
                      </span>
                      <span className={`d-amt ${type === 'income' ? 'inc' : type === 'expense' ? 'exp' : 'sav'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {amountStr}
                      </span>
                      <Pencil size={15} className="d-tx-pen" aria-hidden="true" />
                    </button>
                    <button type="button" className="d-round ghost tx-del" onClick={() => del(tx.id)} title="Видалити" aria-label={`Видалити: ${label}`}>
                      <Trash2 size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Fragment>
        ))}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
            marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--c-line)',
          }}>
            <button
              className="d-round ghost"
              style={{ opacity: cur === 1 ? 0.3 : 1 }}
              disabled={cur === 1}
              onClick={() => setPage(cur - 1)}
              title="Попередня сторінка" aria-label="Попередня сторінка"
            >
              <ChevronLeft size={18} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--c-text-sec)', minWidth: 60, textAlign: 'center' }}>
              {cur} / {totalPages}
            </span>
            <button
              className="d-round ghost"
              style={{ opacity: cur === totalPages ? 0.3 : 1 }}
              disabled={cur === totalPages}
              onClick={() => setPage(cur + 1)}
              title="Наступна сторінка" aria-label="Наступна сторінка"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
      </section>

      {showForm && (
        <TransactionForm
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={load}
          editId={editing?.id}
          source={editing?.source}
          initial={editing ? {
            date: editing.date.slice(0, 10),
            type: editing.category.type,
            categoryId: String(editing.category.id),
            amount: String(editing.amount),
            details: editing.details,
            savingsWithdrawal: editing.savingsWithdrawal,
            isTransfer: editing.isTransfer,
            userId: editing.user ? String(editing.user.id) : '',
          } : undefined}
        />
      )}
    </div>
  );
}
