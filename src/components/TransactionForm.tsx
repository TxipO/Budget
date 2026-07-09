'use client';
import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { TYPE_LABELS } from '@/lib/utils';
import { toast } from '@/lib/toast';

interface Category { id: number; name: string; type: string; color: string }
interface User { id: number; name: string }

interface Props {
  onClose: () => void;
  onSaved: () => void;
  initial?: Partial<TxForm>;
  editId?: number;
}

interface TxForm {
  date: string;
  type: string;
  categoryId: string;
  amount: string;
  details: string;
  userId: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function TransactionForm({ onClose, onSaved, initial, editId }: Props) {
  const [form, setForm] = useState<TxForm>({
    date: today(), type: 'expense', categoryId: '', amount: '',
    details: '', userId: '', ...initial,
  });
  const [cats, setCats] = useState<Category[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/categories').then(r => r.ok ? r.json() : Promise.reject()).then(setCats).catch(() => toast('Помилка завантаження категорій', 'error'));
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => toast('Помилка завантаження користувачів', 'error'));
  }, []);

  useEffect(() => {
    if (initial?.userId) return; // keep original user when editing
    const currentUser = localStorage.getItem('currentUser');
    if (currentUser && users.length) {
      const u = users.find(u => u.name === currentUser);
      if (u) setForm(f => ({ ...f, userId: String(u.id) }));
    }
  }, [users, initial?.userId]);

  const filteredCats = cats.filter(c => c.type === form.type);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const url    = editId ? `/api/transactions/${editId}` : '/api/transactions';
      const method = editId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!res.ok) throw new Error(await res.text());
      toast(editId ? 'Транзакцію оновлено' : 'Транзакцію додано');
      onSaved();
      onClose();
    } catch (e) {
      console.error(e);
      toast('Помилка збереження транзакції', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="card-elevated"
        style={{ width: '100%', maxWidth: 460, padding: 28 }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>
            {editId ? 'Редагувати' : 'Нова транзакція'}
          </h2>
          <button onClick={onClose} className="btn-ghost" style={{ padding: '6px 8px' }}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Date */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Дата
            </label>
            <input
              type="date" className="input-field"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
              required
            />
          </div>

          {/* Type */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Тип
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['income', 'expense', 'savings'] as const).map(t => (
                <button
                  key={t} type="button"
                  onClick={() => setForm(f => ({ ...f, type: t, categoryId: '' }))}
                  style={{
                    flex: 1, padding: '8px 4px', borderRadius: 8, border: 'none',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                    background: form.type === t
                      ? t === 'income'  ? 'rgba(34,197,94,0.2)'
                      : t === 'expense' ? 'rgba(239,68,68,0.2)'
                      : 'rgba(245,158,11,0.2)'
                      : 'rgba(255,255,255,0.04)',
                    color: form.type === t
                      ? t === 'income'  ? '#4ADE80'
                      : t === 'expense' ? '#FCA5A5'
                      : '#FCD34D'
                      : '#64748B',
                    transition: 'all 0.15s',
                  }}
                >
                  {TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Category */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Категорія
            </label>
            <select
              className="input-field"
              value={form.categoryId}
              onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
              required
            >
              <option value="">Оберіть категорію…</option>
              {filteredCats.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Amount */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Сума (kr)
            </label>
            <input
              type="number" className="input-field" placeholder="0"
              value={form.amount} min={0} step="0.01"
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              required
            />
          </div>

          {/* Details */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Коментар
            </label>
            <input
              type="text" className="input-field" placeholder="Наприклад: Starlink 364, телефони 460…"
              value={form.details}
              onChange={e => setForm(f => ({ ...f, details: e.target.value }))}
            />
          </div>

          {/* User */}
          {users.length > 0 && (
            <div>
              <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Хто вносить
              </label>
              <select
                className="input-field"
                value={form.userId}
                onChange={e => setForm(f => ({ ...f, userId: e.target.value }))}
              >
                <option value="">— не вказано —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}

          <button type="submit" className="btn-primary" disabled={saving} style={{ marginTop: 8, justifyContent: 'center' }}>
            <Save size={15} />
            {saving ? 'Збереження…' : 'Зберегти'}
          </button>
        </form>
      </div>
    </div>
  );
}
