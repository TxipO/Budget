'use client';
import { useState, useEffect, useRef } from 'react';
import { Lock, Send } from 'lucide-react';

interface TelegramUser {
  id: number; first_name: string; last_name?: string; username?: string; photo_url?: string; auth_date: number; hash: string;
}
interface PendingRegistration {
  pendingToken: string;
  firstName: string;
  username: string | null;
}

export default function LoginForm({ nonce, botUsername }: { nonce?: string; botUsername?: string }) {
  const hasTelegram = !!botUsername;
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Registration step — appears after a first-time Telegram login with no
  // linked account yet (see api/auth/telegram's needsRegistration signal).
  const [registration, setRegistration] = useState<PendingRegistration | null>(null);
  const [unlinkedUsers, setUnlinkedUsers] = useState<{ id: number; name: string }[]>([]);
  const [linkChoice, setLinkChoice] = useState(''); // '' = new account, else an existing User.id as string
  const [newName, setNewName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [linkPin, setLinkPin] = useState('');
  const [regBusy, setRegBusy] = useState(false);
  const widgetContainerRef = useRef<HTMLDivElement>(null);

  // React 18 hoists a JSX <script src> tag to <head> as a deduplicated
  // "resource", ignoring its position in the tree. Telegram's widget relies
  // on document.currentScript.parentNode to place its iframe, so the script
  // has to be inserted via raw DOM APIs into this exact container instead.
  useEffect(() => {
    if (!hasTelegram || !botUsername || !widgetContainerRef.current) return;
    const container = widgetContainerRef.current;
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.nonce = nonce ?? ''; // must set the IDL property, not setAttribute — CSP hides the attribute value
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '10');
    script.setAttribute('data-onauth', 'onTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);
    return () => { container.innerHTML = ''; };
  }, [hasTelegram, botUsername, nonce]);

  // The Telegram widget script calls this as a plain global function (its
  // data-onauth="onTelegramAuth(user)" attribute), not a React callback —
  // has to live on window, not just in this component's closure.
  useEffect(() => {
    if (!hasTelegram) return;
    (window as unknown as { onTelegramAuth: (u: TelegramUser) => void }).onTelegramAuth = async (user: TelegramUser) => {
      setError('');
      setBusy(true);
      try {
        const res = await fetch('/api/auth/telegram', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setError(data?.error || 'Помилка входу через Telegram'); return; }
        if (data.needsRegistration) {
          setRegistration({ pendingToken: data.pendingToken, firstName: data.telegramFirstName, username: data.telegramUsername });
          fetch('/api/auth/telegram/unlinked-users').then(r => r.ok ? r.json() : []).then(setUnlinkedUsers).catch(() => {});
        } else {
          window.location.href = '/';
        }
      } catch {
        setError('Помилка з’єднання');
      } finally {
        setBusy(false);
      }
    };
    return () => { delete (window as unknown as { onTelegramAuth?: unknown }).onTelegramAuth; };
  }, [hasTelegram]);

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        setError('Невірний PIN');
        setPin('');
      }
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setBusy(false);
    }
  }

  async function completeRegistration(e: React.FormEvent) {
    e.preventDefault();
    if (!registration || regBusy) return;
    if (!linkChoice && !newName.trim()) { setError("Вкажіть ім'я або оберіть існуючий акаунт"); return; }
    if (linkChoice && !linkPin.trim()) { setError('Введіть PIN, щоб підтвердити, що це ви'); return; }
    setRegBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/telegram/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pendingToken: registration.pendingToken,
          linkToUserId: linkChoice || undefined,
          name: linkChoice ? undefined : newName.trim(),
          email: regEmail.trim() || undefined,
          pin: linkChoice ? linkPin.trim() : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || 'Помилка реєстрації'); return; }
      window.location.href = '/';
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setRegBusy(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
    borderRadius: 20, padding: '40px 36px', width: 320,
  };

  if (registration) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-bg, #0A0A0F)' }}>
        <form onSubmit={completeRegistration} style={cardStyle}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Вітаємо, {registration.firstName}!</div>
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>Це ваш перший вхід через Telegram</div>
          </div>

          {unlinkedUsers.length > 0 && (
            <div style={{ width: '100%' }}>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                Це ви?
              </label>
              <select className="input-field" value={linkChoice} onChange={e => setLinkChoice(e.target.value)}>
                <option value="">— Новий акаунт —</option>
                {unlinkedUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}

          {!linkChoice && (
            <div style={{ width: '100%' }}>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                Ім'я
              </label>
              <input
                className="input-field" value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="Як вас звати" required
              />
            </div>
          )}

          {linkChoice && (
            <div style={{ width: '100%' }}>
              <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                PIN (підтвердіть, що це ви)
              </label>
              <input
                className="input-field" type="password" inputMode="numeric" value={linkPin}
                onChange={e => setLinkPin(e.target.value)}
                placeholder="••••••" style={{ textAlign: 'center', letterSpacing: 6 }} required
              />
            </div>
          )}

          <div style={{ width: '100%' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Email (не обов'язково)
            </label>
            <input
              className="input-field" type="email" value={regEmail} onChange={e => setRegEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>

          {error && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{error}</div>}
          <button type="submit" className="btn-primary" disabled={regBusy} style={{ width: '100%', justifyContent: 'center' }}>
            {regBusy ? 'Збереження…' : 'Продовжити'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--c-bg, #0A0A0F)',
    }}>
      <form onSubmit={submitPin} style={cardStyle}>
        <div style={{
          width: 52, height: 52, borderRadius: 16,
          background: 'linear-gradient(135deg, #F97316, #F59E0B)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Lock size={24} color="white" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Бюджет</div>
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>Введіть PIN для входу</div>
        </div>
        <input
          className="input-field"
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={e => setPin(e.target.value)}
          placeholder="••••••"
          style={{ textAlign: 'center', fontSize: 20, letterSpacing: 6 }}
        />
        {error && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{error}</div>}
        <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Перевірка…' : 'Увійти'}
        </button>

        {hasTelegram && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', color: 'var(--c-text-muted)', fontSize: 12 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
              або
              <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
            </div>
            <div ref={widgetContainerRef} style={{ minHeight: 40, display: 'flex', justifyContent: 'center' }} />
            {busy && (
              <div style={{ fontSize: 12, color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Send size={12} /> Перевірка Telegram…
              </div>
            )}
          </>
        )}
      </form>
    </div>
  );
}
