'use client';
import { useEffect, useState, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { MONTH_SHORT, TYPE_LABELS } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useCurrency } from '@/lib/useCurrency';
import { formatCompact } from '@/lib/currencies';
import { isBudgetRelevant, savingsAmount } from '@/lib/budgetRules';

interface Category { id: number; name: string; type: string; color: string; isActive: boolean }
interface Plan { categoryId: number; month: number; plannedAmount: number; notes: string }
interface Actual { categoryId: number; month: number; actual: number }

// Is this figure keeping up with its plan? Exact amounts, not the rounded
// "2,5к" shown — a small real overspend must still read as over. Expenses are
// a ceiling (over = bad); income and savings are a target (reached = good, short
// = bad, but only once the period is over — a half-finished month is not "short").
function planStatus(type: string, actual: number, planned: number, periodDone: boolean): 'good' | 'bad' | null {
  if (planned <= 0) return null;
  if (type === 'expense') return actual > planned ? 'bad' : actual > 0 ? 'good' : null;
  if (actual >= planned) return 'good';
  return periodDone && actual !== 0 ? 'bad' : null;
}
const STATUS_COLOR = { good: 'var(--c-pos-text)', bad: 'var(--c-neg-text)' } as const;

export default function PlanningPage() {
  const { suffix } = useCurrency();
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  const thisMonth = now.getUTCMonth() + 1;
  const [year,     setYear]     = useState(thisYear);
  const [cats,     setCats]     = useState<Category[]>([]);
  // Plans and actuals land together and are tagged with their year: the table
  // always shows ONE consistent year, even if a slower response arrives late.
  const [grid,     setGrid]     = useState<{ year: number; plans: Plan[]; actuals: Actual[] }>({ year: thisYear, plans: [], actuals: [] });
  const { plans, actuals } = grid;
  const gridYear = grid.year;
  const gridSeq = useRef(0);
  const [editCell, setEditCell] = useState<{ catId: number; month: number; year: number } | null>(null);
  const [editVal,  setEditVal]  = useState('');
  const [editNote, setEditNote] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // includeInactive: a deleted category keeps its transactions, which stats still count.
    fetch('/api/categories?includeInactive=1')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((all: Category[]) => setCats(all))
      .catch(() => toast('Помилка завантаження категорій', 'error'));
  }, []);

  useEffect(() => {
    if (!cats.length) return;
    const seq = ++gridSeq.current;
    Promise.all([
      fetch(`/api/plans?year=${year}`).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
      fetch(`/api/transactions?year=${year}`).then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); }),
    ])
      .then(([planRows, txs]: [any[], { date: string; amount: number; isTransfer: boolean; poolCorrection: boolean; savingsWithdrawal: boolean; category: { id: number; type: string } }[]]) => {
        if (seq !== gridSeq.current) return;
        const map: Record<string, number> = {};
        txs.forEach(tx => {
          // Found live 2026-09-18: counting isTransfer rows inflated "факт" vs plan.
          if (!isBudgetRelevant(tx)) return;
          const signedAmount = tx.category.type === 'savings' ? savingsAmount(tx) : tx.amount;
          // getUTCMonth, not getMonth — tx.date is a UTC-midnight-truncated
          // date string from the API (matches this app's own convention, see
          // e.g. verify-data-integrity.mjs's timezone-residue check). Reading
          // it with local-timezone getMonth() is only safe by accident for a
          // browser whose local time is ahead of UTC (Norway/Ukraine both
          // are) — a browser set to a UTC-negative zone would roll a date-1
          // transaction back to the previous month here, silently misfiling
          // it in the planning grid. Found during /fullreview 2026-08-19.
          const m   = new Date(tx.date).getUTCMonth() + 1;
          const key = `${tx.category.id}-${m}`;
          map[key]  = (map[key] || 0) + signedAmount;
        });
        setGrid({
          year,
          plans: planRows.map(p => ({
            categoryId:    p.categoryId,
            month:         p.month,
            plannedAmount: p.plannedAmount,
            notes:         p.notes ?? '',
          })),
          actuals: Object.entries(map).map(([key, actual]) => {
            const [catId, month] = key.split('-').map(Number);
            return { categoryId: catId, month, actual };
          }),
        });
      })
      .catch(() => {
        if (seq !== gridSeq.current) return;
        setGrid({ year, plans: [], actuals: [] }); // not another year's numbers under this heading
        toast('Помилка завантаження планів і транзакцій', 'error');
      });
  }, [year, cats]);

  function getPlanned(catId: number, month: number) {
    return plans.find(p => p.categoryId === catId && p.month === month)?.plannedAmount || 0;
  }
  function getActual(catId: number, month: number) {
    return actuals.find(a => a.categoryId === catId && a.month === month)?.actual || 0;
  }
  function getNotes(catId: number, month: number) {
    return plans.find(p => p.categoryId === catId && p.month === month)?.notes || '';
  }

  // `y` is the year the edited cell belonged to, never whatever year is selected now.
  async function savePlan(y: number, catId: number, month: number, val: number, notes: string) {
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: y, month, categoryId: catId, plannedAmount: val, notes }),
    });
    if (!res.ok) throw new Error(await res.text());
    setGrid(g => {
      if (g.year !== y) return g; // the table has moved on to another year
      const idx = g.plans.findIndex(p => p.categoryId === catId && p.month === month);
      if (idx >= 0) {
        const copy = [...g.plans];
        copy[idx] = { ...copy[idx], plannedAmount: val, notes };
        return { ...g, plans: copy };
      }
      return { ...g, plans: [...g.plans, { categoryId: catId, month, plannedAmount: val, notes }] };
    });
    toast('План збережено');
  }

  function startEdit(catId: number, month: number) {
    setEditCell({ catId, month, year: gridYear });
    setEditVal(String(getPlanned(catId, month) || ''));
    setEditNote(getNotes(catId, month));
    setTimeout(() => amountRef.current?.focus(), 30);
  }

  async function commitEdit() {
    if (!editCell) return;
    try {
      await savePlan(editCell.year, editCell.catId, editCell.month, parseFloat(editVal) || 0, editNote);
      setEditCell(null);
    } catch {
      toast('Помилка збереження плану', 'error');
    }
  }

  const monthDone = (m: number) => gridYear < thisYear || (gridYear === thisYear && m < thisMonth);
  const yearDone  = gridYear < thisYear;

  const sections = [
    { type: 'income',  label: 'Дохід' },
    { type: 'expense', label: 'Витрати' },
    { type: 'savings', label: 'Збереження' },
  ];

  const headerStyle: React.CSSProperties = {
    fontSize: 12, fontWeight: 700, color: 'var(--c-text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    textAlign: 'center', padding: '0 4px',
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Планування</h1>
          <p style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Клікніть на клітинку, щоб задати план та коментар</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map(y => (
            <button
              key={y} onClick={() => { setYear(y); setEditCell(null); }} className="btn-ghost"
              style={{
                background: year === y ? 'rgba(249,115,22,0.2)' : undefined,
                color:      year === y ? 'var(--c-accent-hi)' : undefined,
                fontWeight: year === y ? 700 : 500,
              }}
            >{y}</button>
          ))}
        </div>
      </div>

      <div className="card h-scroll-hint" style={{ overflow: 'auto' }}>
        <table className="plan-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
              <th className="plan-cat-col" style={{
                ...headerStyle, textAlign: 'left', padding: '14px 20px', width: 180,
                position: 'sticky', left: 0, zIndex: 2, background: 'var(--c-elevated)',
                boxShadow: '1px 0 0 var(--c-border)',
              }}>Категорія</th>
              {MONTH_SHORT.map((m, i) => (
                <th key={i} style={{ ...headerStyle, width: 72 }}>{m}</th>
              ))}
              <th style={{ ...headerStyle, width: 90 }}>Рік</th>
            </tr>
          </thead>
          <tbody>
            {sections.map(({ type, label }) => {
              // Inactive (deleted) categories only appear where they still hold this year's numbers.
              const sectionCats = cats.filter(c => c.type === type
                && (c.isActive || actuals.some(a => a.categoryId === c.id && a.actual !== 0)));
              if (!sectionCats.length) return null;

              const sectionTotalByMonth = MONTH_SHORT.map((_, i) => {
                const m       = i + 1;
                const planned = sectionCats.reduce((s, c) => s + getPlanned(c.id, m), 0);
                const actual  = sectionCats.reduce((s, c) => s + getActual(c.id, m), 0);
                return { planned, actual };
              });
              const yearTotalPlanned = sectionTotalByMonth.reduce((s, m) => s + m.planned, 0);
              const yearTotalActual  = sectionTotalByMonth.reduce((s, m) => s + m.actual, 0);
              const yearTotalStatus  = planStatus(type, yearTotalActual, yearTotalPlanned, yearDone);
              const typeColor = type === 'income' ? 'var(--c-income-num)' : type === 'expense' ? 'var(--c-expense-num)' : 'var(--c-savings-num)';

              return [
                <tr key={`sec-${type}`} style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <td colSpan={14} style={{ padding: '8px 20px' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: typeColor, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {label}
                    </span>
                  </td>
                </tr>,
                ...sectionCats.map(cat => {
                  const yearActual  = MONTH_SHORT.reduce((s, _, i) => s + getActual(cat.id,  i + 1), 0);
                  const yearPlanned = MONTH_SHORT.reduce((s, _, i) => s + getPlanned(cat.id, i + 1), 0);
                  const yearStatus  = planStatus(type, yearActual, yearPlanned, yearDone);
                  return (
                    <tr key={cat.id} className="table-row">
                      <td className="plan-cat-col" style={{
                        padding: '10px 20px',
                        position: 'sticky', left: 0, zIndex: 1, background: 'var(--c-elevated)',
                        boxShadow: '1px 0 0 var(--c-border)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <div style={{ width: 7, height: 7, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
                          <span className="plan-cat-name" title={cat.isActive ? cat.name : `${cat.name} — категорію видалено, але її транзакції ще враховуються`} style={{ fontSize: 13, color: 'var(--c-text-sec)', fontStyle: cat.isActive ? undefined : 'italic', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat.name}</span>
                        </div>
                      </td>
                      {MONTH_SHORT.map((_, i) => {
                        const m       = i + 1;
                        const planned = getPlanned(cat.id, m);
                        const actual  = getActual(cat.id, m);
                        const notes   = getNotes(cat.id, m);
                        const isEdit  = editCell?.year === gridYear && editCell?.catId === cat.id && editCell?.month === m;
                        const hasData = actual !== 0 || planned > 0;
                        const status = planStatus(type, actual, planned, monthDone(m));

                        return (
                          <td key={m} style={{ padding: '4px', textAlign: 'center', position: 'relative' }}>
                            {isEdit ? (
                              <div className="plan-edit-popover" style={{
                                position: 'absolute', zIndex: 20, top: 0, left: '50%', transform: 'translateX(-50%)',
                                background: 'var(--c-elevated)', border: '1px solid #F97316', borderRadius: 10,
                                padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180,
                                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                              }}>
                                <input
                                  ref={amountRef}
                                  type="number" value={editVal}
                                  onChange={e => setEditVal(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditCell(null); }}
                                  placeholder={`Сума (${suffix})`}
                                  className="input-field" style={{ padding: '6px 10px' }}
                                />
                                <input
                                  type="text" value={editNote}
                                  onChange={e => setEditNote(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditCell(null); }}
                                  placeholder="Коментар…"
                                  className="input-field" style={{ padding: '6px 10px' }}
                                />
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button
                                    onClick={commitEdit}
                                    style={{
                                      flex: 1, padding: '5px 0', borderRadius: 6, border: 'none',
                                      background: 'var(--c-accent-fill)', color: 'white', fontSize: 12, fontWeight: 600,
                                      cursor: 'pointer', fontFamily: 'inherit',
                                    }}
                                  >Зберегти</button>
                                  <button
                                    onClick={() => setEditCell(null)}
                                    style={{
                                      padding: '5px 10px', borderRadius: 6,
                                      border: '1px solid rgba(255,255,255,0.1)',
                                      background: 'transparent', color: '#64748B', fontSize: 12,
                                      cursor: 'pointer', fontFamily: 'inherit',
                                    }}
                                  >✕</button>
                                </div>
                              </div>
                            ) : null}

                            <div
                              onClick={() => startEdit(cat.id, m)}
                              title={notes || undefined}
                              style={{
                                cursor: 'pointer', borderRadius: 6, padding: '4px 2px',
                                minHeight: 36, display: 'flex', flexDirection: 'column',
                                justifyContent: 'center', alignItems: 'center', gap: 1,
                                transition: 'background 0.1s', position: 'relative',
                              }}
                              onMouseEnter={e => (e.currentTarget.style.background = 'var(--c-hover)')}
                              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                            >
                              {actual !== 0 && (
                                <span style={{
                                  fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                  color: status ? STATUS_COLOR[status] : 'var(--c-text-sec)',
                                }}>
                                  {formatCompact(actual)}
                                </span>
                              )}
                              {planned > 0 && (
                                <span style={{ fontSize: 12, color: 'var(--c-text-sub)', fontVariantNumeric: 'tabular-nums' }}>
                                  /{formatCompact(planned)}
                                </span>
                              )}
                              {!hasData && (
                                <span style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>—</span>
                              )}
                              {notes && (
                                <MessageSquare
                                  size={8} color="#F97316"
                                  style={{ position: 'absolute', top: 2, right: 2 }}
                                />
                              )}
                            </div>
                          </td>
                        );
                      })}
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: yearStatus ? STATUS_COLOR[yearStatus] : typeColor, fontVariantNumeric: 'tabular-nums' }}>
                          {yearActual !== 0 ? formatCompact(yearActual) : '—'}
                        </div>
                        {yearPlanned > 0 && (
                          <div style={{ fontSize: 12, color: 'var(--c-text-sub)', fontVariantNumeric: 'tabular-nums' }}>
                            /{formatCompact(yearPlanned)}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                }),
                <tr key={`tot-${type}`} style={{ background: 'var(--c-hover)', borderTop: '1px solid var(--c-border)' }}>
                  <td className="plan-cat-col" style={{
                    padding: '10px 20px', fontSize: 13, fontWeight: 700, color: 'var(--c-text-muted)',
                    // Opaque: --c-hover is translucent, so figures scrolling
                    // under this sticky cell showed through it. Tint layered
                    // over the solid surface instead.
                    position: 'sticky', left: 0, zIndex: 1,
                    backgroundColor: 'var(--c-elevated)',
                    backgroundImage: 'linear-gradient(var(--c-hover), var(--c-hover))',
                    boxShadow: '1px 0 0 var(--c-border)',
                  }}>
                    <span title={`Сума ${label.toLowerCase()}`}>Сума {label.toLowerCase()}</span>
                  </td>
                  {sectionTotalByMonth.map((tot, i) => {
                    const st = planStatus(type, tot.actual, tot.planned, monthDone(i + 1));
                    return (
                      <td key={i} style={{ padding: '10px 4px', textAlign: 'center' }}>
                        {tot.actual !== 0 ? (
                          <div style={{ fontSize: 12, fontWeight: 700, color: st ? STATUS_COLOR[st] : typeColor, fontVariantNumeric: 'tabular-nums' }}>
                            {formatCompact(tot.actual)}
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>—</div>
                        )}
                        {tot.planned > 0 && (
                          <div style={{ fontSize: 12, color: 'var(--c-text-sub)', fontVariantNumeric: 'tabular-nums' }}>
                            /{formatCompact(tot.planned)}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: yearTotalStatus ? STATUS_COLOR[yearTotalStatus] : typeColor, fontVariantNumeric: 'tabular-nums' }}>
                      {/* "к" shorthand, not formatMoney — same abbreviated format as every other cell. */}
                      {yearTotalActual !== 0 ? formatCompact(yearTotalActual) : '—'}
                    </div>
                    {yearTotalPlanned > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--c-text-sub)', fontVariantNumeric: 'tabular-nums' }}>
                        /{formatCompact(yearTotalPlanned)}
                      </div>
                    )}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--c-text-muted)' }}>
        Жирне = факт, сіре = план · Зелений = в межах · Червоний = перевитрата ·
        <MessageSquare size={10} color="#F97316" style={{ verticalAlign: 'middle', margin: '0 3px' }} />
        = є коментар (наведіть курсор)
      </div>
    </div>
  );
}
