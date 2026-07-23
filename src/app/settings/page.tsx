'use client';
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload, CheckCircle, Sun, Moon, RefreshCw, Landmark, Pencil, UserPlus } from 'lucide-react';
import { CATEGORY_PALETTE } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
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
  const { formatMoney } = useCurrency();
  const [cats, setCats] = useState<Category[]>([]);
  const [form, setForm] = useState({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle' });
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [editingColorId, setEditingColorId] = useState<number | null>(null);
  const [editingIconId, setEditingIconId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [tplForm, setTplForm] = useState({ name: '', amount: '', categoryId: '', userId: '' });
  const [savingTpl, setSavingTpl] = useState(false);

  const [monoStatus, setMonoStatus] = useState<{ userId: number; name: string; connected: boolean; accountId: string | null }[]>([]);
  const [monoTokenInput, setMonoTokenInput] = useState<Record<number, string>>({});
  const [monoConnecting, setMonoConnecting] = useState<number | null>(null);
  const [monoSyncing, setMonoSyncing] = useState<number | null>(null);

  const [sbStatus, setSbStatus] = useState<{ userId: number; name: string; connected: boolean; iban: string | null; expired: boolean }[]>([]);
  const [sbConnecting, setSbConnecting] = useState<number | null>(null);
  const [sbSyncing, setSbSyncing] = useState<number | null>(null);

  // Which bank is picked in the not-yet-connected dropdown, per user — only
  // relevant before a connection exists; once connected, the row just shows
  // whichever bank actually is connected, no picker needed.
  const [bankChoice, setBankChoice] = useState<Record<number, 'mono' | 'sparebank'>>({});
  // Whether the "add another bank" form is expanded, per user — a user can
  // have BOTH Monobank and SpareBank 1 connected at once (independent DB
  // fields), so connecting one must not hide the option to add the other.
  const [addingBank, setAddingBank] = useState<Record<number, boolean>>({});

  interface AccountInfo { shared: boolean; isPinHousehold: boolean; hasPin: boolean; user?: { id: number; name: string; telegramUsername: string | null; telegramFirstName: string | null; email: string | null } }
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const [newUserName, setNewUserName] = useState('');
  const [addingUser, setAddingUser] = useState(false);
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editUserName, setEditUserName] = useState('');
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/account/me').then(r => r.ok ? r.json() : null).then(setAccount).catch(() => {});
  }, []);

  async function disconnectTelegram() {
    if (unlinking || !confirm('Відключити Telegram? Наступного разу вхід буде за PIN, або треба буде прив’язати Telegram заново.')) return;
    setUnlinking(true);
    try {
      const res = await fetch('/api/account/telegram', { method: 'DELETE' });
      if (!res.ok) { toast('Помилка відключення', 'error'); return; }
      toast('Telegram відключено');
      setAccount(a => a?.user ? { ...a, user: { ...a.user, telegramUsername: null, telegramFirstName: null } } : a);
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setUnlinking(false);
    }
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/account/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      toast('Помилка виходу', 'error');
      setLoggingOut(false);
    }
  }

  function loadMonoStatus() {
    fetch('/api/monobank/status').then(r => r.ok ? r.json() : Promise.reject()).then(setMonoStatus).catch(() => {});
  }

  async function connectMono(userId: number) {
    const token = monoTokenInput[userId]?.trim();
    if (!token || monoConnecting) return;
    setMonoConnecting(userId);
    try {
      const res = await fetch('/api/monobank/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, token }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка підключення', 'error'); return; }
      toast('Monobank підключено');
      setMonoTokenInput(prev => ({ ...prev, [userId]: '' }));
      loadMonoStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setMonoConnecting(null);
    }
  }

  async function syncMono(userId: number) {
    if (monoSyncing) return;
    setMonoSyncing(userId);
    try {
      const res = await fetch('/api/monobank/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка синхронізації', 'error'); return; }
      toast(data.created > 0 ? `Додано транзакцій: ${data.created}` : 'Нових транзакцій немає');
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setMonoSyncing(null);
    }
  }

  async function disconnectMono(userId: number, name: string) {
    if (!confirm(`Відключити Monobank для ${name}?`)) return;
    try {
      const res = await fetch('/api/monobank/disconnect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) { toast('Помилка відключення', 'error'); return; }
      toast('Monobank відключено', 'info');
      loadMonoStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  function loadSbStatus() {
    fetch('/api/sparebank/status').then(r => r.ok ? r.json() : Promise.reject()).then(setSbStatus).catch(() => {});
  }

  // Unlike Monobank's paste-a-token flow, connecting SpareBank 1 redirects
  // the whole browser tab away to the bank's own BankID login — there is no
  // response to await here, the flow completes on the callback route.
  async function connectSb(userId: number) {
    if (sbConnecting) return;
    setSbConnecting(userId);
    try {
      const res = await fetch('/api/sparebank/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.url) { toast(data?.error || 'Помилка підключення', 'error'); setSbConnecting(null); return; }
      window.location.href = data.url;
    } catch {
      toast('Помилка з’єднання', 'error');
      setSbConnecting(null);
    }
  }

  async function syncSb(userId: number) {
    if (sbSyncing) return;
    setSbSyncing(userId);
    try {
      const res = await fetch('/api/sparebank/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка синхронізації', 'error'); return; }
      if (data.created > 0) {
        // Sync already committed the rows (unlike the transaction list's
        // delete, which delays the real write) — "Скасувати" here calls a
        // real reversal endpoint naming exactly this sync's created rows,
        // rather than just clearing a pending timer.
        toast(
          `Додано транзакцій: ${data.created}`,
          'info',
          {
            label: 'Скасувати',
            onClick: async () => {
              try {
                const undoRes = await fetch('/api/sparebank/undo-sync', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId, transactionIds: data.createdIds, previousSyncedAt: data.previousSyncedAt }),
                });
                if (!undoRes.ok) { toast('Не вдалося скасувати', 'error'); return; }
                toast('Скасовано', 'info');
              } catch {
                toast('Помилка з’єднання', 'error');
              }
            },
          },
          5000,
        );
      } else {
        toast('Нових транзакцій немає');
      }
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbSyncing(null);
    }
  }

  async function disconnectSb(userId: number, name: string) {
    if (!confirm(`Відключити SpareBank 1 для ${name}?`)) return;
    try {
      const res = await fetch('/api/sparebank/disconnect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) { toast('Помилка відключення', 'error'); return; }
      toast('SpareBank 1 відключено', 'info');
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

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
  function loadUsers() {
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => {});
  }
  useEffect(() => {
    loadCats();
    loadTemplates();
    loadMonoStatus();
    loadSbStatus();
    loadUsers();

    // Landed here straight off the bank's redirect (api/sparebank/callback) —
    // surface the result once, then strip the param so a page refresh
    // doesn't re-show the toast.
    const params = new URLSearchParams(window.location.search);
    const sbResult = params.get('sparebank');
    if (sbResult === 'connected') {
      toast('SpareBank 1 підключено');
      loadSbStatus();
    } else if (sbResult === 'error') {
      toast('Не вдалося підключити SpareBank 1', 'error');
    }
    if (sbResult) {
      params.delete('sparebank');
      const qs = params.toString();
      window.history.replaceState({}, '', qs ? `?${qs}` : window.location.pathname);
    }
  }, []);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    const name = newUserName.trim();
    if (!name || addingUser) return;
    setAddingUser(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка додавання', 'error'); return; }
      setNewUserName('');
      loadUsers();
      toast('Користувача додано');
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setAddingUser(false);
    }
  }

  function startEditUser(u: { id: number; name: string }) {
    setEditingUserId(u.id);
    setEditUserName(u.name);
  }

  async function saveEditUser(id: number) {
    const name = editUserName.trim();
    if (!name || savingUserId) return;
    setSavingUserId(id);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка перейменування', 'error'); return; }
      setEditingUserId(null);
      loadUsers();
      toast("Ім'я оновлено");
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSavingUserId(null);
    }
  }

  async function deleteUser(u: { id: number; name: string }) {
    if (deletingUserId) return;
    if (!confirm(`Видалити ${u.name}? Його транзакції залишаться, але без прив'язки до конкретної людини.`)) return;
    setDeletingUserId(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка видалення', 'error'); return; }
      loadUsers();
      toast('Користувача видалено');
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setDeletingUserId(null);
    }
  }

  async function addTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!tplForm.name || !tplForm.amount || !tplForm.categoryId || !tplForm.userId || savingTpl) return;
    setSavingTpl(true);
    try {
      const res = await fetch('/api/recurring', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...tplForm, amount: Number(tplForm.amount), categoryId: Number(tplForm.categoryId), userId: Number(tplForm.userId) }),
      });
      if (!res.ok) { toast('Помилка додавання шаблону', 'error'); return; }
      toast(`Шаблон "${tplForm.name}" додано`);
      setTplForm({ name: '', amount: '', categoryId: '', userId: '' });
      loadTemplates();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSavingTpl(false);
    }
  }

  async function deleteTemplate(id: number, name: string) {
    try {
      const res = await fetch(`/api/recurring/${id}`, { method: 'DELETE' });
      if (!res.ok) { toast('Помилка видалення шаблону', 'error'); return; }
      toast(`Шаблон "${name}" видалено`, 'info');
      loadTemplates();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  async function addCat(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) { toast('Помилка додавання категорії', 'error'); return; }
      toast(`Категорію "${form.name}" додано`);
      setForm({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle' });
      loadCats();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  async function deleteCat(id: number) {
    const cat = cats.find(c => c.id === id);
    if (!confirm('Видалити категорію?')) return;
    try {
      const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      if (!res.ok) { toast('Помилка видалення категорії', 'error'); return; }
      toast(`Категорію "${cat?.name}" видалено`, 'info');
      loadCats();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  async function updateColor(id: number, color: string) {
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color }),
      });
      if (!res.ok) { toast('Помилка оновлення кольору', 'error'); return; }
      setCats(prev => prev.map(c => c.id === id ? { ...c, color } : c));
      setEditingColorId(null);
      toast('Колір оновлено');
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  async function updateIcon(id: number, icon: string) {
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icon }),
      });
      if (!res.ok) { toast('Помилка оновлення іконки', 'error'); return; }
      setCats(prev => prev.map(c => c.id === id ? { ...c, icon } : c));
      setEditingIconId(null);
      toast('Іконку оновлено');
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus('loading');
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/import', { method: 'POST', body: formData });
      if (res.ok) { setImportStatus('done'); loadCats(); toast('Імпорт завершено успішно'); }
      else { setImportStatus('error'); toast('Помилка імпорту', 'error'); }
    } catch {
      setImportStatus('error');
      toast('Помилка з’єднання', 'error');
    }
  }

  const [theme, toggleTheme] = useTheme();
  const [dashSections, updateSections] = useDashboardPrefs();

  const [pinForm, setPinForm] = useState({ current: '', next: '' });
  const [pinSaving, setPinSaving] = useState(false);

  async function savePin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinForm.next || pinSaving) return;
    if (account?.hasPin && !pinForm.current) { toast('Введіть поточний PIN', 'error'); return; }
    if (!/^\d{4,8}$/.test(pinForm.next)) { toast('PIN — від 4 до 8 цифр', 'error'); return; }
    setPinSaving(true);
    try {
      const res = await fetch('/api/account/pin', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: pinForm.current || undefined, next: pinForm.next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка збереження PIN', 'error'); return; }
      toast(account?.hasPin ? 'PIN змінено' : 'PIN увімкнено');
      setPinForm({ current: '', next: '' });
      setAccount(a => a ? { ...a, hasPin: true } : a);
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setPinSaving(false);
    }
  }

  async function removePin() {
    if (pinSaving || !confirm('Прибрати PIN-замок? Застосунок більше не проситиме PIN при вході.')) return;
    if (!pinForm.current) { toast('Введіть поточний PIN, щоб прибрати його', 'error'); return; }
    setPinSaving(true);
    try {
      const res = await fetch('/api/account/pin', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: pinForm.current, next: '' }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка видалення PIN', 'error'); return; }
      toast('PIN прибрано', 'info');
      setPinForm({ current: '', next: '' });
      setAccount(a => a ? { ...a, hasPin: false } : a);
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

      {/* Account section */}
      {account && (
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Обліковий запис</h2>
          {account.shared ? (
            <p style={{ fontSize: 14, color: 'var(--c-text-sec)', marginBottom: 16 }}>
              Ви увійшли за спільним PIN (без прив'язки до конкретного користувача)
            </p>
          ) : (
            <p style={{ fontSize: 14, color: 'var(--c-text-sec)', marginBottom: 16 }}>
              Ви увійшли як <strong>{account.user!.name}</strong>
              {account.user!.telegramUsername && <> · Telegram @{account.user!.telegramUsername}</>}
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {!account.shared && account.user!.telegramUsername && (
              <button onClick={disconnectTelegram} disabled={unlinking} className="btn-ghost" style={{ padding: '10px 16px' }}>
                {unlinking ? 'Відключення…' : 'Відключити Telegram'}
              </button>
            )}
            <button onClick={logout} disabled={loggingOut} className="btn-ghost" style={{ padding: '10px 16px' }}>
              {loggingOut ? 'Вихід…' : 'Вийти'}
            </button>
          </div>
        </div>
      )}

      {/* Users section */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 16 }}>Користувачі</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: users.length > 0 ? 16 : 0 }}>
          {users.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {editingUserId === u.id ? (
                <>
                  <input
                    className="input-field" value={editUserName}
                    onChange={e => setEditUserName(e.target.value)}
                    style={{ flex: 1 }} autoFocus
                  />
                  <button onClick={() => saveEditUser(u.id)} disabled={savingUserId === u.id} className="btn-primary" style={{ padding: '9px 14px' }}>
                    {savingUserId === u.id ? '…' : 'Зберегти'}
                  </button>
                  <button onClick={() => setEditingUserId(null)} className="btn-ghost" style={{ padding: '9px 14px' }}>
                    Скасувати
                  </button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 14, color: 'var(--c-text-sec)' }}>{u.name}</span>
                  <button onClick={() => startEditUser(u)} className="btn-ghost" style={{ padding: '9px 12px' }} aria-label={`Перейменувати ${u.name}`}>
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => deleteUser(u)} disabled={deletingUserId === u.id}
                    className="btn-ghost" style={{ padding: '9px 12px', color: '#FCA5A5' }}
                    aria-label={`Видалити ${u.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {users.length < 2 && (
          <form onSubmit={addUser} style={{ display: 'flex', gap: 8 }}>
            <input
              className="input-field" value={newUserName}
              onChange={e => setNewUserName(e.target.value)}
              placeholder="Ім'я нового користувача" style={{ flex: 1 }}
            />
            <button type="submit" disabled={addingUser} className="btn-primary" style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              <UserPlus size={16} />
              {addingUser ? 'Додавання…' : 'Додати'}
            </button>
          </form>
        )}
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

      {/* Security section — PIN LOGIN (typing a PIN to establish identity)
          is still exclusive to household #1, but the PIN LOCK (an extra
          unlock step on top of an already-authenticated session, P4) is
          available to every household, so this shows for everyone. */}
      {account && (
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 4 }}>Безпека</h2>
        <p style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 0, marginBottom: 14 }}>
          {account.hasPin
            ? 'PIN-замок увімкнено — застосунок проситиме PIN навіть у межах активної сесії.'
            : 'PIN-замок вимкнено. Додатковий захист поверх входу — рекомендовано.'}
        </p>
        <form onSubmit={savePin} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {account.hasPin && (
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>Поточний PIN</label>
              <input
                className="input-field" type="password" inputMode="numeric" required
                value={pinForm.current}
                onChange={e => setPinForm(f => ({ ...f, current: e.target.value }))}
                placeholder="••••••"
              />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 140 }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 5 }}>{account.hasPin ? 'Новий PIN' : 'PIN'}</label>
            <input
              className="input-field" type="password" inputMode="numeric" required
              value={pinForm.next}
              onChange={e => setPinForm(f => ({ ...f, next: e.target.value }))}
              placeholder="••••••"
            />
          </div>
          <button type="submit" disabled={pinSaving} className="btn-primary" style={{ padding: '10px 18px' }}>
            {pinSaving ? 'Збереження…' : account.hasPin ? 'Змінити PIN' : 'Увімкнути PIN'}
          </button>
          {/* Household #1 can't actually remove its PIN — it's the account's
              sole login method, not just an optional lock (see
              api/account/pin's matching server-side guard). */}
          {account.hasPin && !account.isPinHousehold && (
            <button type="button" disabled={pinSaving} onClick={removePin} className="btn-ghost" style={{ padding: '10px 14px', color: '#EF4444' }}>
              Прибрати
            </button>
          )}
        </form>
        <p style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 10 }}>
          Діє одразу для наступних входів. Уже виконані входи лишаються активними до 30 днів.
        </p>
      </div>
      )}

      {/* Bank connections — Monobank + SpareBank 1 merged into one card with
          a per-user bank picker, instead of two separate cards each user had
          to check. Once a user is connected to either bank, the picker goes
          away and just shows that connection's status/sync/disconnect. */}
      <div className="card" style={{ padding: 24, marginBottom: 24 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Landmark size={16} color="#000000" /> Банківське підключення
        </h2>
        <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>
          Monobank — токен зі свого кабінету на{' '}
          <a href="https://api.monobank.ua/" target="_blank" rel="noopener noreferrer" style={{ color: '#F97316' }}>
            api.monobank.ua
          </a>
          . SpareBank 1 Sogn og Fjordane — підключення веде на сторінку входу банку (BankID), токен не потрібен.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {users.map(u => {
            const mono = monoStatus.find(m => m.userId === u.id);
            const sb = sbStatus.find(m => m.userId === u.id);
            const monoConnected = !!mono?.connected;
            const sbConnected = !!sb?.connected;
            // A user can have BOTH banks connected at once — independent
            // fields on User, not mutually exclusive. remainingBanks is what's
            // still available for the "+ Додати банк" flow below.
            const remainingBanks: ('mono' | 'sparebank')[] = [
              ...(!monoConnected ? (['mono'] as const) : []),
              ...(!sbConnected ? (['sparebank'] as const) : []),
            ];
            const isAdding = addingBank[u.id] ?? false;
            const choice = remainingBanks.length === 1 ? remainingBanks[0] : (bankChoice[u.id] ?? remainingBanks[0]);
            return (
              <div key={u.id} style={{ borderTop: '1px solid var(--c-border)', paddingTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)' }}>{u.name}</span>
                  {remainingBanks.length > 0 && !isAdding && (
                    <button
                      className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
                      onClick={() => setAddingBank(prev => ({ ...prev, [u.id]: true }))}
                    >
                      <Plus size={13} /> Додати банк
                    </button>
                  )}
                  {isAdding && (
                    <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setAddingBank(prev => ({ ...prev, [u.id]: false }))}>
                      Скасувати
                    </button>
                  )}
                </div>

                {monoConnected && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#64748B' }}>Monobank</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#4ADE80' }}>
                        <CheckCircle size={13} /> Підключено
                      </span>
                      <button
                        className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                        disabled={monoSyncing === u.id} onClick={() => syncMono(u.id)}
                      >
                        {monoSyncing === u.id ? 'Синхронізація…' : 'Синхронізувати'}
                      </button>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => disconnectMono(u.id, u.name)}>
                        Відключити
                      </button>
                    </div>
                  </div>
                )}

                {sbConnected && sb && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: '#64748B' }}>SpareBank 1{sb.iban ? ` — ${sb.iban}` : ''}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {sb.expired ? (
                        <span style={{ fontSize: 12, color: '#F97316' }}>Доступ прострочено</span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#4ADE80' }}>
                          <CheckCircle size={13} /> Підключено
                        </span>
                      )}
                      {sb.expired ? (
                        <button
                          className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                          disabled={sbConnecting === u.id} onClick={() => connectSb(u.id)}
                        >
                          {sbConnecting === u.id ? 'Перенаправлення…' : 'Перепідключити'}
                        </button>
                      ) : (
                        <button
                          className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                          disabled={sbSyncing === u.id} onClick={() => syncSb(u.id)}
                        >
                          {sbSyncing === u.id ? 'Синхронізація…' : 'Синхронізувати'}
                        </button>
                      )}
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => disconnectSb(u.id, u.name)}>
                        Відключити
                      </button>
                    </div>
                  </div>
                )}

                {isAdding && remainingBanks.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* Dropdown only when neither bank is connected yet — with
                        exactly one remaining, there's nothing to pick. */}
                    {remainingBanks.length > 1 && (
                      <select
                        className="input-field" style={{ fontSize: 13, padding: '4px 8px', width: 'auto' }}
                        value={choice}
                        onChange={e => setBankChoice(prev => ({ ...prev, [u.id]: e.target.value as 'mono' | 'sparebank' }))}
                      >
                        <option value="mono">Monobank</option>
                        <option value="sparebank">SpareBank 1 Sogn og Fjordane</option>
                      </select>
                    )}

                    {choice === 'mono' && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="input-field" type="password" placeholder="Персональний токен Monobank"
                          value={monoTokenInput[u.id] ?? ''}
                          onChange={e => setMonoTokenInput(prev => ({ ...prev, [u.id]: e.target.value }))}
                          style={{ fontSize: 13 }}
                        />
                        <button
                          className="btn-primary" style={{ padding: '8px 16px', fontSize: 13, whiteSpace: 'nowrap' }}
                          disabled={monoConnecting === u.id || !monoTokenInput[u.id]?.trim()}
                          onClick={() => connectMono(u.id)}
                        >
                          {monoConnecting === u.id ? 'Підключення…' : 'Підключити'}
                        </button>
                      </div>
                    )}

                    {choice === 'sparebank' && (
                      <button
                        className="btn-primary" style={{ padding: '8px 16px', fontSize: 13, whiteSpace: 'nowrap', alignSelf: 'flex-start' }}
                        disabled={sbConnecting === u.id}
                        onClick={() => connectSb(u.id)}
                      >
                        {sbConnecting === u.id ? 'Перенаправлення…' : 'Підключити'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
          <button type="submit" className="btn-primary" disabled={savingTpl}><Plus size={15} /> {savingTpl ? 'Збереження…' : 'Додати'}</button>
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
