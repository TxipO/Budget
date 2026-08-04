'use client';
import { useState, useEffect, useRef } from 'react';
import { Lock, Send, Mail } from 'lucide-react';

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
  // PIN login is exclusive to household #1 (Паша/Женя) — every other
  // visitor on this shared public /login page is registering fresh via
  // Telegram/email and has no PIN at all. The page can't know in advance
  // which kind of visitor this is (no session exists yet), so instead of
  // guessing, PIN is a collapsed secondary option rather than the first,
  // most prominent thing shown — found live: a new registrant saw the PIN
  // box as the primary screen and assumed the app required one.
  const [showPin, setShowPin] = useState(false);

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

  // Email magic-link flow — a separate state machine from the Telegram one
  // above (they can't collide: a Telegram login resolves synchronously in
  // this tab, an email one round-trips through the user's inbox and comes
  // back as a fresh page load with query params set by /api/auth/magic-link/verify).
  const [emailStep, setEmailStep] = useState<'idle' | 'sent' | 'register'>('idle');
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [pendingEmailToken, setPendingEmailToken] = useState('');
  const [pendingEmailAddress, setPendingEmailAddress] = useState('');
  const [newHouseholdName, setNewHouseholdName] = useState('');

  // "У мене вже є акаунт" sub-flow on the register-email screen — links the
  // just-verified email onto an EXISTING account instead of creating a new
  // household, proven via a second Telegram widget (separate DOM container +
  // global callback from the main login one below, since both can be
  // mounted/relevant at different times and shouldn't share state).
  const [showEmailLink, setShowEmailLink] = useState(false);
  const [emailLinkBusy, setEmailLinkBusy] = useState(false);
  const linkWidgetContainerRef = useRef<HTMLDivElement>(null);

  // Reads the redirect from /api/auth/magic-link/verify (?mode=register-email
  // or ?error=...) once on mount, then strips the query string so a page
  // refresh doesn't replay a one-time token or a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const err = params.get('error');
    if (mode === 'register-email') {
      const token = params.get('pendingToken') || '';
      const email = params.get('email') || '';
      if (token && email) {
        setPendingEmailToken(token);
        setPendingEmailAddress(email);
        setEmailStep('register');
      }
    } else if (err) {
      setEmailError(
        err === 'invalid_link' ? 'Посилання недійсне або протерміноване — спробуйте ще раз'
        : 'Сталася помилка — спробуйте ще раз'
      );
    }
    if (mode || err) window.history.replaceState({}, '', '/login');
  }, []);

  async function submitEmailRequest() {
    if (!emailInput.trim() || emailBusy) return;
    setEmailBusy(true);
    setEmailError('');
    try {
      const res = await fetch('/api/auth/magic-link/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      if (res.ok) {
        setEmailStep('sent');
      } else {
        const data = await res.json().catch(() => null);
        setEmailError(data?.error || 'Не вдалося надіслати листа');
      }
    } catch {
      setEmailError('Помилка з’єднання');
    } finally {
      setEmailBusy(false);
    }
  }

  async function submitEmailRegister(e: React.FormEvent) {
    e.preventDefault();
    if (!newHouseholdName.trim() || emailBusy) return;
    setEmailBusy(true);
    setEmailError('');
    try {
      const res = await fetch('/api/auth/email/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken: pendingEmailToken, name: newHouseholdName.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setEmailError(data?.error || 'Помилка реєстрації'); return; }
      window.location.href = data.onboarded ? '/' : '/onboarding';
    } catch {
      setEmailError('Помилка з’єднання');
    } finally {
      setEmailBusy(false);
    }
  }

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
          window.location.href = data.onboarded ? '/' : '/onboarding';
        }
      } catch {
        setError('Помилка з’єднання');
      } finally {
        setBusy(false);
      }
    };
    return () => { delete (window as unknown as { onTelegramAuth?: unknown }).onTelegramAuth; };
  }, [hasTelegram]);

  // Second widget instance, mounted only while the "У мене вже є акаунт"
  // toggle is open on the register-email screen — same DOM-insertion
  // constraint as the main widget above (document.currentScript.parentNode).
  useEffect(() => {
    if (!hasTelegram || !botUsername || !showEmailLink || !linkWidgetContainerRef.current) return;
    const container = linkWidgetContainerRef.current;
    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true;
    script.nonce = nonce ?? '';
    script.setAttribute('data-telegram-login', botUsername);
    script.setAttribute('data-size', 'large');
    script.setAttribute('data-radius', '10');
    script.setAttribute('data-onauth', 'onEmailLinkTelegramAuth(user)');
    script.setAttribute('data-request-access', 'write');
    container.appendChild(script);
    return () => { container.innerHTML = ''; };
  }, [hasTelegram, botUsername, showEmailLink, nonce]);

  useEffect(() => {
    if (!hasTelegram) return;
    (window as unknown as { onEmailLinkTelegramAuth: (u: TelegramUser) => void }).onEmailLinkTelegramAuth = async (user: TelegramUser) => {
      setEmailError('');
      setEmailLinkBusy(true);
      try {
        const res = await fetch('/api/auth/email/link', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingToken: pendingEmailToken, ...user }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) { setEmailError(data?.error || 'Помилка прив’язки'); return; }
        window.location.href = data.onboarded ? '/' : '/onboarding';
      } catch {
        setEmailError('Помилка з’єднання');
      } finally {
        setEmailLinkBusy(false);
      }
    };
    return () => { delete (window as unknown as { onEmailLinkTelegramAuth?: unknown }).onEmailLinkTelegramAuth; };
  }, [hasTelegram, pendingEmailToken]);

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
      window.location.href = data.onboarded ? '/' : '/onboarding';
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setRegBusy(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
    borderRadius: 20, padding: '40px 36px', width: 320, maxWidth: '100%',
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

  if (emailStep === 'register') {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--c-bg, #0A0A0F)' }}>
        <div style={cardStyle}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Email підтверджено!</div>
            <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>
              {pendingEmailAddress} — {showEmailLink ? 'підтвердіть через Telegram, що це ваш існуючий акаунт' : 'це новий акаунт. Як вас звати?'}
            </div>
          </div>

          {showEmailLink ? (
            hasTelegram ? (
              <>
                <div ref={linkWidgetContainerRef} style={{ minHeight: 40, display: 'flex', justifyContent: 'center' }} />
                {emailLinkBusy && (
                  <div style={{ fontSize: 12, color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Send size={12} /> Перевірка Telegram…
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--c-text-muted)', textAlign: 'center' }}>Telegram-вхід не налаштовано</div>
            )
          ) : (
            <form onSubmit={submitEmailRegister} style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ width: '100%' }}>
                <input
                  className="input-field" value={newHouseholdName} onChange={e => setNewHouseholdName(e.target.value)}
                  placeholder="Ваше ім'я" autoFocus required
                />
              </div>
              <button type="submit" className="btn-primary" disabled={emailBusy} style={{ width: '100%', justifyContent: 'center' }}>
                {emailBusy ? 'Створення…' : 'Створити акаунт'}
              </button>
            </form>
          )}

          {emailError && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{emailError}</div>}

          <button
            type="button"
            onClick={() => { setShowEmailLink(v => !v); setEmailError(''); }}
            style={{ background: 'none', border: 'none', color: 'var(--c-text-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
          >
            {showEmailLink ? '← Створити новий акаунт замість цього' : 'У мене вже є акаунт — прив’язати цей email до нього'}
          </button>
        </div>
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
          <Mail size={24} color="white" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Бюджет</div>
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>Увійдіть або зареєструйтесь</div>
        </div>

        {hasTelegram && (
          <>
            <div ref={widgetContainerRef} style={{ minHeight: 40, display: 'flex', justifyContent: 'center' }} />
            {busy && (
              <div style={{ fontSize: 12, color: 'var(--c-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Send size={12} /> Перевірка Telegram…
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', color: 'var(--c-text-muted)', fontSize: 12 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
              або
              <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
            </div>
          </>
        )}

        {emailStep === 'sent' ? (
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <Mail size={20} />
            Перевірте пошту — надіслали посилання для входу
          </div>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="input-field" type="email" value={emailInput} onChange={e => setEmailInput(e.target.value)}
              placeholder="you@example.com"
            />
            {emailError && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{emailError}</div>}
            <button type="button" onClick={submitEmailRequest} disabled={emailBusy || !emailInput.trim()} className="btn-primary" style={{ width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Mail size={14} /> {emailBusy ? 'Надсилання…' : 'Увійти через email'}
            </button>
          </div>
        )}

        {/* PIN login is exclusive to household #1 — a collapsed secondary
            option, not the first thing every visitor sees (see the showPin
            state's own comment above). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', color: 'var(--c-text-muted)', fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
          або
          <div style={{ flex: 1, height: 1, background: 'var(--c-border)' }} />
        </div>

        {!showPin ? (
          <button
            type="button"
            onClick={() => setShowPin(true)}
            style={{ background: 'none', border: 'none', color: 'var(--c-text-muted)', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Lock size={12} /> Увійти за PIN
          </button>
        ) : (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              className="input-field"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={e => setPin(e.target.value)}
              placeholder="PIN"
              style={{ textAlign: 'center', fontSize: 20, letterSpacing: 6 }}
            />
            {error && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{error}</div>}
            <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
              {busy ? 'Перевірка…' : 'Увійти'}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
