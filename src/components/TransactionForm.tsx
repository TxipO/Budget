'use client';
import { useState, useEffect } from 'react';
import { X, Save, Plus, EyeOff } from 'lucide-react';
import { TYPE_LABELS } from '@/lib/utils';
import { useCurrency } from '@/lib/useCurrency';
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
  // Only meaningful when type === 'savings' — see Transaction.savingsWithdrawal's
  // schema comment. false ("Внесок") is the default: money set aside,
  // reduces available balance, same as "savings" always meant before this
  // existed. true ("Зняття") is money coming back out of the pot — increases
  // available balance instead of double-subtracting it.
  savingsWithdrawal: boolean;
  // Manual "не рахувати в загальний баланс" toggle — same field the
  // automatic transfer/pre-accounted-elsewhere detection already sets (see
  // Transaction.isTransfer's schema comment), just settable by hand here.
  isTransfer: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

export default function TransactionForm({ onClose, onSaved, initial, editId }: Props) {
  const [form, setForm] = useState<TxForm>({
    date: today(), type: 'expense', categoryId: '', amount: '',
    details: '', userId: '', savingsWithdrawal: false, isTransfer: false, ...initial,
  });
  const [cats, setCats] = useState<Category[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);
  const { formatMoney } = useCurrency();

  // "Лише ця / Усі від мерчанта" — see GET /api/transactions/[id]/sweep-preview.
  // Set when saving an edited synced transaction's changed category would
  // otherwise touch other rows or overwrite a learned rule; the user picks,
  // then Save is pressed again.
  interface ScopeChoice { siblings: number; existingRule: { categoryName: string } | null; merchantLabel: string | null; defaultScope: 'one' | 'merchant' }
  const [scopeChoice, setScopeChoice] = useState<ScopeChoice | null>(null);
  const [scope, setScope] = useState<'one' | 'merchant'>('one');

  // Multi-amount entry ("100 + 200 + 500" -> one 800 transaction) — each
  // confirmed part sits here, the amount field itself holds only the part
  // not yet added.
  const [amountParts, setAmountParts] = useState<number[]>([]);

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

  const currentInputAmount = parseFloat(form.amount) || 0;
  const totalAmount = amountParts.reduce((a, b) => a + b, 0) + currentInputAmount;

  // oldPrefix/newPrefix are both derived once, synchronously, from the
  // render-time `amountParts` — never from a ref mutated after scheduling
  // the state update. A ref written on the line right after setForm() looks
  // fine but isn't: setForm's functional updater runs later (React's actual
  // render pass), by which point the ref already held the NEW value —
  // "find the old prefix to strip" would silently strip the new one instead,
  // corrupting the breakdown on every second-and-later add/remove. Verified
  // live: 100+200+500 came out as "100+200+100+200100+200+100100+200100".
  // Deriving both prefixes from plain closure state sidesteps the ordering
  // question entirely — no timing to get wrong.
  function applyParts(newParts: number[], oldPrefix: string, clearAmountInput: boolean) {
    const newPrefix = newParts.join('+');
    setAmountParts(newParts);
    setForm(f => {
      const userText = f.details.startsWith(oldPrefix) ? f.details.slice(oldPrefix.length) : f.details;
      const separator = userText.trim() ? ' — ' : '';
      return { ...f, amount: clearAmountInput ? '' : f.amount, details: (newPrefix ? newPrefix + separator : '') + userText };
    });
  }

  function addAmountPart() {
    const val = parseFloat(form.amount);
    if (!Number.isFinite(val) || val <= 0) return;
    applyParts([...amountParts, val], amountParts.join('+'), true);
  }

  function removeAmountPart(idx: number) {
    applyParts(amountParts.filter((_, i) => i !== idx), amountParts.join('+'), false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (totalAmount <= 0) { toast('Сума має бути більше 0', 'error'); return; }
    setSaving(true);
    try {
      // Decide the scope for an edit that changes the category. Preview
      // failing must never block saving or silently sweep — fall back to the
      // safe direction ('one': only this row, no rule change).
      let scopeToSend: 'one' | 'merchant' | undefined;
      if (editId && form.categoryId !== initial?.categoryId) {
        if (scopeChoice) {
          scopeToSend = scope;
        } else {
          const pv = await fetch(`/api/transactions/${editId}/sweep-preview?categoryId=${form.categoryId}`)
            .then(r => r.ok ? r.json() : null).catch(() => null);
          if (!pv) {
            scopeToSend = 'one';
            toast('Не вдалося перевірити інші транзакції мерчанта — змінено лише цю', 'info');
          } else if (pv.applicable && pv.needsChoice) {
            setScopeChoice({ siblings: pv.siblings, existingRule: pv.existingRule, merchantLabel: pv.merchantLabel, defaultScope: pv.defaultScope });
            setScope(pv.defaultScope);
            setSaving(false);
            return;
          } else {
            // Nothing to damage (no siblings, no rule to overwrite): a
            // brand-new merchant just learns the rule, like before.
            scopeToSend = pv.applicable ? 'merchant' : 'one';
          }
        }
      }
      const url    = editId ? `/api/transactions/${editId}` : '/api/transactions';
      const method = editId ? 'PUT' : 'POST';
      // Fold a still-unconfirmed amount into the breakdown too, but only
      // once the user has actually used "+" at least once — otherwise every
      // ordinary single-amount entry would get a pointless "500" prefix
      // stamped into its comment just for typing a number and hitting Save.
      const finalParts = amountParts.length > 0 && currentInputAmount > 0
        ? [...amountParts, currentInputAmount] : amountParts;
      const oldPrefix = amountParts.join('+');
      const userText = form.details.startsWith(oldPrefix) ? form.details.slice(oldPrefix.length) : form.details;
      const separator = userText.trim() ? ' — ' : '';
      const finalDetails = finalParts.length > 0 ? finalParts.join('+') + separator + userText : userText;
      const payload = { ...form, amount: String(totalAmount), details: finalDetails, ...(scopeToSend ? { scope: scopeToSend } : {}) };
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(await res.text());
      // retroactiveCount/sweep (PUT only) — only present when the user chose
      // "all from this merchant": every OTHER row of the same merchant under
      // the old category moved too. Surface that, with a real "Скасувати"
      // (revert-sweep) so a correction never does more than the user meant.
      const result = editId ? await res.json().catch(() => null) : null;
      const retroactiveCount: number = result?.retroactiveCount ?? 0;
      const sweep = result?.sweep;
      const primaryId = editId;
      toast(
        editId
          ? retroactiveCount > 0 ? `Транзакцію оновлено, також виправлено ще ${retroactiveCount}` : 'Транзакцію оновлено'
          : 'Транзакцію додано',
        'success',
        sweep && primaryId ? {
          label: 'Скасувати для решти',
          onClick: async () => {
            try {
              const undo = await fetch('/api/transactions/revert-sweep', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ primaryId, ...sweep }),
              });
              if (!undo.ok) { toast('Не вдалося скасувати', 'error'); return; }
              toast('Скасовано — змінено лише цю транзакцію', 'info');
              onSaved();
            } catch {
              toast('Помилка з’єднання', 'error');
            }
          },
        } : undefined,
        sweep ? 10000 : undefined,
      );
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
        // % of .modal-overlay (position:fixed;inset:0), not vh — vh is
        // computed against the layout viewport, which on real mobile
        // Chrome (confirmed live: Android, address bar expanded) is
        // taller than what's actually visible once the address bar and
        // gesture nav are accounted for. That gap was exactly enough to
        // push the Save button off-screen with no way to scroll to it.
        // A fixed-position ancestor's percentage height tracks the real
        // visible viewport correctly, no dvh/svh browser-support gamble
        // needed.
        style={{ width: '100%', maxWidth: 460, maxHeight: '90%', display: 'flex', flexDirection: 'column' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '28px 28px 20px', flexShrink: 0 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--c-text)' }}>
            {editId ? 'Редагувати' : 'Нова транзакція'}
          </h2>
          <button onClick={onClose} className="btn-ghost" style={{ padding: '6px 8px' }} title="Закрити" aria-label="Закрити">
            <X size={16} />
          </button>
        </div>

        <form id="tx-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 28px', overflowY: 'auto', flex: 1 }}>
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
                  onClick={() => { setScopeChoice(null); setForm(f => ({ ...f, type: t, categoryId: '' })); }}
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
              onChange={e => { setScopeChoice(null); setForm(f => ({ ...f, categoryId: e.target.value })); }}
              required
            >
              <option value="">Оберіть категорію…</option>
              {filteredCats.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Savings direction — only matters for the "savings" type. Внесок
              (deposit) sets money aside and reduces available balance, same
              as "savings" always meant. Зняття (withdrawal) is money coming
              back out of the pot — increases available balance instead of
              double-subtracting it (see Transaction.savingsWithdrawal). */}
          {form.type === 'savings' && (
            <div>
              <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Напрямок
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {([{ v: false, label: 'Внесок' }, { v: true, label: 'Зняття' }] as const).map(opt => (
                  <button
                    key={String(opt.v)} type="button"
                    onClick={() => setForm(f => ({ ...f, savingsWithdrawal: opt.v }))}
                    style={{
                      flex: 1, padding: '8px 4px', borderRadius: 8, border: 'none',
                      cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.15s',
                      background: form.savingsWithdrawal === opt.v ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.04)',
                      color: form.savingsWithdrawal === opt.v ? '#FCD34D' : '#64748B',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Amount */}
          <div>
            <label style={{ fontSize: 12, color: '#64748B', fontWeight: 600, marginBottom: 6, display: 'block', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Сума (kr){amountParts.length > 0 ? ` — усього ${formatMoney(totalAmount)}` : ''}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="number" className="input-field" placeholder="0"
                value={form.amount} min={0} step="0.01"
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAmountPart(); } }}
                required={amountParts.length === 0}
                style={{ flex: 1 }}
              />
              <button
                type="button" onClick={addAmountPart}
                title="Додати ще одну суму до цієї ж транзакції"
                className="btn-ghost"
                style={{ padding: '0 14px', flexShrink: 0 }}
                disabled={!form.amount || currentInputAmount <= 0}
              >
                <Plus size={16} />
              </button>
            </div>
            {amountParts.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {amountParts.map((part, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      background: 'rgba(255,255,255,0.06)', color: 'var(--c-text-sec)',
                      borderRadius: 8, padding: '4px 6px 4px 10px', fontSize: 12,
                    }}
                  >
                    {formatMoney(part)}
                    <button
                      type="button" onClick={() => removeAmountPart(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748B', padding: 2, display: 'flex' }}
                      title="Прибрати суму" aria-label="Прибрати суму"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
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

          {/* Manual exclude-from-totals toggle — same Transaction.isTransfer
              field the automatic transfer/pre-accounted-elsewhere detection
              already sets (see its schema comment), just user-settable here
              for whatever case doesn't fit either automatic rule. */}
          <div>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, isTransfer: !f.isTransfer }))}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                padding: '10px 4px', borderRadius: 8, border: 'none', cursor: 'pointer',
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit', transition: 'all 0.15s',
                background: form.isTransfer ? 'rgba(100,116,139,0.25)' : 'rgba(255,255,255,0.04)',
                color: form.isTransfer ? 'var(--c-text-sec)' : '#64748B',
              }}
            >
              <EyeOff size={15} />
              Не рахувати в загальний баланс
            </button>
            {form.isTransfer && (
              <p style={{ fontSize: 11, color: '#64748B', marginTop: 6, textAlign: 'center' }}>
                Транзакція лишиться у списку, але не увійде в жодну суму — дохід, витрати, збереження, накопичений залишок.
              </p>
            )}
          </div>
        </form>

        <div style={{ padding: '20px 28px 28px', flexShrink: 0 }}>
          {/* Lives in the footer (not the scrolling form) so it can never be
              off-screen when Save is pressed — the modal is a bottom sheet
              on mobile with the form area shrinking to fit. */}
          {scopeChoice && (
            <div role="radiogroup" aria-label="Як застосувати зміну категорії" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 13, color: 'var(--c-text-sec)', fontWeight: 600 }}>
                {scopeChoice.merchantLabel ? `«${scopeChoice.merchantLabel}»` : 'Цей мерчант'} — як застосувати?
              </div>
              {([
                { v: 'one' as const, title: 'Лише ця транзакція', sub: 'Інші та правило не зміняться' },
                {
                  v: 'merchant' as const,
                  title: `Усі від цього мерчанта${scopeChoice.siblings > 0 ? ` (ще ${scopeChoice.siblings})` : ''} і надалі`,
                  sub: scopeChoice.existingRule ? `Змінить і правило: зараз «${scopeChoice.existingRule.categoryName}»` : 'Запам’ятає категорію для майбутніх',
                },
              ]).map(opt => (
                <button
                  key={opt.v} type="button" role="radio" aria-checked={scope === opt.v}
                  onClick={() => setScope(opt.v)}
                  style={{
                    textAlign: 'left', padding: '12px 14px', minHeight: 44, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${scope === opt.v ? '#F97316' : 'var(--c-border-hi)'}`,
                    background: scope === opt.v ? 'rgba(249,115,22,0.12)' : 'rgba(255,255,255,0.04)',
                    color: 'var(--c-text)', display: 'flex', flexDirection: 'column', gap: 2,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{opt.title}</span>
                  <span style={{ fontSize: 12, color: 'var(--c-text-muted)' }}>{opt.sub}</span>
                </button>
              ))}
            </div>
          )}
          <button type="submit" form="tx-form" className="btn-primary" disabled={saving} style={{ width: '100%', justifyContent: 'center' }}>
            <Save size={15} />
            {saving ? 'Збереження…' : 'Зберегти'}
          </button>
        </div>
      </div>
    </div>
  );
}
