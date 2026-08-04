'use client';
import { useState } from 'react';
import { Users } from 'lucide-react';

export default function SetupPage() {
  const [count, setCount] = useState<1 | 2 | null>(null);
  const [names, setNames] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!count || busy) return;
    const payload = names.slice(0, count).map(n => n.trim());
    if (payload.some(n => !n)) { setError("Вкажіть ім'я для кожного користувача"); return; }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/setup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: payload }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setError(data?.error || 'Помилка налаштування'); return; }
      window.location.href = '/';
    } catch {
      setError('Помилка з’єднання');
    } finally {
      setBusy(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
    background: 'var(--c-sidebar)', border: '1px solid var(--c-border)',
    borderRadius: 20, padding: '40px 36px', width: 340, maxWidth: '100%',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--c-bg, #0A0A0F)',
    }}>
      <form onSubmit={submit} style={cardStyle}>
        <div style={{
          width: 52, height: 52, borderRadius: 16,
          background: 'linear-gradient(135deg, #F97316, #F59E0B)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Users size={24} color="white" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--c-text)' }}>Налаштування бюджету</div>
          <div style={{ fontSize: 13, color: 'var(--c-text-muted)', marginTop: 4 }}>Скільки людей вестиме бюджет?</div>
        </div>

        <div style={{ display: 'flex', gap: 10, width: '100%' }}>
          {[1, 2].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n as 1 | 2)}
              style={{
                flex: 1, padding: '12px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
                fontSize: 15, fontWeight: 700, fontFamily: 'inherit', transition: 'all 0.15s',
                background: count === n ? 'rgba(249,115,22,0.2)' : 'var(--c-hover)',
                color: count === n ? '#FB923C' : 'var(--c-text-muted)',
              }}
            >
              {n}
            </button>
          ))}
        </div>

        {count !== null && Array.from({ length: count }).map((_, i) => (
          <div key={i} style={{ width: '100%' }}>
            <label style={{ fontSize: 11, color: '#64748B', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
              Ім'я{count > 1 ? ` #${i + 1}` : ''}
            </label>
            <input
              className="input-field"
              value={names[i]}
              onChange={e => setNames(prev => { const next = [...prev]; next[i] = e.target.value; return next; })}
              placeholder="Наприклад, Олена"
              required
            />
          </div>
        ))}

        {error && <div style={{ fontSize: 13, color: '#FCA5A5' }}>{error}</div>}

        {count !== null && (
          <button type="submit" className="btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'Збереження…' : 'Почати'}
          </button>
        )}
      </form>
    </div>
  );
}
