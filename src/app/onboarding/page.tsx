'use client';
import { useEffect, useState } from 'react';
import { Plus, Trash2, ArrowRight, ArrowLeft, Check, Lock, Landmark } from 'lucide-react';
import { CATEGORY_PALETTE, TYPE_LABELS } from '@/lib/utils';
import { CURRENCIES } from '@/lib/currencies';
import { ICON_KEYS } from '@/lib/icons';
import { DEFAULT_CATEGORIES, type DefaultCategory } from '@/lib/defaultCategories';
import CategoryIcon from '@/components/CategoryIcon';
import { toast } from '@/lib/toast';

type Step = 'users' | 'categories' | 'settings';
type CatType = 'income' | 'expense' | 'savings';

const TYPE_ORDER: CatType[] = ['income', 'expense', 'savings'];

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>('users');
  const [error, setError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [selfUserId, setSelfUserId] = useState<number | null>(null);

  // Step 1 — users
  const [selfName, setSelfName] = useState('');
  const [addSecondUser, setAddSecondUser] = useState(false);
  const [secondUserName, setSecondUserName] = useState('');
  const [currency, setCurrency] = useState('NOK');

  // Step 2 — categories
  const [categories, setCategories] = useState<DefaultCategory[]>(DEFAULT_CATEGORIES);
  const [editingColorIdx, setEditingColorIdx] = useState<number | null>(null);
  const [editingIconIdx, setEditingIconIdx] = useState<number | null>(null);
  const [newCatName, setNewCatName] = useState('');
  const [newCatType, setNewCatType] = useState<CatType>('expense');

  // Step 3 — PIN + Monobank
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [monoToken, setMonoToken] = useState('');

  // Prefill self's name from whatever they registered with (a real
  // household name for a brand-new household, or the Telegram first name).
  useEffect(() => {
    fetch('/api/account/me').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.user) { setSelfName(data.user.name); setSelfUserId(data.user.id); }
    }).catch(() => {});
  }, []);

  function removeCategory(idx: number) {
    setCategories(cs => cs.filter((_, i) => i !== idx));
    setEditingColorIdx(null);
    setEditingIconIdx(null);
  }
  function updateCategory(idx: number, patch: Partial<DefaultCategory>) {
    setCategories(cs => cs.map((c, i) => i === idx ? { ...c, ...patch } : c));
  }
  function addCategory() {
    const name = newCatName.trim();
    if (!name) return;
    if (categories.some(c => c.type === newCatType && c.name === name)) {
      toast('Така категорія вже є', 'error');
      return;
    }
    setCategories(cs => [...cs, { name, type: newCatType, color: CATEGORY_PALETTE[cs.length % CATEGORY_PALETTE.length], icon: 'circle' }]);
    setNewCatName('');
  }

  function goToCategories() {
    setError('');
    if (!selfName.trim()) { setError("Вкажіть ваше ім'я"); return; }
    if (addSecondUser && !secondUserName.trim()) { setError("Вкажіть ім'я другого користувача"); return; }
    setStep('categories');
  }
  function goToSettings() {
    setError('');
    if (categories.length === 0) { setError('Додайте хоча б одну категорію'); return; }
    setStep('settings');
  }

  async function finish() {
    setError('');
    if (pin && !/^\d{4,8}$/.test(pin)) { setError('PIN — від 4 до 8 цифр'); return; }
    if (pin && pin !== pinConfirm) { setError('PIN не збігається'); return; }
    setFinishing(true);
    try {
      const res = await fetch('/api/onboarding/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selfName: selfName.trim(),
          secondUserName: addSecondUser ? secondUserName.trim() : '',
          categories,
          currency,
          pin: pin || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || 'Помилка завершення налаштування'); return; }

      // Best-effort — a failed Monobank connect shouldn't block finishing
      // onboarding (household/categories/PIN are already committed by this
      // point); the user can just connect it later from Settings.
      const token = monoToken.trim();
      if (token && selfUserId) {
        try {
          const monoRes = await fetch('/api/monobank/connect', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: selfUserId, token }),
          });
          if (!monoRes.ok) {
            const monoData = await monoRes.json().catch(() => null);
            toast(monoData?.error || 'Не вдалося підключити Monobank — спробуйте пізніше в Налаштуваннях', 'error');
          }
        } catch {
          toast('Не вдалося підключити Monobank — спробуйте пізніше в Налаштуваннях', 'error');
        }
      }

      window.location.href = '/';
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setFinishing(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
    borderRadius: 20, padding: '32px 32px', width: 460, maxWidth: '92vw',
    maxHeight: '86vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column', gap: 18,
  };
  const stepLabel = { users: '1 з 3 — Хто ви', categories: '2 з 3 — Категорії', settings: '3 з 3 — Базові налаштування' }[step];

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-bg, #0A0A0F)', padding: 16, overflowY: 'auto' }}>
      <div style={cardStyle}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--c-accent-text)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{stepLabel}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--c-text)', marginTop: 4 }}>
            {step === 'users' && 'Налаштуємо ваш акаунт'}
            {step === 'categories' && 'Оберіть категорії'}
            {step === 'settings' && 'Останні штрихи'}
          </div>
        </div>

        {step === 'users' && (
          <>
            <div>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Ваше ім'я</label>
              <input className="input-field" value={selfName} onChange={e => setSelfName(e.target.value)} placeholder="Як вас звати" autoFocus />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--c-text-sec)', cursor: 'pointer' }}>
              <input type="checkbox" checked={addSecondUser} onChange={e => setAddSecondUser(e.target.checked)} />
              У бюджеті буде ще одна людина
            </label>
            {addSecondUser && (
              <div>
                <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Ім'я другої людини</label>
                <input className="input-field" value={secondUserName} onChange={e => setSecondUserName(e.target.value)} placeholder="Наприклад, ім'я партнера" />
              </div>
            )}
            <div>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Валюта бюджету</label>
              <select className="input-field" value={currency} onChange={e => setCurrency(e.target.value)}>
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
          </>
        )}

        {step === 'categories' && (
          <>
            <p style={{ fontSize: 13, color: 'var(--c-text-muted)', margin: 0 }}>
              Рекомендований набір — перейменуйте, приберіть зайве або додайте своє. Колір і іконку можна змінити тапом.
            </p>
            {TYPE_ORDER.map(type => {
              const items = categories.map((c, i) => ({ ...c, idx: i })).filter(c => c.type === type);
              if (items.length === 0) return null;
              return (
                <div key={type}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text-sec)', marginBottom: 6 }}>{TYPE_LABELS[type]}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {items.map(cat => (
                      <div key={cat.idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                          <button
                            type="button" title="Змінити іконку"
                            onClick={() => { setEditingIconIdx(editingIconIdx === cat.idx ? null : cat.idx); setEditingColorIdx(null); }}
                            style={{
                              width: 26, height: 26, borderRadius: 8, flexShrink: 0, cursor: 'pointer',
                              background: `${cat.color}1A`, border: editingIconIdx === cat.idx ? `1px solid ${cat.color}` : '1px solid transparent',
                              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                            }}
                          >
                            <CategoryIcon name={cat.icon} color={cat.color} size={14} />
                          </button>
                          <button
                            type="button" title="Змінити колір"
                            onClick={() => { setEditingColorIdx(editingColorIdx === cat.idx ? null : cat.idx); setEditingIconIdx(null); }}
                            style={{
                              width: 14, height: 14, borderRadius: '50%', background: cat.color,
                              border: editingColorIdx === cat.idx ? '2px solid white' : '2px solid transparent',
                              cursor: 'pointer', flexShrink: 0, padding: 0,
                            }}
                          />
                          <input
                            value={cat.name}
                            onChange={e => updateCategory(cat.idx, { name: e.target.value })}
                            style={{ flex: 1, fontSize: 13, color: 'var(--c-text-sec)', background: 'none', border: 'none', outline: 'none' }}
                          />
                          <button type="button" onClick={() => removeCategory(cat.idx)} className="btn-ghost" style={{ padding: '3px 5px', border: 'none', color: '#EF4444' }} title="Прибрати категорію" aria-label="Прибрати категорію">
                            <Trash2 size={12} />
                          </button>
                        </div>
                        {editingIconIdx === cat.idx && (
                          <div style={{ display: 'flex', gap: 5, paddingBottom: 8, paddingLeft: 24, flexWrap: 'wrap', maxHeight: 100, overflowY: 'auto' }}>
                            {ICON_KEYS.map(key => (
                              <button
                                key={key} type="button" onClick={() => updateCategory(cat.idx, { icon: key })} title={key}
                                style={{
                                  width: 24, height: 24, borderRadius: 7, cursor: 'pointer',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  background: cat.icon === key ? `${cat.color}22` : 'var(--c-hover)',
                                  border: cat.icon === key ? `1px solid ${cat.color}` : '1px solid transparent',
                                }}
                              >
                                <CategoryIcon name={key} color={cat.icon === key ? cat.color : '#94A3B8'} size={12} />
                              </button>
                            ))}
                          </div>
                        )}
                        {editingColorIdx === cat.idx && (
                          <div style={{ display: 'flex', gap: 5, paddingBottom: 8, paddingLeft: 24, flexWrap: 'wrap' }}>
                            {CATEGORY_PALETTE.map(c => (
                              <button
                                key={c} type="button" onClick={() => updateCategory(cat.idx, { color: c })}
                                style={{ width: 18, height: 18, borderRadius: '50%', background: c, border: 'none', cursor: 'pointer', outline: cat.color === c ? '2px solid white' : 'none', outlineOffset: 2 }}
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
            <div style={{ display: 'flex', gap: 6 }}>
              <select className="input-field" value={newCatType} onChange={e => setNewCatType(e.target.value as CatType)} style={{ width: 110, flexShrink: 0 }}>
                <option value="income">Дохід</option>
                <option value="expense">Витрати</option>
                <option value="savings">Збереження</option>
              </select>
              <input
                className="input-field" value={newCatName} onChange={e => setNewCatName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }}
                placeholder="Нова категорія" style={{ flex: 1 }}
              />
              <button type="button" onClick={addCategory} className="btn-ghost" style={{ padding: '8px 10px' }}>
                <Plus size={14} />
              </button>
            </div>
          </>
        )}

        {step === 'settings' && (
          <>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-sec)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Lock size={14} /> PIN-замок (рекомендовано)
              </div>
              <p style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 0, marginBottom: 8 }}>
                Додатковий захист поверх входу — застосунок проситиме PIN навіть у межах активної сесії. Можна пропустити й додати пізніше в Налаштуваннях.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input-field" type="password" inputMode="numeric" value={pin}
                  onChange={e => setPin(e.target.value)} placeholder="Новий PIN" style={{ textAlign: 'center', letterSpacing: 4 }}
                />
                <input
                  className="input-field" type="password" inputMode="numeric" value={pinConfirm}
                  onChange={e => setPinConfirm(e.target.value)} placeholder="Ще раз" style={{ textAlign: 'center', letterSpacing: 4 }}
                />
              </div>
            </div>

            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-text-sec)', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Landmark size={14} /> Monobank (опційно)
              </div>
              <p style={{ fontSize: 12, color: 'var(--c-text-muted)', marginTop: 0, marginBottom: 8 }}>
                Токен з api.monobank.ua — транзакції підтягуватимуться автоматично. Можна пропустити.
              </p>
              <input
                className="input-field" value={monoToken} onChange={e => setMonoToken(e.target.value)}
                placeholder="Токен Monobank"
              />
            </div>
          </>
        )}

        {error && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between' }}>
          {step !== 'users' ? (
            <button
              type="button" className="btn-ghost"
              onClick={() => setStep(step === 'categories' ? 'users' : 'categories')}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <ArrowLeft size={14} /> Назад
            </button>
          ) : <span />}

          {step === 'users' && (
            <button type="button" className="btn-primary" onClick={goToCategories} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Далі <ArrowRight size={14} />
            </button>
          )}
          {step === 'categories' && (
            <button type="button" className="btn-primary" onClick={goToSettings} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Далі <ArrowRight size={14} />
            </button>
          )}
          {step === 'settings' && (
            <button type="button" className="btn-primary" disabled={finishing} onClick={finish} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {finishing ? 'Завершення…' : <>Готово <Check size={14} /></>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
