'use client';
import { useState } from 'react';
import { Lock } from 'lucide-react';

// Reached via middleware.ts's P4 redirect: an authenticated session (valid
// budget-auth cookie, real household/user) whose hasPin bit is set but has
// no still-valid budget-unlocked cookie. Distinct from /login — identity is
// already established here, this is only the extra "unlock" step. Never
// creates or changes a session, only the unlock cookie.
export default function LockPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/pin-unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json().catch(() => null);
        setError(data?.error || 'Невірний PIN');
        setPin('');
      }
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/account/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/login';
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--c-bg, #0A0A0F)',
      overflowY: 'auto', padding: '24px 0',
    }}>
      <form onSubmit={submit} style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
        background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
        borderRadius: 20, padding: '40px 36px', width: 320, maxWidth: '100%',
      }}>
        <div style={{
          width: 52, height: 52, borderRadius: 16,
          background: 'linear-gradient(135deg, #F97316, #F59E0B)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Lock size={24} color="white" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Бюджет заблоковано</div>
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>Введіть PIN, щоб продовжити</div>
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
          {busy ? 'Перевірка…' : 'Розблокувати'}
        </button>
        <button type="button" onClick={logout} style={{ background: 'none', border: 'none', color: 'var(--c-text-muted)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
          Вийти з акаунту
        </button>
      </form>
    </div>
  );
}
