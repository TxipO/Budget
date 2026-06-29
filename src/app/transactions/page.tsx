'use client';
import { useEffect, useState, useRef } from 'react';
import { Plus, Search, Trash2, Pencil, ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { formatMoney, MONTH_NAMES, TYPE_LABELS } from '@/lib/utils';
import TransactionForm from '@/components/TransactionForm';
import { toast } from '@/lib/toast';

interface Tx {
  id: number; date: string; amount: number; details: string;
  recurringTemplateId: number | null;
  category: { id: number; name: string; type: string; color: string };
  user: { name: string } | null;
}

const PAGE_SIZE = 25;

export default function TransactionsPage() {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [txs, setTxs] = useState<Tx[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Tx | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [page, setPage] = useState(1);
  const exportRef = useRef<HTMLDivElement>(null);
  const pendingDels = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  function load() {
    fetch(`/api/transactions?year=${year}&month=${month}${typeFilter ? `&type=${typeFilter}` : ''}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then(setTxs)
      .catch(() => toast('Помилка завантаження транзакцій', 'error'));
  }

  useEffect(() => { load(); }, [year, month, typeFilter]);

  useEffect(() => { setPage(1); }, [year, month, typeFilter, search]);

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
    if (!tx) return;

    setTxs(prev => prev.filter(t => t.id !== id));

    const timeoutId = setTimeout(async () => {
      pendingDels.current.delete(id);
      const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast('Помилка видалення', 'error');
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
    a.download = `бюджет_${MONTH_NAMES[month - 1]}_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setShowExport(false);
    toast('CSV збережено');
  }

  async function exportExcel() {
    const url = `/api/export?year=${year}&month=${month}`;
    const res = await fetch(url);
    if (!res.ok) { toast('Помилка експорту'); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Ведення_${MONTH_NAMES[month - 1]}_${year}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
    setShowExport(false);
    toast('Excel збережено');
  }

  const filtered = txs.filter(tx =>
    !search ||
    tx.category.name.toLowerCase().includes(search.toLowerCase()) ||
    (tx.details ?? '').toLowerCase().includes(search.toLowerCase()) ||
    String(tx.amount).includes(search.replace(/\s/g, ''))
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const totals = filtered.reduce(
    (acc, tx) => {
      if (tx.category.type === 'income')   acc.income   += tx.amount;
      if (tx.category.type === 'expense')  acc.expenses += tx.amount;
      if (tx.category.type === 'savings')  acc.savings  += tx.amount;
      return acc;
    },
    { income: 0, expenses: 0, savings: 0 }
  );

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Транзакції</h1>
          <p style={{ color: '#475569', fontSize: 14 }}>{filtered.length} записів</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 2,
            background: 'var(--c-elevated)', border: '1px solid var(--c-border)',
            borderRadius: 12, padding: '4px',
          }}>
            <button onClick={prevMonth} className="btn-ghost" style={{ padding: '6px 8px', border: 'none', borderRadius: 8 }}>
              <ChevronLeft size={16} />
            </button>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)', padding: '0 8px', minWidth: 120, textAlign: 'center' }}>
              {MONTH_NAMES[month - 1]} {year}
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
              <Download size={15} /> Експорт
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
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
          <input
            className="input-field"
            style={{ paddingLeft: 36 }}
            placeholder="Пошук по назві, деталям або сумі…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
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
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Дохід', value: totals.income, color: '#4ADE80' },
          { label: 'Витрати', value: totals.expenses, color: '#FCA5A5' },
          { label: 'Збереження', value: totals.savings, color: '#FCD34D' },
        ].map(s => (
          <div key={s.label} className="card" style={{ flex: 1, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: '#64748B' }}>{s.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: s.color, fontVariantNumeric: 'tabular-nums' }}>
              {formatMoney(s.value)}
            </span>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="card" style={{ overflow: 'hidden' }}>
        {/* Table header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '100px 1fr 120px 90px 80px 72px',
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

        {paged.map(tx => (
          <div
            key={tx.id}
            className="table-row"
            style={{
              display: 'grid',
              gridTemplateColumns: '100px 1fr 120px 90px 80px 72px',
              padding: '14px 20px',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 13, color: '#64748B' }}>
              {new Date(tx.date).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })}
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: tx.category.color, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {tx.category.name}
                  {tx.recurringTemplateId && <RefreshCw size={11} color="#F97316" title="Recurring" />}
                </div>
                {tx.details && (
                  <div style={{ fontSize: 12, color: '#475569', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {tx.details}
                  </div>
                )}
              </div>
            </div>

            <span className={`badge badge-${tx.category.type}`}>
              {TYPE_LABELS[tx.category.type]}
            </span>

            <span style={{
              textAlign: 'right', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
              color: tx.category.type === 'income' ? '#4ADE80'
                   : tx.category.type === 'expense' ? '#FCA5A5' : '#FCD34D',
            }}>
              {tx.category.type === 'income' ? '+' : '-'}{formatMoney(tx.amount)}
            </span>

            <span style={{ fontSize: 12, color: '#475569' }}>{tx.user?.name || '—'}</span>

            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              <button
                className="btn-ghost"
                style={{ padding: '5px 7px', border: 'none' }}
                onClick={() => { setEditing(tx); setShowForm(true); }}
              >
                <Pencil size={13} />
              </button>
              <button
                className="btn-ghost"
                style={{ padding: '5px 7px', border: 'none', color: '#EF4444' }}
                onClick={() => del(tx.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}

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
          } : undefined}
        />
      )}
    </div>
  );
}
