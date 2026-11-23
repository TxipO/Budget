'use client';
import { useState, useEffect, useRef } from 'react';
import { X, Save } from 'lucide-react';
import { TYPE_LABELS } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useDialogFocus } from './useDialogFocus';

export interface PendingIntent { categoryId: number; scope: 'one' | 'all' }
export interface PendingHold {
  id: string; description: string; amount: number; currency: string; userId: number; bank?: 'mono' | 'sparebank';
  canLearn: boolean; intent: PendingIntent | null;
}
export interface PendingCat { id: number; name: string; type: string; color: string; icon: string }

interface Props {
  hold: PendingHold;
  cats: PendingCat[];
  label: string; // the merchant text as the row shows it
  onClose: () => void;
  onChange: (intent: PendingIntent | null) => void;
  onApplied: () => void; // hold had already settled: refresh dashboard data
}

// Pre-set the category of a Monobank hold / SpareBank reservation that has not settled yet. Nothing is
// recorded now: the choice waits server-side and is applied when the bank
// confirms (monoIngest.ts / sparebankIngest.ts); a declined hold simply drops it.
export default function PendingEditSheet({ hold, cats, label, onClose, onChange, onApplied }: Props) {
  const [categoryId, setCategoryId] = useState(hold.intent ? String(hold.intent.categoryId) : '');
  const [scope, setScope] = useState<'one' | 'all'>(hold.intent?.scope === 'all' && hold.canLearn ? 'all' : 'one');
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/monobank/pending/intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: hold.userId, holdId: hold.id, bank: hold.bank ?? 'mono', categoryId: Number(categoryId), scope }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast(err?.error ?? 'Не вдалося зберегти категорію', 'error');
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.applied) {
        // Hold already settled: the category went straight onto the real transaction, no intent stored.
        onApplied();
        toast('Покупку вже підтверджено — категорію застосовано', 'success');
      } else {
        onChange({ categoryId: Number(categoryId), scope });
        toast('Категорію збережено — застосується після підтвердження банком', 'success');
      }
      onClose();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const res = await fetch(`/api/monobank/pending/intent?userId=${hold.userId}&holdId=${encodeURIComponent(hold.id)}`, { method: 'DELETE' });
      if (!res.ok) { toast('Не вдалося прибрати вибір', 'error'); return; }
      onChange(null);
      onClose();
    } catch {
      toast('Помилка з’єднання', 'error');
    } finally {
      setBusy(false);
    }
  }

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const labelStyle = { fontSize: 12, color: 'var(--c-text-sub)', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' } as const;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Категорія для покупки, що очікує підтвердження"
        className="card-elevated"
        style={{ width: '100%', maxWidth: 460, maxHeight: '90%', display: 'flex', flexDirection: 'column', outline: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="tx-modal-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '28px 28px 20px', flexShrink: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>Категорія покупки</h2>
            <p style={{ fontSize: 13, color: 'var(--c-text-sub)', marginTop: 2, overflowWrap: 'anywhere' }}>{label} · очікує підтвердження банку</p>
          </div>
          <button onClick={onClose} className="btn-ghost" style={{ padding: '6px 8px' }} title="Закрити" aria-label="Закрити"><X size={16} /></button>
        </div>

        <form id="pending-form" onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 28px', overflowY: 'auto', flex: 1 }}>
          <div>
            <label htmlFor="pending-cat" style={labelStyle}>Категорія</label>
            <select id="pending-cat" className="input-field" value={categoryId} onChange={e => setCategoryId(e.target.value)} required>
              <option value="">Оберіть категорію…</option>
              {(['expense', 'income', 'savings'] as const).map(t => (
                <optgroup key={t} label={TYPE_LABELS[t]}>
                  {cats.filter(c => c.type === t).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>

          <div role="group" aria-labelledby="pending-scope-label">
            <div id="pending-scope-label" style={labelStyle}>Застосувати</div>
            <div className="seg">
              <button type="button" aria-pressed={scope === 'one'} aria-label="Тільки ця покупка" onClick={() => setScope('one')}>Тільки ця</button>
              <button type="button" aria-pressed={scope === 'all'} aria-label="Всі такі від цього продавця" disabled={!hold.canLearn} onClick={() => setScope('all')}>Всі від продавця</button>
            </div>
            <p style={{ fontSize: 12, color: 'var(--c-text-sub)', marginTop: 6 }}>
              {!hold.canLearn ? 'Для цього платежу немає назви продавця — правило не створити.'
                : scope === 'all' ? 'Запам\'ятаю правило: наступні покупки в цього продавця отримають цю категорію.'
                : 'Інші покупки та правила не зміняться.'}
            </p>
          </div>
        </form>

        <div className="tx-modal-foot" style={{ padding: '20px 28px 28px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button type="submit" form="pending-form" className="btn-primary" disabled={busy || !categoryId} style={{ width: '100%', justifyContent: 'center' }}>
            <Save size={15} />{busy ? 'Збереження…' : 'Зберегти'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Скасувати</button>
            {hold.intent && <button type="button" className="btn-ghost" disabled={busy} onClick={clear} style={{ flex: 1, justifyContent: 'center' }}>Прибрати вибір</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
