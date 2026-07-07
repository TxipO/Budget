'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, CheckCircle, Sun, Moon, RefreshCw } from 'lucide-react';
import { CATEGORY_PALETTE, formatMoney } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useTheme } from '@/lib/theme';
import { useDashboardPrefs, PREF_LABELS, type DashboardPrefs } from '@/lib/dashboardPrefs';
import { ICON_KEYS } from '@/lib/icons';
import CategoryIcon from '@/components/CategoryIcon';

interface Category { id: number; name: string; type: string; color: string; icon: string; isActive: boolean }
interface RecurringTemplate {
  id: number; name: string; amount: number; details: string;
  category: { name: string; color: string; type: string };
  user: { name: string };
}

export default function SettingsPage() {
  const [cats, setCats] = useState<Category[]>([]);
  const [form, setForm] = useState({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle' });
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [editingColorId, setEditingColorId] = useState<number | null>(null);
  const [editingIconId, setEditingIconId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [tplForm, setTplForm] = useState({ name: '', amount: '', categoryId: '', userId: '' });

  function loadCats() {
    fetch('/api/categories')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setCats)
      .catch(() => toast('Помилка завантаження категорій', 'error'));
  }
  function loadTemplates() {
    fetch('/api/recurring')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(setTemplates)
      .catch(() => toast('Помилка завантаження шаблонів', 'error'));
  }
  useEffect(() => {
    loadCats();
    loadTemplates();
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => {});
  }, []);

  async function addTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!tplForm.name || !tplForm.amount || !tplForm.categoryId || !tplForm.userId) return;
    const res = await fetch('/api/recurring', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tplForm, amount: Number(tplForm.amount), categoryId: Number(tplForm.categoryId), userId: Number(tplForm.userId) }),
    });
    if (!res.ok) { toast('Помилка додавання шаблону', 'error'); return; }
    toast(`Шаблон "${tplForm.name}" додано`);
    setTplForm({ name: '', amount: '', categoryId: '', userId: '' });
    loadTemplates();
  }

  async function deleteTemplate(id: number, name: string) {
    const res = await fetch(`/api/recurring/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast('Помилка видалення шаблону', 'error'); return; }
    toast(`Шаблон "${name}" видалено`, 'info');
    loadTemplates();
  }

  async function addCat(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!res.ok) { toast('Помилка додавання категорії', 'error'); return; }
    toast(`Категорію "${form.name}" додано`);
    setForm({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle' });
    loadCats();
  }

  async function deleteCat(id: number) {
    const cat = cats.find(c => c.id === id);
    if (!confirm('Видалити категорію?')) return;
    const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    if (!res.ok) { toast('Помилка видалення категорії', 'error'); return; }
    toast(`Категорію "${cat?.name}" видалено`, 'info');
    loadCats();
  }

  async function updateColor(id: number, color: string) {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
    if (!res.ok) { toast('Помилка оновлення кольору', 'error'); return; }
    setCats(prev => prev.map(c => c.id === id ? { ...c, color } : c));
    setEditingColorId(null);
    toast('Колір оновлено');
  }

  async function updateIcon(id: number, icon: string) {
    const res = await fetch(`/api/categories/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icon }),
    });
    if (!res.ok) { toast('Помилка оновлення іконки', 'error'); return; }
    setCats(prev => prev.map(c => c.id === id ? { ...c, icon } : c));
    setEditingIconId(null);
    toast('Іконку оновлено');
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus('loading');
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/import', { method: 'POST', body: formData });
    if (res.ok) { setImportStatus('done'); loadCats(); toast('Імпорт завершено успішно'); }
    else { setImportStatus('error'); toast('Помилка імпорту', 'error'); }
  }

  const [theme, toggleTheme] = useTheme();
  const [dashSections, updateSections] = useDashboardPrefs();

  const [pinForm, setPinForm] = useState({ current: '', next: '' });
  const [pinSaving, setPinSaving] = useState(false);

  async function changePin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinForm.current || !pinForm.next || pinSaving) return;
    if (!/^\d{4,8}$/.test(pinForm.next)) { toast('Новий PIN — від 4 до 8 цифр', 'error'); return; }
    setPinSaving(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: pinForm.current, next: pinForm.next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast(data?.error || 'Помилка зміни PIN', 'error');
        return;
      }
      toast('PIN змінено');
      setPinForm({ current: '', next: '' });
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setPinSaving(false);
    }
  }

  const sections = [
    { type: 'income', label: 'Дохід', color: '#22C55E' },
    { type: 'expense', label: 'Витрати', color: '#EF4444' },
    { type: 'savings', label: 'Збереження', color: '#F59E0B' },
  ];

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: 'var(--c-text)', marginBottom: 4 }}>Налаштування</h1>
        <p style={{ color: '#475569', fontSize: 14 }}>Категорії та імпорт даних</p>
      </div>

      {/* Appearance section */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Зовнішній вигляд</h2>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)', marginBottom: 2 }}>
              {theme === 'dark' ? 'Темна тема' : 'Світла тема'}
            </p>
            <p style={{ fontSize: 13, color: 'var(--c-text-muted)' }}>
              {theme === 'dark' ? 'Перемкнути на світлу' : 'Перемкнути на темну'}
            </p>
          </div>
          <button
            onClick={toggleTheme}
            className="btn-ghost"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px' }}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            {theme === 'dark' ? 'Світла' : 'Темна'}
          </button>
        </div>
      </div>

      {/* Dashboard sections visibility */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 4 }}>Головна сторінка</h2>
        <p style={{ fontSize: 13, color: 'var(--c-text-muted)', marginBottom: 16 }}>
          Які блоки показувати на дашборді (зберігається на цьому пристрої)
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(Object.keys(PREF_LABELS) as (keyof DashboardPrefs)[]).map(key => (
            <label key={key} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '9px 0', cursor: 'pointer', borderBottom: '1px solid var(--c-border)',
            }}>
              <span style={{ fontSize: 14, color: 'var(--c-text-sec)' }}>{PREF_LABELS[key]}</span>
              <button
                type="button"
                onClick={() => updateSections({ [key]: !dashSections[key] })}
                style={{
                  width: 40, height: 22, borderRadius: 20, border: 'none', cursor: 'pointer',
                  background: dashSections[key] ? '#F97316' : 'var(--c-border-mid)',
                  position: 'relative', transition: 'background 0.15s', flexShrink: 0,
                }}
                aria-label={`${dashSections[key] ? 'Сховати' : 'Показати'}: ${PREF_LABELS[key]}`}
              >
                <span style={{
                  position: 'absolute', top: 3, left: dashSections[key] ? 21 : 3,
                  width: 16, height: 16, borderRadius: '50%', background: 'white',
                  transition: 'left 0.15s',
                }} />
              </button>
            </label>
          ))}
        </div>
      </div>

      {/* Security section */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Безпека</h2>
        <form onSubmit={changePin} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Поточний PIN</label>
            <input
              className="input-field" type="password" inputMode="numeric" required
              value={pinForm.current}
              onChange={e => setPinForm(f => ({ ...f, current: e.target.value }))}
              placeholder="••••••"
            />
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Новий PIN</label>
            <input
              className="input-field" type="password" inputMode="numeric" required
              value={pinForm.next}
              onChange={e => setPinForm(f => ({ ...f, next: e.target.value }))}
              placeholder="••••••"
            />
          </div>
          <button type="submit" disabled={pinSaving} className="btn-primary" style={{ padding: '10px 18px' }}>
            {pinSaving ? 'Збереження…' : 'Змінити PIN'}
          </button>
        </form>
        <p style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 10 }}>
          Новий PIN діє одразу для наступних входів. Уже виконані входи лишаються активними до 30 днів.
        </p>
      </div>

      {/* Import section */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Імпорт з Excel</h2>
        <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>
          Завантажте файл Budget.xlsx — автоматично імпортуються категорії та дані з листів "Планування" і "Ведення".
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
          <button className="btn-primary" onClick={() => { setImportStatus('idle'); fileRef.current?.value && (fileRef.current.value = ''); fileRef.current?.click(); }} disabled={importStatus === 'loading'}>
            <Upload size={15} />
            {importStatus === 'loading' ? 'Імпорт…' : 'Завантажити файл'}
          </button>
          {importStatus === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#4ADE80', fontSize: 13 }}>
              <CheckCircle size={16} /> Імпортовано успішно
            </div>
          )}
          {importStatus === 'error' && (
            <div style={{ color: '#FCA5A5', fontSize: 13 }}>Помилка імпорту</div>
          )}
        </div>
      </div>

      {/* Recurring templates */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={16} color="#F97316" /> Шаблони (recurring)
        </h2>
        <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>
          Щомісячні транзакції — оренда, комунальні, підписки. Натисни "Шаблони" на головній щоб застосувати їх одним кліком.
        </p>

        <form onSubmit={addTemplate} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 16 }}>
          <div style={{ flex: '1 1 140px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Назва</label>
            <input className="input-field" value={tplForm.name} onChange={e => setTplForm(f => ({ ...f, name: e.target.value }))} required placeholder="Напр. Оренда" />
          </div>
          <div style={{ flex: '0 0 110px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Сума</label>
            <input className="input-field" type="number" value={tplForm.amount} onChange={e => setTplForm(f => ({ ...f, amount: e.target.value }))} required placeholder="0" min="0" />
          </div>
          <div style={{ flex: '1 1 130px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Категорія</label>
            <select className="input-field" value={tplForm.categoryId} onChange={e => setTplForm(f => ({ ...f, categoryId: e.target.value }))} required>
              <option value="">Вибрати…</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 100px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Хто</label>
            <select className="input-field" value={tplForm.userId} onChange={e => setTplForm(f => ({ ...f, userId: e.target.value }))} required>
              <option value="">Вибрати…</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <button type="submit" className="btn-primary"><Plus size={15} /> Додати</button>
        </form>

        {templates.length === 0 && <p style={{ fontSize: 13, color: '#475569' }}>Шаблонів ще немає</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {templates.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: t.category.color, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 14, color: 'var(--c-text-sec)', fontWeight: 600 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: '#475569', marginLeft: 8 }}>{t.category.name} · {t.user.name}</span>
              </div>
              <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--c-text)', marginRight: 8 }}>{formatMoney(t.amount)}</span>
              <button className="btn-ghost" style={{ padding: '4px 6px', border: 'none', color: '#EF4444' }} onClick={() => deleteTemplate(t.id, t.name)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add category */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Додати категорію</h2>
        <form onSubmit={addCat} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Назва
            </label>
            <input className="input-field" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Назва категорії" />
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Тип</label>
            <select className="input-field" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="income">Дохід</option>
              <option value="expense">Витрати</option>
              <option value="savings">Збереження</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Колір</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {CATEGORY_PALETTE.map(c => (
                <button
                  key={c} type="button"
                  onClick={() => setForm(f => ({ ...f, color: c }))}
                  style={{
                    width: 24, height: 24, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                    outline: form.color === c ? '2px solid white' : 'none', outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          </div>
          <button type="submit" className="btn-primary"><Plus size={15} /> Додати</button>
          <div style={{ flexBasis: '100%' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>Іконка</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
              {ICON_KEYS.map(key => (
                <button
                  key={key} type="button"
                  onClick={() => setForm(f => ({ ...f, icon: key }))}
                  title={key}
                  style={{
                    width: 30, height: 30, borderRadius: 8, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: form.icon === key ? `${form.color}22` : 'var(--c-hover)',
                    border: form.icon === key ? `1px solid ${form.color}` : '1px solid transparent',
                  }}
                >
                  <CategoryIcon name={key} color={form.icon === key ? form.color : '#94A3B8'} size={15} />
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>

      {/* Categories list */}
      {sections.map(({ type, label, color }) => {
        const items = cats.filter(c => c.type === type);
        return (
          <div key={type} className="card" style={{ padding: 24, marginBottom: 16 }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color }}>{label}</span>
              <span style={{ fontSize: 12, fontWeight: 500, color: '#475569' }}>({items.length})</span>
            </h2>
            {items.length === 0 && <p style={{ fontSize: 13, color: '#475569' }}>Немає категорій</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map(cat => (
                <div key={cat.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
                    <button
                      title="Змінити іконку"
                      onClick={() => { setEditingIconId(editingIconId === cat.id ? null : cat.id); setEditingColorId(null); }}
                      style={{
                        width: 28, height: 28, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
                        background: `${cat.color}1A`,
                        border: editingIconId === cat.id ? `1px solid ${cat.color}` : '1px solid transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                      }}
                    >
                      <CategoryIcon name={cat.icon} color={cat.color} size={15} />
                    </button>
                    <button
                      title="Змінити колір"
                      onClick={() => { setEditingColorId(editingColorId === cat.id ? null : cat.id); setEditingIconId(null); }}
                      style={{
                        width: 16, height: 16, borderRadius: '50%', background: cat.color,
                        border: editingColorId === cat.id ? '2px solid white' : '2px solid transparent',
                        cursor: 'pointer', flexShrink: 0, padding: 0,
                      }}
                    />
                    <span style={{ flex: 1, fontSize: 14, color: 'var(--c-text-sec)' }}>{cat.name}</span>
                    <button className="btn-ghost" style={{ padding: '4px 6px', border: 'none', color: '#EF4444' }} onClick={() => deleteCat(cat.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {editingIconId === cat.id && (
                    <div style={{ display: 'flex', gap: 6, paddingBottom: 10, paddingLeft: 26, flexWrap: 'wrap', maxHeight: 120, overflowY: 'auto' }}>
                      {ICON_KEYS.map(key => (
                        <button
                          key={key} type="button"
                          onClick={() => updateIcon(cat.id, key)}
                          title={key}
                          style={{
                            width: 28, height: 28, borderRadius: 8, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: cat.icon === key ? `${cat.color}22` : 'var(--c-hover)',
                            border: cat.icon === key ? `1px solid ${cat.color}` : '1px solid transparent',
                          }}
                        >
                          <CategoryIcon name={key} color={cat.icon === key ? cat.color : '#94A3B8'} size={14} />
                        </button>
                      ))}
                    </div>
                  )}
                  {editingColorId === cat.id && (
                    <div style={{ display: 'flex', gap: 6, paddingBottom: 10, paddingLeft: 26, flexWrap: 'wrap' }}>
                      {CATEGORY_PALETTE.map(c => (
                        <button
                          key={c} type="button"
                          onClick={() => updateColor(cat.id, c)}
                          style={{
                            width: 22, height: 22, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                            outline: cat.color === c ? '2px solid white' : 'none', outlineOffset: 2,
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
