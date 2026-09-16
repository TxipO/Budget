'use client';
import { useEffect, useState, useRef } from 'react';
import { Plus, Search, Trash2, Pencil, ChevronLeft, ChevronRight, Download, Globe, AlertTriangle, Landmark } from 'lucide-react';
import { MONTH_NAMES, TYPE_LABELS, BANK_SYNC_COLOR } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
import TransactionForm from '@/components/TransactionForm';
import CategoryIcon from '@/components/CategoryIcon';
import { toast } from '@/lib/toast';
import { downloadExport } from '@/lib/downloadExport';

interface Tx {
  id: number; date: string; amount: number; details: string; source: string;
  possibleDuplicateOf: number | null;
  savingsWithdrawal: boolean;
  isTransfer: boolean;
  category: { id: number; name: string; type: string; color: string; icon: string };
  user: { id: number; name: string } | null;
}

const PAGE_SIZE = 25;

export default function TransactionsPage() {
  const { formatMoney, formatMoneySign } = useCurrency();
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
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
  const [showExport, setShowExport] = useState(false);
  const [page, setPage] = useState(1);
  const exportRef = useRef<HTMLDivElement>(null);
  const pendingDels = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  function load() {
    const url = globalSearch
      ? `/api/transactions?limit=100000${typeFilter ? `&type=${typeFilter}` : ''}`
      : `/api/transactions?year=${year}&month=${month}${typeFilter ? `&type=${typeFilter}` : ''}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(setTxs)
      .catch(() => toast('Помилка завантаження транзакцій', 'error'));
  }

  useEffect(() => { load(); }, [year, month, typeFilter, globalSearch]);

  useEffect(() => {
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => {});
  }, []);

  useEffect(() => { setPage(1); }, [year, month, typeFilter, userFilter, showBank, showManual, search, globalSearch]);

  // Cleanup pending delete timers on unmount
  useEffect(() => {
    return () => {
      pendingDels.current.forEach(tid => clearTimeout(tid));
      pendingDels.current.clear();
    };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setShowExport(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

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
    const header = ['Дата', 'Категорія', 'Тип', 'Сума (kr)', 'Деталі', 'Хто'];
    const rows = filtered.map(tx => [
      new Date(tx.date).toLocaleDateString('uk-UA'),
      tx.category.name,
      TYPE_LABELS[tx.category.type],
      String(tx.amount),
      tx.details,
      tx.user?.name ?? '',
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
    setShowExport(false);
    toast('CSV збережено');
  }

  async function exportExcel() {
    await downloadExport(`?year=${year}&month=${month}`);
    setShowExport(false);
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
    return matchesFilters(tx) && !tx.isTransfer && tx.category.type !== 'transfer';
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Matches the server's isBudgetRelevant() + savingsAmount() exactly (see
  // lib/validate.ts) — a transfer/pre-accounted-elsewhere row must never
  // count here either, or these tiles would disagree with the dashboard's
  // numbers for the same period. Not imported from lib/validate.ts directly:
  // that module also imports next/server (route-handler-only APIs), not
  // something a 'use client' bundle should pull in. `filtered` already
  // excludes isTransfer rows, but keeping this explicit guards against that
  // upstream filter ever changing without this total being re-checked.
  const totals = filtered.filter(tx => !tx.isTransfer).reduce(
    (acc, tx) => {
      if (tx.category.type === 'income')   acc.income   += tx.amount;
      if (tx.category.type === 'expense')  acc.expenses += tx.amount;
      if (tx.category.type === 'savings')  acc.savings  += tx.savingsWithdrawal ? -tx.amount : tx.amount;
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

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Транзакції</h1>
          <p style={{ color: '#475569', fontSize: 14 }}>{filtered.length} записів</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 2,
            background: 'var(--c-elevated)', border: '1px solid var(--c-border)',
            borderRadius: 12, padding: '4px',
            opacity: globalSearch ? 0.35 : 1,
            pointerEvents: globalSearch ? 'none' : 'auto',
          }}>
            <button onClick={prevMonth} className="btn-ghost" style={{ padding: '6px 8px', border: 'none', borderRadius: 8 }}>
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)', padding: '0 8px', minWidth: 120, textAlign: 'center' }}>
              {globalSearch ? 'Всі роки' : `${MONTH_NAMES[month - 1]} ${year}`}
            </span>
            <button onClick={nextMonth} className="btn-ghost" style={{ padding: '6px 8px', border: 'none', borderRadius: 8 }}>
              <ChevronRight size={16} />
            </button>
          </div>
          <div ref={exportRef} style={{ position: 'relative' }}>
            <button
              className="btn-ghost"
              onClick={() => setShowExport(v => !v)}
              style={{ gap: 6 }}
            >
              <Download size={15} /> <span className="hide-on-xs">Експорт</span>
            </button>
            {showExport && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50,
                background: 'var(--c-raised)', border: '1px solid var(--c-border-hi)',
                borderRadius: 10, overflow: 'hidden', minWidth: 130,
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
              }}>
                <button onClick={exportCSV} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 16px', background: 'none', border: 'none',
                  color: 'var(--c-text)', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
                  transition: 'background 0.1s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  CSV
                </button>
                <button onClick={exportExcel} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', padding: '10px 16px', background: 'none', border: 'none',
                  color: 'var(--c-text)', fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
                  borderTop: '1px solid var(--c-border)',
                  transition: 'background 0.1s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  Excel (.xlsx)
                </button>
              </div>
            )}
          </div>
          <button
            className="btn-primary"
            onClick={() => { setEditing(null); setShowForm(true); }}
            title="Alt+N"
          >
            <Plus size={16} /> Додати
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 280 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
          <input
            className="input-field"
            style={{ paddingLeft: 36 }}
            placeholder="Пошук по назві, деталям або сумі…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => setGlobalSearch(v => !v)}
          className="btn-ghost"
          title="Шукати по всіх роках, а не тільки в обраному місяці"
          style={{
            background: globalSearch ? 'rgba(249,115,22,0.2)' : undefined,
            color: globalSearch ? '#FB923C' : undefined,
            borderColor: globalSearch ? 'rgba(249,115,22,0.3)' : undefined,
            fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <Globe size={14} /> Всі роки
        </button>
        <div style={{ display: 'flex', gap: 6 }}>
          {[['', 'Всі'], ['income', 'Дохід'], ['expense', 'Витрати'], ['savings', 'Збереження']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setTypeFilter(val)}
              className="btn-ghost"
              style={{
                background: typeFilter === val ? 'rgba(249,115,22,0.2)' : undefined,
                color: typeFilter === val ? '#FB923C' : undefined,
                borderColor: typeFilter === val ? 'rgba(249,115,22,0.3)' : undefined,
                fontSize: 13,
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {users.length > 0 && (
          <>
            {/* Separates the type filter's "Всі" from this group's own
                "Всі" — two identical labels sitting flush against each
                other read as one ambiguous control without it. */}
            <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--c-border-mid)' }} />
            <div style={{ display: 'flex', gap: 6 }}>
            {[['', 'Всі'], ...users.map(u => [String(u.id), u.name])].map(([val, label]) => (
              <button
                key={val}
                onClick={() => setUserFilter(val)}
                className="btn-ghost"
                style={{
                  background: userFilter === val ? 'rgba(249,115,22,0.2)' : undefined,
                  color: userFilter === val ? '#FB923C' : undefined,
                  borderColor: userFilter === val ? 'rgba(249,115,22,0.3)' : undefined,
                  fontSize: 13,
                }}
              >
                {label}
              </button>
            ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 4px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-sec)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showBank} onChange={e => setShowBank(e.target.checked)} />
            Банк
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--c-text-sec)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showManual} onChange={e => setShowManual(e.target.checked)} />
            Вручну
          </label>
        </div>
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Дохід', value: totals.income, color: '#4ADE80', signed: false },
          { label: 'Витрати', value: totals.expenses, color: '#FCA5A5', signed: false },
          // Unlike income/expenses/transfers (always a sum of same-signed
          // rows by construction, never negative), savings can genuinely
          // net negative -- more withdrawals than deposits in the period.
          // formatMoney() alone drops the sign (Math.abs under the hood),
          // which used to show a real net WITHDRAWAL as a plain positive
          // number, reading as a deposit. Found live 2026-09-07.
          { label: 'Збереження', value: totals.savings, color: '#FCD34D', signed: true },
          { label: 'Перекази', value: transfersTotal, color: '#94A3B8', signed: false },
        ].map(s => (
          <div key={s.label} className="card" style={{ flex: '1 1 100px', padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#64748B' }}>{s.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>
              {s.signed ? formatMoneySign(s.value) : formatMoney(s.value)}
            </span>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {/* Table header (desktop only — mobile rows are self-describing cards) */}
        <div className="hide-on-xs" style={{
          display: 'grid', gridTemplateColumns: '100px 1fr 120px 90px 80px 72px', gap: 8,
          padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          <span>Дата</span>
          <span>Категорія / деталі</span>
          <span>Тип</span>
          <span style={{ textAlign: 'right' }}>Сума</span>
          <span>Хто</span>
          <span></span>
        </div>

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: '#475569', padding: '48px 0', fontSize: 14 }}>
            Немає транзакцій
          </div>
        )}

        {paged.map(tx => {
          const dateStr = new Date(tx.date).toLocaleDateString('uk-UA', globalSearch
            ? { day: '2-digit', month: '2-digit', year: '2-digit' }
            : { day: '2-digit', month: '2-digit' });
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
          const isSavingsDeposit = tx.category.type === 'savings' && !tx.savingsWithdrawal;
          const amountStr = `${tx.category.type === 'income' || isSavingsDeposit ? '+' : '-'}${formatMoney(tx.amount)}`;
          // isTransfer rows never reach here — filtered out above — so no
          // dimmed "excluded" color branch is needed.
          const amountColor = tx.category.type === 'income' ? '#4ADE80'
                             : tx.category.type === 'expense' ? '#FCA5A5' : '#FCD34D';
          return (
          <div key={tx.id} className="table-row">
            {/* Desktop: fixed-column grid */}
            <div
              className="tx-row-desktop"
              style={{
                display: 'grid',
                gridTemplateColumns: '100px 1fr 120px 90px 80px 72px',
                padding: '14px 20px',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, color: '#64748B' }}>{dateStr}</span>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <CategoryIcon name={tx.category.icon} color={tx.category.color} size={15} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
                    {tx.category.name}
                    {tx.possibleDuplicateOf && <span title="Можливий дубль — вже є імпортована транзакція в цій категорії за цей місяць" style={{ display: 'flex' }}><AlertTriangle size={11} color="#FBBF24" /></span>}
                    {(tx.source === 'mono' || tx.source === 'sparebank') && <span title={`Автоматично підтягнуто з ${tx.source === 'mono' ? 'Monobank' : 'SpareBank 1'}`} style={{ display: 'flex' }}><Landmark size={11} color={BANK_SYNC_COLOR} /></span>}
                  </div>
                  {tx.details && (
                    <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {tx.details}
                    </div>
                  )}
                </div>
              </div>

              {/* justifySelf: start — .badge is inline-flex so it's meant
                  to hug its content, but as a direct CSS Grid child it
                  otherwise stretches to fill the full 120px column
                  (Grid's justify-items: stretch default). */}
              <span className={`badge badge-${tx.category.type}`} style={{ justifySelf: 'start' }}>
                {TYPE_LABELS[tx.category.type]}
              </span>

              <span style={{ textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: amountColor }}>
                {amountStr}
              </span>

              <span style={{ fontSize: 12, color: '#475569' }}>{tx.user?.name || '—'}</span>

              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 7px', border: 'none' }}
                  onClick={() => { setEditing(tx); setShowForm(true); }}
                  title="Редагувати"
                  aria-label="Редагувати"
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="btn-ghost"
                  style={{ padding: '5px 7px', border: 'none', color: '#EF4444' }}
                  onClick={() => del(tx.id)}
                  title="Видалити"
                  aria-label="Видалити"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* Mobile: stacked card row — icon, category+meta (grows/truncates), amount+actions */}
            <div className="tx-row-mobile" style={{ display: 'none', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
              <CategoryIcon name={tx.category.icon} color={tx.category.color} size={16} tile />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {tx.category.name}
                  {tx.possibleDuplicateOf && <span title="Можливий дубль — вже є імпортована транзакція в цій категорії за цей місяць" style={{ display: 'flex', flexShrink: 0 }}><AlertTriangle size={10} color="#FBBF24" /></span>}
                  {(tx.source === 'mono' || tx.source === 'sparebank') && <span title={`Автоматично підтягнуто з ${tx.source === 'mono' ? 'Monobank' : 'SpareBank 1'}`} style={{ display: 'flex', flexShrink: 0 }}><Landmark size={10} color={BANK_SYNC_COLOR} /></span>}
                </div>
                <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {dateStr}{tx.details && ` · ${tx.details}`}{tx.user && ` · ${tx.user.name}`}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: amountColor }}>
                  {amountStr}
                </span>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button
                    className="btn-ghost"
                    style={{ padding: '9px', border: 'none' }}
                    onClick={() => { setEditing(tx); setShowForm(true); }}
                    title="Редагувати"
                    aria-label="Редагувати"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    className="btn-ghost"
                    style={{ padding: '9px', border: 'none', color: '#EF4444' }}
                    onClick={() => del(tx.id)}
                    title="Видалити"
                    aria-label="Видалити"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          </div>
          );
        })}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
            padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.06)',
          }}>
            <button
              className="btn-ghost"
              style={{ padding: '5px 8px', border: 'none', opacity: page === 1 ? 0.3 : 1 }}
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <span style={{ fontSize: 13, color: 'var(--c-text-sec)', minWidth: 60, textAlign: 'center' }}>
              {page} / {totalPages}
            </span>
            <button
              className="btn-ghost"
              style={{ padding: '5px 8px', border: 'none', opacity: page === totalPages ? 0.3 : 1 }}
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>

      {showForm && (
        <TransactionForm
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={load}
          editId={editing?.id}
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
