'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plane, X } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useCurrency } from '@/lib/useCurrency';
import { useDialogFocus } from './useDialogFocus';

interface Trip { id: number; name: string; accounts: string[]; startDate: string; endDate: string | null; active: boolean; total: number }
interface AccountOpt { key: string; label: string; pool: boolean }
interface Candidate { id: number; date: string; merchant: string; amount: number; currentCategory: { id: number; name: string }; account: string }

const dm = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}`; // 'YYYY-MM-DD' -> 'DD.MM', no Date (timezone-proof)
const todayUtc = () => new Date().toISOString().slice(0, 10);
const accountsWord = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'рахунок' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'рахунки' : 'рахунків'}`;

const TRIPS_CHANGED = 'trips-changed'; // lets the banner and icon instances on one page stay in sync

// Main-page entry to travel mode. 'banner' (default) shows only the active-trip banner; 'icon' is a small
// plane button shown when no trip is active; 'slot' is the icon on its own right-aligned row.
export default function TravelModeCard({ onChanged, variant = 'banner' }: { onChanged: () => void; variant?: 'banner' | 'icon' | 'slot' }) {
  const { formatMoney } = useCurrency();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [open, setOpen] = useState<{ tripId: number | null; view: 'form' | 'preview' | 'details' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/trips');
      if (!res.ok) return;
      const data = await res.json();
      setTrips(data.trips);
      setAccounts(data.accounts);
    } catch { /* the card simply stays hidden; the rest of the page is unaffected */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    window.addEventListener(TRIPS_CHANGED, load);
    return () => window.removeEventListener(TRIPS_CHANGED, load);
  }, [load]);
  const reload = useCallback(async () => { await load(); window.dispatchEvent(new Event(TRIPS_CHANGED)); }, [load]);

  async function finish(t: Trip) {
    try {
      const res = await fetch(`/api/trips/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) { toast('Не вдалося завершити поїздку', 'error'); return; }
      toast('Поїздку завершено');
      reload();
    } catch {
      toast('Помилка з’єднання', 'error');
    }
  }

  if (trips === null) return null;
  const active = trips.find(t => t.active);
  const iconOnly = variant !== 'banner';

  const dialog = open && (
    <TravelDialog
      trips={trips} accounts={accounts} initial={open} formatMoney={formatMoney}
      onClose={() => setOpen(null)} onReload={reload} onChanged={onChanged}
    />
  );

  if (iconOnly) {
    if (active) return <>{dialog}</>;
    const btn = (
      <button type="button" className="d-round ghost" onClick={() => setOpen({ tripId: null, view: 'form' })} title="Режим подорожі" aria-label="Режим подорожі">
        <Plane size={18} />
      </button>
    );
    return <>{variant === 'slot' ? <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>{btn}</div> : btn}{dialog}</>;
  }

  return (
    <>
      {active ? (
        <div className="d-card" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 18px', marginBottom: 16 }}>
          <button type="button" className="d-chip or" onClick={() => setOpen({ tripId: active.id, view: 'details' })} aria-label="Деталі поїздки" style={{ border: 0, cursor: 'pointer' }}>
            <Plane size={18} />
          </button>
          <div style={{ flex: '1 1 160px', minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>
              ✈ {active.name} · {accountsWord(active.accounts.length)} · {formatMoney(active.total)}
            </div>
            <div className="d-note">{dm(active.startDate)} – {active.endDate ? dm(active.endDate) : 'поки не вимкну'}</div>
          </div>
          <button type="button" className="d-btn" onClick={() => setOpen({ tripId: active.id, view: 'details' })}>Деталі</button>
          <button type="button" className="d-btn" onClick={() => finish(active)}>Завершити</button>
        </div>
      ) : null}
      {dialog}
    </>
  );
}

function TravelDialog({ trips, accounts, initial, formatMoney, onClose, onReload, onChanged }: {
  trips: Trip[]; accounts: AccountOpt[]; initial: { tripId: number | null; view: 'form' | 'preview' | 'details' };
  formatMoney: (n: number) => string; onClose: () => void; onReload: () => Promise<void>; onChanged: () => void;
}) {
  const [view, setView] = useState(initial.view);
  const [tripId, setTripId] = useState(initial.tripId);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // form
  const [name, setName] = useState('');
  const [start, setStart] = useState(todayUtc());
  const [end, setEnd] = useState('');
  const [picked, setPicked] = useState<string[]>(() => []);
  // preview
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  const trip = trips.find(t => t.id === tripId) ?? null;
  const labelOf = (key: string) => accounts.find(a => a.key === key)?.label ?? key;

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadPreview = useCallback(async (id: number) => {
    setCands(null);
    try {
      const res = await fetch(`/api/trips/${id}/preview`);
      if (!res.ok) { toast('Не вдалося завантажити перегляд', 'error'); setCands([]); return; }
      const rows: Candidate[] = await res.json();
      setCands(rows);
      setChecked(new Set(rows.map(r => r.id)));
    } catch {
      toast('Помилка з’єднання', 'error');
      setCands([]);
    }
  }, []);
  useEffect(() => { if (view === 'preview' && tripId !== null) loadPreview(tripId); }, [view, tripId, loadPreview]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/trips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, startDate: start, endDate: end || null, accounts: picked }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error ?? 'Не вдалося створити поїздку', 'error'); return; }
      await onReload();
      // Past start date: there may be rows to move — show them before anything is written.
      if (start <= todayUtc()) { setTripId(data.id); setView('preview'); }
      else { toast('Поїздку створено'); onClose(); }
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (tripId === null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(checked) }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { toast(data?.error ?? 'Не вдалося застосувати', 'error'); return; }
      toast(`Перенесено в «Подорожі»: ${data.count}`);
      await onReload();
      onChanged();
      onClose();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (tripId === null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/trips/${tripId}`, { method: 'DELETE' });
      if (!res.ok) { toast('Не вдалося видалити поїздку', 'error'); return; }
      toast('Поїздку видалено, категорії повернуто');
      await onReload();
      onChanged();
      onClose();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setBusy(false);
    }
  }

  const labelStyle = { fontSize: 12, color: 'var(--c-text-sub)', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' } as const;
  const title = view === 'form' ? 'Режим подорожі' : view === 'preview' ? 'Перенести в «Подорожі»' : (trip?.name ?? 'Поїздка');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className="card-elevated"
        style={{ width: '100%', maxWidth: 520, maxHeight: '90%', display: 'flex', flexDirection: 'column', outline: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="tx-modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '28px 28px 16px', flexShrink: 0 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>✈ {title}</h2>
          <button onClick={onClose} className="btn-ghost" style={{ padding: '6px 8px' }} title="Закрити" aria-label="Закрити"><X size={16} /></button>
        </div>

        {view === 'form' && (
          <form onSubmit={create} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 28px 28px', overflowY: 'auto' }}>
            <p className="d-note">Нові витрати з обраних рахунків, чий продавець вам ще невідомий, підуть у «Подорожі». Вже знайомі продавці та захищені категорії не змінюються.</p>
            <div>
              <label htmlFor="trip-name" style={labelStyle}>Назва</label>
              <input id="trip-name" className="input-field" value={name} onChange={e => setName(e.target.value)} maxLength={60} required placeholder="Наприклад, Варшава" />
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 140px' }}>
                <label htmlFor="trip-start" style={labelStyle}>Початок</label>
                <input id="trip-start" type="date" className="input-field" value={start} onChange={e => setStart(e.target.value)} required />
              </div>
              <div style={{ flex: '1 1 140px' }}>
                <label htmlFor="trip-end" style={labelStyle}>Кінець</label>
                <input id="trip-end" type="date" className="input-field" value={end} min={start} onChange={e => setEnd(e.target.value)} />
                <span className="d-note">{end ? '' : 'Порожньо — поки не вимкну'}</span>
              </div>
            </div>
            <div role="group" aria-labelledby="trip-acc-label">
              <div id="trip-acc-label" style={labelStyle}>Рахунки</div>
              {accounts.length === 0 && <p className="d-note">Немає підключених банківських рахунків.</p>}
              {accounts.map(a => (
                <label key={a.key} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, fontSize: 14, color: 'var(--c-text-sec)', cursor: 'pointer' }}>
                  <input
                    type="checkbox" checked={picked.includes(a.key)}
                    onChange={e => setPicked(p => e.target.checked ? [...p, a.key] : p.filter(k => k !== a.key))}
                  />
                  <span>{a.label}{a.pool ? ' (накопичення)' : ''}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="btn-primary" disabled={busy || !name.trim() || picked.length === 0} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? 'Створення…' : 'Створити'}
            </button>
            {trips.length > 0 && (
              <div>
                <div style={labelStyle}>Попередні поїздки</div>
                {trips.map(t => (
                  <button key={t.id} type="button" className="btn-ghost" onClick={() => { setTripId(t.id); setView('details'); }}
                    style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                    <span style={{ overflowWrap: 'anywhere', textAlign: 'left' }}>{t.name} · {dm(t.startDate)}–{t.endDate ? dm(t.endDate) : '…'}</span>
                    <span>{formatMoney(t.total)}</span>
                  </button>
                ))}
              </div>
            )}
          </form>
        )}

        {view === 'details' && trip && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 28px 28px', overflowY: 'auto' }}>
            <div className="d-note">
              {trip.startDate.split('-').reverse().join('.')} – {trip.endDate ? trip.endDate.split('-').reverse().join('.') : 'поки не вимкну'}
              <br />{trip.accounts.map(labelOf).join(', ')}
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--c-text)' }}>{formatMoney(trip.total)}</div>
            <button type="button" className="btn-ghost" style={{ justifyContent: 'center' }} onClick={() => setView('preview')}>Перенести минулі витрати…</button>
            {!confirmDelete ? (
              <button type="button" className="btn-ghost" style={{ justifyContent: 'center', color: 'var(--c-neg-text)' }} onClick={() => setConfirmDelete(true)}>Видалити поїздку</button>
            ) : (
              <div role="alert" style={{ border: '1px solid var(--c-neg-text)', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--c-text-sec)' }}>Усі перенесені витрати повернуться у свої попередні категорії. Ті, що ви змінили вручну, залишаться як є.</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setConfirmDelete(false)}>Скасувати</button>
                  <button type="button" className="btn-primary" disabled={busy} style={{ flex: 1, justifyContent: 'center' }} onClick={remove}>{busy ? 'Видалення…' : 'Так, видалити'}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'preview' && (
          <>
            <div style={{ padding: '0 28px', overflowY: 'auto', flex: 1 }}>
              {cands === null && <p className="d-note">Завантаження…</p>}
              {cands !== null && cands.length === 0 && <p className="d-note">Немає витрат, які підпадають під правило.</p>}
              {cands !== null && cands.length > 0 && (
                <>
                  <p className="d-note" style={{ marginBottom: 8 }}>Знайомі продавці та захищені категорії не показані. Знімайте галочки з того, що переносити не треба.</p>
                  {cands.map(c => (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--c-border)', cursor: 'pointer' }}>
                      <input
                        type="checkbox" style={{ marginTop: 4 }} checked={checked.has(c.id)}
                        onChange={e => setChecked(prev => { const n = new Set(prev); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{c.merchant || 'Без опису'}</span>
                        <span className="d-note">{dm(c.date)} · було: {c.currentCategory.name} · {c.account}</span>
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)', whiteSpace: 'nowrap' }}>{formatMoney(c.amount)}</span>
                    </label>
                  ))}
                </>
              )}
            </div>
            <div className="tx-modal-foot" style={{ padding: '16px 28px 28px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cands !== null && cands.length > 0 && (
                <button type="button" className="btn-primary" disabled={busy || checked.size === 0} onClick={apply} style={{ width: '100%', justifyContent: 'center' }}>
                  {busy ? 'Застосування…' : `Застосувати (${checked.size})`}
                </button>
              )}
              <button type="button" className="btn-ghost" onClick={onClose} style={{ width: '100%', justifyContent: 'center' }}>{cands && cands.length > 0 ? 'Пропустити' : 'Закрити'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
