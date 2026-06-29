'use client';
import { useEffect, useState } from 'react';
import { X, RefreshCw, Plus } from 'lucide-react';
import { formatMoney } from '@/lib/utils';
import { toast } from '@/lib/toast';

interface Template {
  id: number; name: string; amount: number; details: string; applied: boolean;
  transactionId: number | null;
  category: { name: string; color: string; type: string };
  user: { name: string };
}

interface Props {
  year: number; month: number;
  onClose: () => void;
  onApplied: () => void;
}

const emptyForm = { name: '', amount: '', categoryId: '', userId: '' };

export default function RecurringModal({ year, month, onClose, onApplied }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [toUnapply, setToUnapply] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState(emptyForm);
  const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadTemplates();
    fetch('/api/categories').then(r => r.json()).then(setCats);
    fetch('/api/users').then(r => r.json()).then(setUsers);
  }, [year, month]);

  function loadTemplates() {
    setLoading(true);
    fetch(`/api/recurring?year=${year}&month=${month}`)
      .then(r => r.json())
      .then((data: Template[]) => {
        setTemplates(data);
        setSelected(new Set(data.filter(t => !t.applied).map(t => t.id)));
        setToUnapply(new Set());
        setLoading(false);
      });
  }

  function toggle(id: number) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleUnapply(transactionId: number) {
    setToUnapply(prev => {
      const next = new Set(prev);
      next.has(transactionId) ? next.delete(transactionId) : next.add(transactionId);
      return next;
    });
  }

  async function addTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.name || !addForm.amount || !addForm.categoryId || !addForm.userId) return;
    setAdding(true);
    try {
      const res = await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addForm.name,
          amount: Number(addForm.amount),
          categoryId: Number(addForm.categoryId),
          userId: Number(addForm.userId),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast(`Шаблон "${addForm.name}" додано`);
      setAddForm(emptyForm);
      setShowAddForm(false);
      loadTemplates();
    } catch {
      toast('Помилка додавання шаблону', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function apply() {
    const hasApply = selected.size > 0;
    const hasUnapply = toUnapply.size > 0;
    if (!hasApply && !hasUnapply) return;
    setApplying(true);
    try {
      if (hasUnapply) {
        const results = await Promise.all([...toUnapply].map(txId =>
          fetch(`/api/transactions/${txId}`, { method: 'DELETE' })
        ));
        if (results.some(r => !r.ok)) throw new Error('delete failed');
      }

      let applied = 0, skipped = 0;
      if (hasApply) {
        const res = await fetch('/api/recurring/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year, month, templateIds: [...selected] }),
        });
        if (!res.ok) throw new Error(await res.text());
        ({ applied, skipped } = await res.json());
      }

      const parts: string[] = [];
      if (applied > 0)        parts.push(`Додано ${applied}`);
      if (toUnapply.size > 0) parts.push(`Видалено ${toUnapply.size}`);
      if (skipped > 0)        parts.push(`${skipped} вже є`);
      toast(parts.join(', '));
      onApplied();
      onClose();
    } catch {
      toast('Помилка застосування шаблонів', 'error');
    } finally {
      setApplying(false);
    }
  }

  const pending = templates.filter(t => !t.applied);
  const done    = templates.filter(t => t.applied);
  const hasChanges = selected.size > 0 || toUnapply.size > 0;

  function buttonLabel() {
    if (applying) return 'Збереження…';
    if (selected.size > 0 && toUnapply.size > 0) return 'Зберегти зміни';
    if (toUnapply.size > 0) return `Скасувати (${toUnapply.size})`;
    return `Застосувати (${selected.size})`;
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
        borderRadius: 16, width: '100%', maxWidth: 500,
        maxHeight: '85vh', display: 'flex', flexDirection: 'column',
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 16px', borderBottom: '1px solid var(--c-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <RefreshCw size={18} color="#F97316" />
            <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--c-text)' }}>Шаблони на цей місяць</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setShowAddForm(v => !v)}
              className="btn-ghost"
              style={{ padding: '5px 10px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5,
                background: showAddForm ? 'rgba(249,115,22,0.15)' : undefined,
                color: showAddForm ? '#FB923C' : undefined,
              }}
            >
              <Plus size={14} /> Додати
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--c-text-muted)', padding: 4 }}>
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Add form */}
        {showAddForm && (
          <form onSubmit={addTemplate} style={{
            padding: '16px 24px', borderBottom: '1px solid var(--c-border)',
            background: 'rgba(249,115,22,0.05)',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Назва</label>
                <input className="input-field" value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} required placeholder="Напр. Оренда" style={{ fontSize: 13 }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Сума</label>
                <input className="input-field" type="number" value={addForm.amount} onChange={e => setAddForm(f => ({ ...f, amount: e.target.value }))} required placeholder="0" min="0" style={{ fontSize: 13 }} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Категорія</label>
                <select className="input-field" value={addForm.categoryId} onChange={e => setAddForm(f => ({ ...f, categoryId: e.target.value }))} required style={{ fontSize: 13 }}>
                  <option value="">Вибрати…</option>
                  {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Хто</label>
                <select className="input-field" value={addForm.userId} onChange={e => setAddForm(f => ({ ...f, userId: e.target.value }))} required style={{ fontSize: 13 }}>
                  <option value="">Вибрати…</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setShowAddForm(false); setAddForm(emptyForm); }} className="btn-ghost" style={{ padding: '6px 14px', fontSize: 13 }}>Скасувати</button>
              <button type="submit" disabled={adding} className="btn-primary" style={{ padding: '6px 14px', fontSize: 13 }}>
                <Plus size={13} /> {adding ? 'Збереження…' : 'Зберегти'}
              </button>
            </div>
          </form>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {loading && <p style={{ color: 'var(--c-text-muted)', fontSize: 14 }}>Завантаження…</p>}

          {!loading && templates.length === 0 && (
            <p style={{ color: 'var(--c-text-muted)', fontSize: 14, textAlign: 'center', padding: '32px 0' }}>
              Шаблонів ще немає.<br />Натисни "+ Додати" вгорі.
            </p>
          )}

          {!loading && pending.length > 0 && (
            <>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Не застосовано ({pending.length})
              </p>
              {pending.map(t => (
                <label key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
                  borderBottom: '1px solid var(--c-border)', cursor: 'pointer',
                }}>
                  <input
                    type="checkbox" checked={selected.has(t.id)}
                    onChange={() => toggle(t.id)}
                    style={{ width: 16, height: 16, accentColor: '#F97316', cursor: 'pointer' }}
                  />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: t.category.color, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, color: 'var(--c-text)', fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{t.category.name} · {t.user.name}</div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: t.category.type === 'income' ? '#4ADE80' : 'var(--c-text)' }}>
                    {formatMoney(t.amount)}
                  </span>
                </label>
              ))}
            </>
          )}

          {!loading && done.length > 0 && (
            <div style={{ marginTop: pending.length > 0 ? 20 : 0 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Вже застосовано ({done.length})
              </p>
              {done.map(t => (
                <label key={t.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
                  borderBottom: '1px solid var(--c-border)', cursor: 'pointer',
                  opacity: toUnapply.has(t.transactionId!) ? 0.45 : 1,
                  transition: 'opacity 0.15s',
                }}>
                  <input
                    type="checkbox"
                    checked={!toUnapply.has(t.transactionId!)}
                    onChange={() => t.transactionId && toggleUnapply(t.transactionId)}
                    style={{ width: 16, height: 16, accentColor: '#F97316', cursor: 'pointer' }}
                  />
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: t.category.color, flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 14, color: 'var(--c-text)', fontWeight: 600,
                      textDecoration: toUnapply.has(t.transactionId!) ? 'line-through' : 'none',
                    }}>
                      {t.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{t.category.name} · {t.user.name}</div>
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text-muted)' }}>{formatMoney(t.amount)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && templates.length > 0 && (
          <div style={{ padding: '16px 24px', borderTop: '1px solid var(--c-border)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button onClick={onClose} className="btn-ghost" style={{ padding: '8px 16px' }}>Скасувати</button>
            <button
              onClick={apply} disabled={applying || !hasChanges} className="btn-primary"
              style={{ padding: '8px 20px', opacity: !hasChanges ? 0.5 : 1 }}
            >
              {buttonLabel()}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
