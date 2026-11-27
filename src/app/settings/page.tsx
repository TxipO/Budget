'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Plus, Trash2, Upload, CheckCircle, Sun, Moon, Landmark, Pencil, UserPlus, AlertTriangle, Lock } from 'lucide-react';
import { CATEGORY_PALETTE } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { CURRENCIES, formatMoney as formatMoneyIn } from '@/lib/currencies';
import { useTheme } from '@/lib/theme';
import { useDashboardPrefs, PREF_LABELS, type DashboardPrefs } from '@/lib/dashboardPrefs';
import { ICON_KEYS } from '@/lib/icons';
import CategoryIcon from '@/components/CategoryIcon';

interface Category { id: number; name: string; type: string; color: string; icon: string; isActive: boolean; lockedFromModes: boolean }

// A stored bank balance older than this missed its automatic refreshes (the
// cron refreshes roughly daily) — shown as a warning instead of a quiet number
// that looks current. Same 1.5-day idea as the weekly check's 3-day alert.
const BALANCE_STALE_MS = 36 * 3600 * 1000;
// Same 7-day lead as the dashboard's "needs attention" badge: reconnect before the consent lapses.
const CONSENT_WARN_MS = 7 * 24 * 3600 * 1000;

// Same formatter as the rest of the app (grouping, NBSP, suffix) in the
// account's own currency; a currency the app doesn't know keeps the raw code.
function fmtBalance(amount: number, currency: string | null): string {
  if (CURRENCIES.some(c => c.code === currency)) return (amount < 0 ? '-' : '') + formatMoneyIn(amount, currency!);
  return `${Math.round(amount).toLocaleString('uk-UA')} ${currency ?? ''}`;
}

const vars = (o: Record<string, string | number>) => o as CSSProperties;

function BalanceAge({ fetchedAt }: { fetchedAt: string | null }) {
  if (!fetchedAt) return null;
  const t = new Date(fetchedAt);
  const stale = Date.now() - t.getTime() > BALANCE_STALE_MS;
  const when = t.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  return (
    <span style={{ fontSize: 12, color: stale ? 'var(--c-warn-text)' : 'var(--c-text-muted)' }}>
      {stale ? 'застарілий · ' : ''}оновлено {when}
    </span>
  );
}

