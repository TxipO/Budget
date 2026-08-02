'use client';
import { useEffect, useState, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { MONTH_SHORT, TYPE_LABELS } from '@/lib/utils';
import { toast } from '@/lib/toast';

interface Category { id: number; name: string; type: string; color: string }
interface Plan { categoryId: number; month: number; plannedAmount: number; notes: string }
interface Actual { categoryId: number; month: number; actual: number }

export default function PlanningPage() {
  const [year,     setYear]     = useState(2026);
  const [cats,     setCats]     = useState<Category[]>([]);
  const [plans,    setPlans]    = useState<Plan[]>([]);
  const [actuals,  setActuals]  = useState<Actual[]>([]);
  const [editCell, setEditCell] = useState<{ catId: number; month: number } | null>(null);
  const [editVal,  setEditVal]  = useState('');
  const [editNote, setEditNote] = useState('');
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/categories')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setCats)
      .catch(() => toast('Помилка завантаження категорій', 'error'));
  }, []);

  useEffect(() => {
    if (!cats.length) return;
    fetch(`/api/plans?year=${year}`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data: any[]) =>
        setPlans(data.map(p => ({
          categoryId:    p.categoryId,
          month:         p.month,
          plannedAmount: p.plannedAmount,
          notes:         p.notes ?? '',
        })))
      )
      .catch(() => toast('Помилка завантаження планів', 'error'));

    fetch(`/api/transactions?year=${year}&limit=9999`)
      .then(r => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((txs: { date: string; amount: number; category: { id: number; type: string } }[]) => {
        const map: Record<string, number> = {};
        txs.forEach(tx => {
          const m   = new Date(tx.date).getMonth() + 1;
          const key = `${tx.category.id}-${m}`;
          map[key]  = (map[key] || 0) + tx.amount;
        });
        setActuals(Object.entries(map).map(([key, actual]) => {
          const [catId, month] = key.split('-').map(Number);
          return { categoryId: catId, month, actual };
        }));
      })
      .catch(() => toast('Помилка завантаження транзакцій', 'error'));
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

  async function savePlan(catId: number, month: number, val: number, notes: string) {
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, categoryId: catId, plannedAmount: val, notes }),
    });
    if (!res.ok) throw new Error(await res.text());
    setPlans(prev => {
      const idx = prev.findIndex(p => p.categoryId === catId && p.month === month);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = { ...copy[idx], plannedAmount: val, notes };
        return copy;
      }
      return [...prev, { categoryId: catId, month, plannedAmount: val, notes }];
    });
    toast('План збережено');
  }

  function startEdit(catId: number, month: number) {
    setEditCell({ catId, month });
    setEditVal(String(getPlanned(catId, month) || ''));
    setEditNote(getNotes(catId, month));
    setTimeout(() => amountRef.current?.focus(), 30);
  }

  async function commitEdit() {
    if (!editCell) return;
    try {
      await savePlan(editCell.catId, editCell.month, parseFloat(editVal) || 0, editNote);
      setEditCell(null);
    } catch {
      toast('Помилка збереження плану', 'error');
    }
  }

  const sections = [
    { type: 'income',  label: 'Дохід' },
    { type: 'expense', label: 'Витрати' },
    { type: 'savings', label: 'Збереження' },
  ];

  const headerStyle: React.CSSProperties = {
    fontSize: 11, fontWeight: 700, color: '#475569',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    textAlign: 'center', padding: '0 4px',
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Планування</h1>
          <p style={{ color: '#475569', fontSize: 14 }}>Клікніть на клітинку, щоб задати план та коментар</p>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[2025, 2026, 2027, 2028].map(y => (
            <button
              key={y} onClick={() => setYear(y)} className="btn-ghost"
              style={{
                background: year === y ? 'rgba(249,115,22,0.2)' : undefined,
                color:      year === y ? '#FB923C' : undefined,
                fontWeight: year === y ? 700 : 500,
              }}
            >{y}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
              <th style={{
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
              const sectionCats = cats.filter(c => c.type === type);
              if (!sectionCats.length) return null;

              const sectionTotalByMonth = MONTH_SHORT.map((_, i) => {
                const m       = i + 1;
                const planned = sectionCats.reduce((s, c) => s + getPlanned(c.id, m), 0);
                const actual  = sectionCats.reduce((s, c) => s + getActual(c.id, m), 0);
                return { planned, actual };
              });
              const yearTotalPlanned = sectionTotalByMonth.reduce((s, m) => s + m.planned, 0);
              const yearTotalActual  = sectionTotalByMonth.reduce((s, m) => s + m.actual, 0);
              const typeColor = type === 'income' ? '#22C55E' : type === 'expense' ? '#EF4444' : '#F59E0B';

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
                  return (
                    <tr key={cat.id} className="table-row">
                      <td style={{
                        padding: '10px 20px',
                        position: 'sticky', left: 0, zIndex: 1, background: 'var(--c-elevated)',
                        boxShadow: '1px 0 0 var(--c-border)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 7, height: 7, borderRadius: '50%', background: cat.color }} />
                          <span style={{ fontSize: 13, color: 'var(--c-text-sec)', fontWeight: 500 }}>{cat.name}</span>
                        </div>
                      </td>
                      {MONTH_SHORT.map((_, i) => {
                        const m       = i + 1;
                        const planned = getPlanned(cat.id, m);
                        const actual  = getActual(cat.id, m);
                        const notes   = getNotes(cat.id, m);
                        const isEdit  = editCell?.catId === cat.id && editCell?.month === m;
                        const hasData = actual > 0 || planned > 0;
                        const over    = type !== 'income' && actual > planned && planned > 0;
                        const under   = type !== 'income' && actual > 0 && actual <= planned;

                        return (
                          <td key={m} style={{ padding: '4px', textAlign: 'center', position: 'relative' }}>
                            {isEdit ? (
                              <div style={{
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
                                  placeholder="Сума (kr)"
                                  style={{
                                    width: '100%', background: '#0A0A0F', border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: 6, padding: '5px 8px', color: 'var(--c-text)',
                                    fontSize: 13, outline: 'none', fontFamily: 'inherit',
                                  }}
                                />
                                <input
                                  type="text" value={editNote}
                                  onChange={e => setEditNote(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditCell(null); }}
                                  placeholder="Коментар…"
                                  style={{
                                    width: '100%', background: '#0A0A0F', border: '1px solid rgba(255,255,255,0.1)',
                                    borderRadius: 6, padding: '5px 8px', color: '#94A3B8',
                                    fontSize: 12, outline: 'none', fontFamily: 'inherit',
                                  }}
                                />
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <button
                                    onClick={commitEdit}
                                    style={{
                                      flex: 1, padding: '5px 0', borderRadius: 6, border: 'none',
                                      background: '#F97316', color: 'white', fontSize: 12, fontWeight: 600,
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
                              {actual > 0 && (
                                <span style={{
                                  fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                                  color: over ? '#FCA5A5' : under ? '#4ADE80' : 'var(--c-text-sec)',
                                }}>
                                  {Math.round(actual / 1000)}к
                                </span>
                              )}
                              {planned > 0 && (
                                <span style={{ fontSize: 10, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
                                  /{Math.round(planned / 1000)}к
                                </span>
                              )}
                              {!hasData && (
                                <span style={{ fontSize: 10, color: '#2D3748' }}>—</span>
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
                        <div style={{ fontSize: 12, fontWeight: 700, color: typeColor, fontVariantNumeric: 'tabular-nums' }}>
                          {yearActual > 0 ? Math.round(yearActual / 1000) + 'к' : '—'}
                        </div>
                        {yearPlanned > 0 && (
                          <div style={{ fontSize: 10, color: '#475569', fontVariantNumeric: 'tabular-nums' }}>
                            /{Math.round(yearPlanned / 1000)}к
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                }),
                <tr key={`tot-${type}`} style={{ background: 'var(--c-hover)', borderTop: '1px solid var(--c-border)' }}>
                  <td style={{
                    padding: '10px 20px', fontSize: 13, fontWeight: 700, color: 'var(--c-text-muted)',
                    position: 'sticky', left: 0, zIndex: 1, background: 'var(--c-hover)',
                    boxShadow: '1px 0 0 var(--c-border)',
                  }}>
                    Сума {label.toLowerCase()}
                  </td>
                  {sectionTotalByMonth.map((tot, i) => (
                    <td key={i} style={{ padding: '10px 4px', textAlign: 'center' }}>
                      {tot.actual > 0 ? (
                        <span style={{ fontSize: 12, fontWeight: 700, color: typeColor, fontVariantNumeric: 'tabular-nums' }}>
                          {Math.round(tot.actual / 1000)}к
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: '#2D3748' }}>—</span>
                      )}
                    </td>
                  ))}
                  <td style={{ padding: '10px 8px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: typeColor, fontVariantNumeric: 'tabular-nums' }}>
                    {/* "к" shorthand, not formatMoney — every other cell in
                        this column (including each category row above) uses
                        the same abbreviated format; the full currency string
                        here was the one inconsistent cell in the table. */}
                    {yearTotalActual > 0 ? Math.round(yearTotalActual / 1000) + 'к' : '—'}
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: '#475569' }}>
        Жирне = факт, сіре = план · Зелений = в межах · Червоний = перевитрата ·
        <MessageSquare size={10} color="#F97316" style={{ verticalAlign: 'middle', margin: '0 3px' }} />
        = є коментар (наведіть курсор)
      </div>
    </div>
  );
}
