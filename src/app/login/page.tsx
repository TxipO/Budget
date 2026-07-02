'use client';
import { useState } from 'react';
import { Lock } from 'lucide-react';

export default function LoginPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
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

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--c-bg, #0A0A0F)',
    }}>
      <form onSubmit={submit} style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
        background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
        borderRadius: 20, padding: '40px 36px', width: 320,
      }}>
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
      </form>
    </div>
  );
}