export default function SettingsPage() {
  const [cats, setCats] = useState<Category[]>([]);
  const [form, setForm] = useState({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle', lockedFromModes: false });
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [editingColorId, setEditingColorId] = useState<number | null>(null);
  const [editingIconId, setEditingIconId] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);

  const [monoStatus, setMonoStatus] = useState<{ userId: number; name: string; connected: boolean; accountId: string | null; balanceAmount: number | null; balanceCurrency: string | null; balanceFetchedAt: string | null; lastSyncError: string | null }[]>([]);
  const [llmStatus, setLlmStatus] = useState<{ status: 'alive' | 'dead' | 'unknown'; llmCount: number; fallbackCount: number; lookbackDays: number } | null>(null);
  const [monoTokenInput, setMonoTokenInput] = useState<Record<number, string>>({});
  const [monoConnecting, setMonoConnecting] = useState<number | null>(null);
  const [monoSyncing, setMonoSyncing] = useState<number | null>(null);
  // Card picker: accounts are loaded on demand (one Monobank call), per user.
  const [monoCards, setMonoCards] = useState<Record<number, { id: string; type: string; currency: string; maskedPan: string | null; balance: number; isCurrent: boolean }[]>>({});
  const [monoCardPick, setMonoCardPick] = useState<Record<number, string>>({});
  const [monoCardBusy, setMonoCardBusy] = useState<number | null>(null);

  interface SbAccount { id: number; label: string; iban: string | null; syncEnabled: boolean; lastSyncedAt: string | null; balanceAmount: number | null; balanceCurrency: string | null; balanceFetchedAt: string | null; categoryId: number | null }
  const [sbStatus, setSbStatus] = useState<{ userId: number; name: string; connected: boolean; expired: boolean; validUntil: string | null; autoSync: boolean; lastAutoSyncAt: string | null; lastAutoSyncOkAt: string | null; autoSyncFailCount: number; lastSyncError: string | null; accounts: SbAccount[] }[]>([]);
  const [sbAutoSyncToggling, setSbAutoSyncToggling] = useState<number | null>(null);
  const [sbConnecting, setSbConnecting] = useState<number | null>(null);
  const [sbSyncing, setSbSyncing] = useState<number | null>(null);
  const [sbBalanceRefreshing, setSbBalanceRefreshing] = useState<number | null>(null); // userId
  const [sbAccountToggling, setSbAccountToggling] = useState<number | null>(null); // accountId
  const [sbEditingLabelId, setSbEditingLabelId] = useState<number | null>(null); // accountId
  const [sbLabelInput, setSbLabelInput] = useState('');
  const [sbSavingLabel, setSbSavingLabel] = useState(false);

  // Which bank is picked in the not-yet-connected dropdown, per user — only
  // relevant before a connection exists; once connected, the row just shows
  // whichever bank actually is connected, no picker needed.
  const [bankChoice, setBankChoice] = useState<Record<number, 'mono' | 'sparebank'>>({});
  // Optional "backfill from this date" per user, shown only while connecting
  // a NEW bank (Monobank or SpareBank 1) — empty means the default behavior
  // (webhook/watermark-forward-only, no historical pull).
  const [syncFromDate, setSyncFromDate] = useState<Record<number, string>>({});
  // Whether the "add another bank" form is expanded, per user — a user can
  // have BOTH Monobank and SpareBank 1 connected at once (independent DB
  // fields), so connecting one must not hide the option to add the other.
  const [addingBank, setAddingBank] = useState<Record<number, boolean>>({});

  interface AccountInfo { shared: boolean; isPinHousehold: boolean; hasPin: boolean; user?: { id: number; name: string; telegramUsername: string | null; telegramFirstName: string | null; email: string | null } }
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

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

  async function logoutEverywhere() {
    if (loggingOutAll || !confirm('Вийти на всіх пристроях? Усі інші пристрої та вкладки доведеться авторизувати заново. На цьому пристрої ви залишитесь.')) return;
    setLoggingOutAll(true);
    try {
      const res = await fetch('/api/account/logout-all', { method: 'POST' });
      if (!res.ok) { toast('Помилка', 'error'); return; }
      toast('Усі інші сеанси завершено');
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setLoggingOutAll(false);
    }
  }

  function loadMonoStatus() {
    fetch('/api/monobank/status').then(r => r.ok ? r.json() : Promise.reject()).then(setMonoStatus).catch(() => {});
  }
  function loadLlmStatus() {
    fetch('/api/categorize/llm-status').then(r => r.ok ? r.json() : Promise.reject()).then(setLlmStatus).catch(() => {});
  }

  async function connectMono(userId: number) {
    const token = monoTokenInput[userId]?.trim();
    if (!token || monoConnecting) return;
    setMonoConnecting(userId);
    try {
      const res = await fetch('/api/monobank/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, token, syncFromDate: syncFromDate[userId] || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка підключення', 'error'); return; }
      toast(data.backfill ? `Monobank підключено, додано транзакцій: ${data.backfill.created}` : 'Monobank підключено');
      setMonoTokenInput(prev => ({ ...prev, [userId]: '' }));
      setSyncFromDate(prev => ({ ...prev, [userId]: '' }));
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
      loadMonoStatus(); // the sync also refreshed the stored balance
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setMonoSyncing(null);
    }
  }

  async function loadMonoCards(userId: number) {
    if (monoCardBusy) return;
    setMonoCardBusy(userId);
    try {
      const res = await fetch(`/api/monobank/accounts?userId=${userId}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Не вдалося завантажити картки', 'error'); return; }
      setMonoCards(prev => ({ ...prev, [userId]: data }));
      setMonoCardPick(prev => ({ ...prev, [userId]: data.find((a: { isCurrent: boolean }) => a.isCurrent)?.id ?? data[0]?.id ?? '' }));
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setMonoCardBusy(null);
    }
  }

  async function saveMonoCard(userId: number) {
    const accountId = monoCardPick[userId];
    if (!accountId || monoCardBusy) return;
    setMonoCardBusy(userId);
    try {
      const res = await fetch('/api/monobank/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, accountId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Не вдалося зберегти картку', 'error'); return; }
      toast('Картку збережено. Натисніть «Синхронізувати», щоб підтягнути транзакції');
      setMonoCards(prev => { const { [userId]: _drop, ...rest } = prev; return rest; });
      loadMonoStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setMonoCardBusy(null);
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
        body: JSON.stringify({ userId, syncFromDate: syncFromDate[userId] || undefined }),
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
        // real reversal endpoint naming exactly this sync's created rows.
        // Only offered when exactly one account was actually synced — with
        // several, undo would need to name every account's own watermark at
        // once, which undo-sync (deliberately kept single-account, see its
        // own comment) doesn't support.
        const single = data.perAccount?.length === 1 ? data.perAccount[0] : null;
        toast(
          `Додано транзакцій: ${data.created}`,
          'info',
          single ? {
            label: 'Скасувати',
            onClick: async () => {
              try {
                const undoRes = await fetch('/api/sparebank/undo-sync', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId, accountId: single.accountId, transactionIds: data.createdIds, previousSyncedAt: single.previousSyncedAt }),
                });
                if (!undoRes.ok) { toast('Не вдалося скасувати', 'error'); return; }
                toast('Скасовано', 'info');
              } catch {
                toast('Помилка з’єднання', 'error');
              }
            },
          } : undefined,
          5000,
        );
      } else if (data.reconciled > 0) {
        // No NEW rows, but a previously-recorded one just got detected as a
        // same-person transfer now that the bank finished enriching it
        // (see ingestTransaction's `needsReconciliation` comment) — worth a
        // distinct message so "0 нових" doesn't read as "sync found
        // nothing to do" when it actually fixed something.
        toast(`Уточнено транзакцій: ${data.reconciled}`);
      } else {
        toast('Нових транзакцій немає');
      }
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbSyncing(null);
    }
  }

  async function toggleSbAutoSync(userId: number, enabled: boolean) {
    if (sbAutoSyncToggling) return;
    setSbAutoSyncToggling(userId);
    try {
      const res = await fetch('/api/sparebank/auto-sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, enabled }),
      });
      if (!res.ok) { toast('Не вдалося змінити налаштування', 'error'); return; }
      toast(enabled ? 'Автосинхронізацію увімкнено' : 'Автосинхронізацію вимкнено', 'info');
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbAutoSyncToggling(null);
    }
  }

  async function refreshSbBalances(userId: number) {
    if (sbBalanceRefreshing) return;
    setSbBalanceRefreshing(userId);
    try {
      const res = await fetch('/api/sparebank/refresh-balances', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error || 'Помилка оновлення балансів', 'error'); return; }
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbBalanceRefreshing(null);
    }
  }

  async function toggleSbAccountSync(accountId: number, syncEnabled: boolean) {
    if (sbAccountToggling) return;
    setSbAccountToggling(accountId);
    try {
      const res = await fetch('/api/sparebank/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, syncEnabled }),
      });
      if (!res.ok) { toast('Не вдалося змінити налаштування', 'error'); return; }
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbAccountToggling(null);
    }
  }

  // "This real bank account IS this tracked savings pool" — Ф2, see
  // SparebankAccount.categoryId's own schema comment. null clears the
  // mapping (an ordinary, non-pool account like "Основний").
  async function setSbAccountCategory(accountId: number, categoryId: number | null) {
    if (sbAccountToggling) return;
    setSbAccountToggling(accountId);
    try {
      const res = await fetch('/api/sparebank/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, categoryId }),
      });
      if (!res.ok) { toast('Не вдалося зберегти категорію', 'error'); return; }
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbAccountToggling(null);
    }
  }

  async function saveSbLabel(accountId: number) {
    const label = sbLabelInput.trim();
    if (!label || sbSavingLabel) return;
    setSbSavingLabel(true);
    try {
      const res = await fetch('/api/sparebank/account', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, label }),
      });
      if (!res.ok) { toast('Не вдалося зберегти назву', 'error'); return; }
      setSbEditingLabelId(null);
      loadSbStatus();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setSbSavingLabel(false);
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
  function loadUsers() {
    fetch('/api/users').then(r => r.ok ? r.json() : Promise.reject()).then(setUsers).catch(() => {});
  }
  useEffect(() => {
    loadCats();
    loadMonoStatus();
    loadSbStatus();
    loadUsers();
    loadLlmStatus();

    // Landed here straight off the bank's redirect (api/sparebank/callback) —
    // surface the result once, then strip the param so a page refresh
    // doesn't re-show the toast.
    const params = new URLSearchParams(window.location.search);
    const sbResult = params.get('sparebank');
    if (sbResult === 'connected') {
      const created = params.get('created');
      toast(created !== null ? `SpareBank 1 підключено, додано транзакцій: ${created}` : 'SpareBank 1 підключено');
      loadSbStatus();
    } else if (sbResult === 'error') {
      toast('Не вдалося підключити SpareBank 1', 'error');
    }
    if (sbResult) {
      params.delete('sparebank');
      params.delete('created');
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


  async function addCat(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/categories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) { toast('Помилка додавання категорії', 'error'); return; }
      toast(`Категорію "${form.name}" додано`);
      setForm({ name: '', type: 'expense', color: CATEGORY_PALETTE[0], icon: 'circle', lockedFromModes: false });
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

  async function toggleLocked(id: number, lockedFromModes: boolean) {
    try {
      const res = await fetch(`/api/categories/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lockedFromModes }),
      });
      if (!res.ok) { toast('Помилка оновлення категорії', 'error'); return; }
      setCats(prev => prev.map(c => c.id === id ? { ...c, lockedFromModes } : c));
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
    { type: 'income', label: 'Дохід', color: 'var(--c-income-num)' },
    { type: 'expense', label: 'Витрати', color: 'var(--c-expense-num)' },
    { type: 'savings', label: 'Збереження', color: 'var(--c-savings-num)' },
  ];

  return (
    <div className="dash dash-stack set-wrap">
      <div className="dash-head">
        <div className="dash-title">
          <h1>Налаштування</h1>
          <span className="d-note">Категорії та імпорт даних</span>
        </div>
      </div>

      <div className="set-group" role="group" aria-labelledby="set-g-acc">
        <p className="set-grp" id="set-g-acc">Обліковий запис і безпека</p>

      {/* Account section */}
      {account && (
        <section className="d-card d-pane d-rise" style={vars({ '--i': 0 })}>
          <div className="d-ch"><h2>Обліковий запис</h2></div>
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
              <button onClick={disconnectTelegram} disabled={unlinking} className="d-btn">
                {unlinking ? 'Відключення…' : 'Відключити Telegram'}
              </button>
            )}
            <button onClick={logout} disabled={loggingOut} className="d-btn">
              {loggingOut ? 'Вихід…' : 'Вийти'}
            </button>
            <button onClick={logoutEverywhere} disabled={loggingOutAll} className="d-btn">
              {loggingOutAll ? 'Завершення…' : 'Вийти на всіх пристроях'}
            </button>
          </div>
        </section>
      )}

      {/* Users section */}
      <section className="d-card d-pane d-rise" style={vars({ '--i': 1 })}>
        <div className="d-ch"><h2>Користувачі</h2></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: users.length > 0 ? 16 : 0 }}>
          {users.map(u => (
            <div key={u.id} className="set-row">
              {editingUserId === u.id ? (
                <>
                  <input
                    className="input-field" value={editUserName}
                    onChange={e => setEditUserName(e.target.value)}
                    style={{ flex: 1, minWidth: 140 }} autoFocus
                  />
                  <button onClick={() => saveEditUser(u.id)} disabled={savingUserId === u.id} className="d-btn">
                    {savingUserId === u.id ? '…' : 'Зберегти'}
                  </button>
                  <button onClick={() => setEditingUserId(null)} className="d-btn">
                    Скасувати
                  </button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 14, color: 'var(--c-text-sec)' }}>{u.name}</span>
                  <button onClick={() => startEditUser(u)} className="d-round ghost" aria-label={`Перейменувати ${u.name}`}>
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => deleteUser(u)} disabled={deletingUserId === u.id}
                    className="d-round ghost neg"
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
          <form onSubmit={addUser} className="set-row">
            <input
              className="input-field" value={newUserName}
              onChange={e => setNewUserName(e.target.value)}
              placeholder="Ім'я нового користувача" style={{ flex: 1, minWidth: 160 }}
            />
            <button type="submit" disabled={addingUser} className="d-btn">
              <UserPlus size={16} />
              {addingUser ? 'Додавання…' : 'Додати'}
            </button>
          </form>
        )}
      </section>

      {/* Security section — PIN LOGIN (typing a PIN to establish identity)
          is still exclusive to household #1, but the PIN LOCK (an extra
          unlock step on top of an already-authenticated session, P4) is
          available to every household, so this shows for everyone. */}
      {account && (
      <section className="d-card d-pane d-rise" style={vars({ '--i': 2 })}>
        <div className="d-ch"><h2>Безпека</h2></div>
        <p className="d-note" style={{ marginBottom: 14 }}>
          {account.hasPin
            ? 'PIN-замок увімкнено — застосунок проситиме PIN навіть у межах активної сесії.'
            : 'PIN-замок вимкнено. Додатковий захист поверх входу — рекомендовано.'}
        </p>
        <form onSubmit={savePin} className="set-form">
          {account.hasPin && (
            <div style={{ flex: 1, minWidth: 140 }}>
              <label className="set-lbl">Поточний PIN</label>
              <input
                className="input-field" type="password" inputMode="numeric" required
                value={pinForm.current}
                onChange={e => setPinForm(f => ({ ...f, current: e.target.value }))}
                placeholder="••••••"
              />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 140 }}>
            <label className="set-lbl">{account.hasPin ? 'Новий PIN' : 'PIN'}</label>
            <input
              className="input-field" type="password" inputMode="numeric" required
              value={pinForm.next}
              onChange={e => setPinForm(f => ({ ...f, next: e.target.value }))}
              placeholder="••••••"
            />
          </div>
          <button type="submit" disabled={pinSaving} className="d-btn">
            {pinSaving ? 'Збереження…' : account.hasPin ? 'Змінити PIN' : 'Увімкнути PIN'}
          </button>
          {/* Household #1 can't actually remove its PIN — it's the account's
              sole login method, not just an optional lock (see
              api/account/pin's matching server-side guard). */}
          {account.hasPin && !account.isPinHousehold && (
            <button type="button" disabled={pinSaving} onClick={removePin} className="d-btn neg">
              Прибрати
            </button>
          )}
        </form>
        <p className="d-note" style={{ marginTop: 12 }}>
          Діє одразу для наступних входів. Після зміни PIN усі інші пристрої доведеться авторизувати заново.
        </p>
      </section>
      )}
      </div>

      <div className="set-group" role="group" aria-labelledby="set-g-bank">
        <p className="set-grp" id="set-g-bank">Банки та імпорт</p>

      {/* Bank connections — Monobank + SpareBank 1 merged into one card with
          a per-user bank picker, instead of two separate cards each user had
          to check. Once a user is connected to either bank, the picker goes
          away and just shows that connection's status/sync/disconnect. */}
        <section className="d-card d-pane d-rise" style={vars({ '--i': 4 })}>
          <div className="d-ch">
            <h2>Банківське підключення</h2>
            <span className="d-chip or"><Landmark size={18} /></span>
          </div>
          <p className="d-note" style={{ marginBottom: 12 }}>
            Monobank — токен зі свого кабінету на{' '}
            <a href="https://api.monobank.ua/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--c-accent-text)' }}>
              api.monobank.ua
            </a>
            . SpareBank 1 Sogn og Fjordane — підключення веде на сторінку входу банку (BankID), токен не потрібен.
          </p>
        {/* Auto-categorization health — the LLM tier (Groq) sat silently dead
            for an unknown stretch of time on 2026-09-15 (retired model +
            empty prod API key), both failures shaped so nothing ever showed
            an error. This surfaces that class of failure here instead of
            only in a script someone has to remember to run. */}
        {llmStatus && llmStatus.status !== 'unknown' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, marginBottom: 16, color: llmStatus.status === 'alive' ? 'var(--c-pos-text)' : 'var(--c-accent-text)' }}>
            {llmStatus.status === 'alive'
              ? <><CheckCircle size={13} /> Авто-категоризація (Groq): працює — {llmStatus.llmCount} рішень за {llmStatus.lookbackDays} днів</>
              : <><AlertTriangle size={13} /> Авто-категоризація (Groq): не спрацювала жодного разу за {llmStatus.lookbackDays} днів, хоча {llmStatus.fallbackCount} транзакцій впали в "Незрозуміло" — перевірте GROQ_API_KEY</>}
          </div>
        )}
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
              <div key={u.id} style={{ borderTop: '1px solid var(--c-line)', paddingTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)' }}>{u.name}</span>
                  {remainingBanks.length > 0 && !isAdding && (
                    <button
                      className="d-btn sm"
                      onClick={() => setAddingBank(prev => ({ ...prev, [u.id]: true }))}
                    >
                      <Plus size={13} /> Додати банк
                    </button>
                  )}
                  {isAdding && (
                    <button className="d-btn sm" onClick={() => setAddingBank(prev => ({ ...prev, [u.id]: false }))}>
                      Скасувати
                    </button>
                  )}
                </div>

                {monoConnected && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>Monobank</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {mono?.lastSyncError ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--c-accent-text)' }}>
                          <AlertTriangle size={13} /> Помилка синхронізації
                        </span>
                      ) : (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--c-pos-text)' }}>
                          <CheckCircle size={13} /> Підключено
                        </span>
                      )}
                      <button
                        className="d-btn sm"
                        disabled={monoSyncing === u.id} onClick={() => syncMono(u.id)}
                      >
                        {monoSyncing === u.id ? 'Синхронізація…' : 'Синхронізувати'}
                      </button>
                      <button className="d-btn sm" onClick={() => disconnectMono(u.id, u.name)}>
                        Відключити
                      </button>
                    </div>
                  </div>
                )}
                {monoConnected && mono?.lastSyncError && (
                  <div style={{ marginTop: 4, fontSize: 12, color: 'var(--c-accent-text)' }}>
                    Не вдається отримати виписку — {mono.lastSyncError}
                    {!mono.lastSyncError.includes('перепідключіть') && ' Якщо не минає — відключіть і підключіть Monobank знову.'}
                  </div>
                )}
                {monoConnected && (
                  // Account currency (UAH), not the household's — own line so it
                  // wraps under the buttons instead of widening the row at 360px.
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px', marginTop: 4, fontSize: 12 }}>
                    {mono?.balanceAmount != null && !mono.lastSyncError?.includes('не знайдено') ? (
                      <>
                        <span style={{ color: 'var(--c-text-sec)' }}>Баланс: {fmtBalance(mono.balanceAmount, mono.balanceCurrency)}</span>
                        <BalanceAge fetchedAt={mono.balanceFetchedAt} />
                      </>
                    ) : (
                      <span style={{ color: 'var(--c-text-muted)' }}>Баланс: ще не завантажено</span>
                    )}
                  </div>
                )}
                {monoConnected && (() => {
                  const cards = monoCards[u.id];
                  const broken = !!mono?.lastSyncError && /invalid 'account'|не знайдено/.test(mono.lastSyncError);
                  return (
                    <div style={{ marginTop: 6, fontSize: 12, ...(broken ? { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--c-accent-text)', color: 'var(--c-accent-text)' } : {}) }}>
                      {broken && <div style={{ marginBottom: 6 }}><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Картку, з якої беруться транзакції, треба вибрати знову.</div>}
                      {!cards ? (
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0 8px' }}>
                          <span style={{ color: broken ? undefined : 'var(--c-text-muted)' }}>Картка: {mono?.balanceCurrency ?? '—'}</span>
                          <button className="d-btn sm" disabled={monoCardBusy === u.id} onClick={() => loadMonoCards(u.id)}>
                            {monoCardBusy === u.id ? 'Завантаження…' : broken ? 'Вибрати картку' : 'змінити'}
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <select
                            className="input-field" style={{ minHeight: 44, fontSize: 14 }} aria-label="Картка Monobank"
                            value={monoCardPick[u.id] ?? ''} onChange={e => setMonoCardPick(prev => ({ ...prev, [u.id]: e.target.value }))}
                          >
                            {cards.map(a => (
                              <option key={a.id} value={a.id}>
                                {a.type} {a.currency}{a.maskedPan ? ` ••${a.maskedPan}` : ''} — {fmtBalance(a.balance, a.currency)}{a.isCurrent ? ' (поточна)' : ''}
                              </option>
                            ))}
                          </select>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="d-btn sm" disabled={monoCardBusy === u.id || !monoCardPick[u.id]} onClick={() => saveMonoCard(u.id)}>
                              {monoCardBusy === u.id ? 'Збереження…' : 'Зберегти'}
                            </button>
                            <button className="d-btn sm" onClick={() => setMonoCards(prev => { const { [u.id]: _drop, ...rest } = prev; return rest; })}>Скасувати</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {sbConnected && sb && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                      <span style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>SpareBank 1</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        {sb.expired ? (
                          <span style={{ fontSize: 12, color: 'var(--c-accent-text)' }}>Доступ прострочено</span>
                        ) : (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--c-pos-text)' }}>
                            <CheckCircle size={13} /> Підключено
                          </span>
                        )}
                        {sb.expired ? (
                          <button
                            className="d-btn sm"
                            disabled={sbConnecting === u.id} onClick={() => connectSb(u.id)}
                          >
                            {sbConnecting === u.id ? 'Перенаправлення…' : 'Перепідключити'}
                          </button>
                        ) : (
                          <>
                            {/* Reconnect while still connected is fine (same flow as after expiry); no «Відключити» button here (the endpoint keeps the account rows, so a reconnect keeps sbTransactionId keys). */}
                            {sb.validUntil && new Date(sb.validUntil).getTime() - Date.now() < CONSENT_WARN_MS && (
                              <button
                                className="d-btn sm"
                                disabled={sbConnecting === u.id} onClick={() => connectSb(u.id)}
                              >
                                {sbConnecting === u.id ? 'Перенаправлення…' : 'Перепідключити'}
                              </button>
                            )}
                            <button
                              className="d-btn sm"
                              disabled={sbBalanceRefreshing === u.id} onClick={() => refreshSbBalances(u.id)}
                            >
                              {sbBalanceRefreshing === u.id ? 'Оновлення…' : 'Оновити баланси'}
                            </button>
                            <button
                              className="d-btn sm"
                              disabled={sbSyncing === u.id} onClick={() => syncSb(u.id)}
                            >
                              {sbSyncing === u.id ? 'Синхронізація…' : 'Синхронізувати'}
                            </button>
                          </>
                        )}
                        <button className="d-btn sm" onClick={() => disconnectSb(u.id, u.name)}>
                          Відключити
                        </button>
                      </div>
                    </div>

                    {/* One consent can cover several real accounts under the
                        same login (e.g. a checking account and a separately-
                        named savings "pillow") — each gets its own row so the
                        user can label it and pick whether ITS transactions
                        feed the budget, independent of the others. */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {sb.accounts.map(a => (
                        <div key={a.id} className="set-acc">
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
                            {sbEditingLabelId === a.id ? (
                              <>
                                <input
                                  className="input-field" style={{ fontSize: 12, padding: '3px 6px', width: 120 }}
                                  value={sbLabelInput} onChange={e => setSbLabelInput(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') saveSbLabel(a.id); if (e.key === 'Escape') setSbEditingLabelId(null); }}
                                  autoFocus
                                />
                                <button className="d-btn sm" disabled={sbSavingLabel} onClick={() => saveSbLabel(a.id)}>OK</button>
                              </>
                            ) : (
                              <>
                                <span style={{ fontWeight: 600, color: 'var(--c-text-sec)' }}>{a.label}</span>
                                <button className="d-round ghost" title="Перейменувати"
                                  onClick={() => { setSbEditingLabelId(a.id); setSbLabelInput(a.label); }}>
                                  <Pencil size={14} />
                                </button>
                              </>
                            )}
                            {a.iban && <span style={{ color: 'var(--c-text-muted)' }}>{a.iban}</span>}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 10px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column' }}>
                              <span style={{ color: 'var(--c-text-sec)' }}>
                                {a.balanceAmount === null ? '—' : fmtBalance(a.balanceAmount, a.balanceCurrency)}
                              </span>
                              <BalanceAge fetchedAt={a.balanceFetchedAt} />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                              <input
                                type="checkbox" checked={a.syncEnabled}
                                disabled={sbAccountToggling === a.id}
                                onChange={e => toggleSbAccountSync(a.id, e.target.checked)}
                              />
                              Синхронізувати
                            </label>
                          </div>
                          {/* Ф2: mark this account as a tracked savings pool
                              (e.g. Подушка -> "Фінансова подушка") — replaces
                              the old guesswork sparebankIngest.ts used to do
                              per-transaction. "—" means an ordinary account. */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                            <span style={{ color: 'var(--c-text-sub)' }}>Це збереження:</span>
                            <select
                              className="input-field" style={{ fontSize: 12, padding: '3px 6px' }}
                              value={a.categoryId ?? ''}
                              disabled={sbAccountToggling === a.id}
                              onChange={e => setSbAccountCategory(a.id, e.target.value ? Number(e.target.value) : null)}
                            >
                              <option value="">—</option>
                              {cats.filter(c => c.type === 'savings' && c.isActive).map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {sbConnected && sb && !sb.expired && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--c-text-sub)', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={sb.autoSync}
                        disabled={sbAutoSyncToggling === u.id}
                        onChange={e => toggleSbAutoSync(u.id, e.target.checked)}
                      />
                      Автосинхронізація (приблизно двічі на добу, коли банк і GitHub встигають)
                    </label>
                    {sb.autoSync && (
                      <span style={{ fontSize: 12, color: sb.autoSyncFailCount > 0 ? 'var(--c-accent-text)' : 'var(--c-text-muted)' }}>
                        {sb.autoSyncFailCount > 0
                          ? `Востаннє успішно: ${sb.lastAutoSyncOkAt ? new Date(sb.lastAutoSyncOkAt).toLocaleString('uk-UA') : 'ще ніколи'}. Не вдалось ${sb.autoSyncFailCount} раз(и) поспіль${sb.lastSyncError ? `: ${sb.lastSyncError}` : ''}`
                          : sb.lastAutoSyncOkAt
                            ? `Востаннє успішно: ${new Date(sb.lastAutoSyncOkAt).toLocaleString('uk-UA')}`
                            : 'Ще не запускалась'}
                      </span>
                    )}
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input
                            className="input-field" type="password" placeholder="Персональний токен Monobank"
                            value={monoTokenInput[u.id] ?? ''}
                            onChange={e => setMonoTokenInput(prev => ({ ...prev, [u.id]: e.target.value }))}
                            style={{ fontSize: 13 }}
                          />
                          <button
                            className="d-btn sm"
                            disabled={monoConnecting === u.id || !monoTokenInput[u.id]?.trim()}
                            onClick={() => connectMono(u.id)}
                          >
                            {monoConnecting === u.id ? 'Підключення…' : 'Підключити'}
                          </button>
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>
                          Токен видається у{' '}
                          <a href="https://api.monobank.ua/" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--c-accent-text)' }}>
                            особистому кабінеті на api.monobank.ua
                          </a>
                        </span>
                        <label style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>
                          Синхронізувати з дати (необов'язково, не більше 30 днів тому):{' '}
                          <input
                            type="date" className="input-field" style={{ fontSize: 12, padding: '3px 6px', width: 'auto', display: 'inline-block' }}
                            value={syncFromDate[u.id] ?? ''}
                            onChange={e => setSyncFromDate(prev => ({ ...prev, [u.id]: e.target.value }))}
                          />
                        </label>
                      </div>
                    )}

                    {choice === 'sparebank' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                      <label style={{ fontSize: 12, color: 'var(--c-text-sub)' }}>
                        Синхронізувати з дати (необов'язково):{' '}
                        <input
                          type="date" className="input-field" style={{ fontSize: 12, padding: '3px 6px', width: 'auto', display: 'inline-block' }}
                          value={syncFromDate[u.id] ?? ''}
                          onChange={e => setSyncFromDate(prev => ({ ...prev, [u.id]: e.target.value }))}
                        />
                      </label>
                      <button
                        className="d-btn sm" style={{ alignSelf: 'flex-start' }}
                        disabled={sbConnecting === u.id}
                        onClick={() => connectSb(u.id)}
                      >
                        {sbConnecting === u.id ? 'Перенаправлення…' : 'Підключити'}
                      </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Import section */}
      <section className="d-card d-pane d-rise" style={vars({ '--i': 5 })}>
        <div className="d-ch"><h2>Імпорт з Excel</h2></div>
        <p className="d-note" style={{ marginBottom: 16 }}>
          Завантажте файл Budget.xlsx — автоматично імпортуються категорії та дані з листів "Планування" і "Ведення".
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleImport} />
          <button className="d-btn" onClick={() => { setImportStatus('idle'); fileRef.current?.value && (fileRef.current.value = ''); fileRef.current?.click(); }} disabled={importStatus === 'loading'}>
            <Upload size={15} />
            {importStatus === 'loading' ? 'Імпорт…' : 'Завантажити файл'}
          </button>
          {importStatus === 'done' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--c-pos-text)', fontSize: 13 }}>
              <CheckCircle size={16} /> Імпортовано успішно
            </div>
          )}
          {importStatus === 'error' && (
            <div style={{ color: 'var(--c-neg-text)', fontSize: 13 }}>Помилка імпорту</div>
          )}
        </div>
      </section>
      </div>

      <div className="set-group" role="group" aria-labelledby="set-g-cat">
        <p className="set-grp" id="set-g-cat">Категорії</p>

      {/* Add category */}
      <section className="d-card d-pane d-rise" style={vars({ '--i': 6 })}>
        <div className="d-ch"><h2>Додати категорію</h2></div>
        <form onSubmit={addCat} className="set-form">
          <div style={{ flex: '1 1 160px' }}>
            <label className="set-lbl">
              Назва
            </label>
            <input className="input-field" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required placeholder="Назва категорії" />
          </div>
          <div style={{ flex: '1 1 120px' }}>
            <label className="set-lbl">Тип</label>
            <select className="input-field" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
              <option value="income">Дохід</option>
              <option value="expense">Витрати</option>
              <option value="savings">Збереження</option>
            </select>
          </div>
          <div>
            <label className="set-lbl">Колір</label>
            <div className="pick-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {CATEGORY_PALETTE.map(c => (
                <button
                  className="pick-swatch"
                  key={c} type="button"
                  onClick={() => setForm(f => ({ ...f, color: c }))}
                  style={{
                    width: 24, height: 24, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                    outline: form.color === c ? '2px solid var(--c-text)' : 'none', outlineOffset: 2,
                  }}
                />
              ))}
            </div>
          </div>
          <button type="submit" className="d-btn"><Plus size={15} /> Додати</button>
          <label style={{ flexBasis: '100%', display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.lockedFromModes} onChange={e => setForm(f => ({ ...f, lockedFromModes: e.target.checked }))} style={{ marginTop: 3 }} />
            <span style={{ fontSize: 14, color: 'var(--c-text-sec)' }}>
              Режими не чіпають цю категорію
              <span className="d-note" style={{ display: 'block' }}>Режим подорожі не переносить сюди витрати</span>
            </span>
          </label>
          <div style={{ flexBasis: '100%' }}>
            <label className="set-lbl">Іконка</label>
            <div className="pick-grid pick-icons" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxHeight: 96, overflowY: 'auto' }}>
              {ICON_KEYS.map(key => (
                <button
                  className="pick-icon"
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
                  <CategoryIcon name={key} color={form.icon === key ? form.color : 'var(--c-text-muted)'} size={15} />
                </button>
              ))}
            </div>
          </div>
        </form>
      </section>

      {/* Categories list */}
      {sections.map(({ type, label, color }, si) => {
        const items = cats.filter(c => c.type === type);
        return (
          <section key={type} className="d-card d-pane d-rise" style={vars({ '--i': 7 + si })}>
            <div className="d-ch">
              <h2>
                <span style={{ color }}>{label}</span>
                <span className="d-note" style={{ marginLeft: 8, fontWeight: 500 }}>({items.length})</span>
              </h2>
            </div>
            {type === 'expense' && <p className="d-note" style={{ margin: '-4px 0 10px' }}>Замок — режими не чіпають категорію: режим подорожі не переносить сюди витрати.</p>}
            {items.length === 0 && <div className="d-empty" style={{ minHeight: 64 }}>Немає категорій</div>}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {items.map(cat => (
                <div key={cat.id} className="set-cat">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                    <button
                      className="d-chip"
                      title="Змінити іконку"
                      onClick={() => { setEditingIconId(editingIconId === cat.id ? null : cat.id); setEditingColorId(null); }}
                      style={{
                        cursor: 'pointer', padding: 0,
                        background: `${cat.color}1A`,
                        border: editingIconId === cat.id ? `1px solid ${cat.color}` : '1px solid transparent',
                      }}
                    >
                      <CategoryIcon name={cat.icon} color={cat.color} size={18} />
                    </button>
                    <button
                      className="hit40"
                      title="Змінити колір"
                      onClick={() => { setEditingColorId(editingColorId === cat.id ? null : cat.id); setEditingIconId(null); }}
                      style={{
                        width: 16, height: 16, borderRadius: '50%', background: cat.color,
                        border: editingColorId === cat.id ? '2px solid var(--c-text)' : '2px solid transparent',
                        cursor: 'pointer', flexShrink: 0, padding: 0,
                      }}
                    />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: 'var(--c-text-sec)', overflowWrap: 'anywhere' }}>{cat.name}</span>
                    {cat.type === 'expense' && (
                      <button
                        className="d-round ghost hit40" type="button" aria-pressed={cat.lockedFromModes}
                        title={`Режими не чіпають цю категорію — ${cat.lockedFromModes ? 'увімкнено' : 'вимкнено'}. Режим подорожі не переносить сюди витрати`}
                        aria-label="Режими не чіпають цю категорію"
                        onClick={() => toggleLocked(cat.id, !cat.lockedFromModes)}
                        style={{ color: cat.lockedFromModes ? 'var(--c-accent-text)' : 'var(--c-text-muted)', opacity: cat.lockedFromModes ? 1 : 0.5 }}
                      >
                        <Lock size={14} />
                      </button>
                    )}
                    <button className="d-round ghost neg" onClick={() => deleteCat(cat.id)} title={`Видалити ${cat.name}`} aria-label={`Видалити ${cat.name}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {editingIconId === cat.id && (
                    <div className="pick-grid pick-icons" style={{ display: 'flex', gap: 6, paddingBottom: 10, paddingLeft: 8, flexWrap: 'wrap', maxHeight: 120, overflowY: 'auto' }}>
                      {ICON_KEYS.map(key => (
                        <button
                          className="pick-icon"
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
                          <CategoryIcon name={key} color={cat.icon === key ? cat.color : 'var(--c-text-muted)'} size={14} />
                        </button>
                      ))}
                    </div>
                  )}
                  {editingColorId === cat.id && (
                    <div className="pick-grid" style={{ display: 'flex', gap: 6, paddingBottom: 10, paddingLeft: 8, flexWrap: 'wrap' }}>
                      {CATEGORY_PALETTE.map(c => (
                        <button
                          className="pick-swatch"
                          key={c} type="button"
                          onClick={() => updateColor(cat.id, c)}
                          style={{
                            width: 22, height: 22, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer',
                            outline: cat.color === c ? '2px solid var(--c-text)' : 'none', outlineOffset: 2,
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      </div>

      <div className="set-group" role="group" aria-labelledby="set-g-look">
        <p className="set-grp" id="set-g-look">Вигляд</p>

      {/* Appearance section */}
      <section className="d-card d-pane d-rise" style={vars({ '--i': 10 })}>
        <div className="d-ch"><h2>Зовнішній вигляд</h2></div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text-sec)', marginBottom: 2 }}>
              {theme === 'dark' ? 'Темна тема' : 'Світла тема'}
            </p>
            <p className="d-note">
              {theme === 'dark' ? 'Перемкнути на світлу' : 'Перемкнути на темну'}
            </p>
          </div>
          <button onClick={toggleTheme} className="d-btn">
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            {theme === 'dark' ? 'Світла' : 'Темна'}
          </button>
        </div>
      </section>

      {/* Dashboard sections visibility */}
      <section className="d-card d-pane d-rise" style={vars({ '--i': 11 })}>
        <div className="d-ch"><h2>Головна сторінка</h2></div>
        <p className="d-note" style={{ marginBottom: 12 }}>
          Які блоки показувати на дашборді (зберігається на цьому пристрої)
        </p>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {(Object.keys(PREF_LABELS) as (keyof DashboardPrefs)[]).map(key => (
            <label key={key} className="set-pref">
              <span style={{ fontSize: 14, color: 'var(--c-text-sec)' }}>{PREF_LABELS[key]}</span>
              <button
                type="button"
                onClick={() => updateSections({ [key]: !dashSections[key] })}
                className={`set-sw${dashSections[key] ? ' on' : ''}`}
                aria-label={`${dashSections[key] ? 'Сховати' : 'Показати'}: ${PREF_LABELS[key]}`}
              >
                {/* transform, not left — animating left triggers a layout
                    reflow every frame; translateX is compositor-only
                    (audit 2026-08-02, same class as the budget-bar fix). */}
                <span />
              </button>
            </label>
          ))}
        </div>
      </section>
      </div>
    </div>
  );
}
