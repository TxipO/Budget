'use client';
import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import type { ToastType, ToastAction } from '@/lib/toast';

interface Toast { id: string; message: string; type: ToastType; action?: ToastAction }

const ICONS = {
  success: <CheckCircle size={16} />,
  error:   <XCircle   size={16} />,
  info:    <Info       size={16} />,
};
const COLORS = {
  success: { bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.3)',  color: '#4ADE80' },
  error:   { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.3)',  color: '#FCA5A5' },
  info:    { bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.3)', color: '#FB923C' },
};

export default function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { message, type, action, duration } = (e as CustomEvent).detail;
      const id = crypto.randomUUID();
      setToasts(prev => [...prev, { id, message, type, action }]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration ?? 3200);
    };
    window.addEventListener('app-toast', handler);
    return () => window.removeEventListener('app-toast', handler);
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack" style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end',
    }}>
      {toasts.map(t => {
        const c = COLORS[t.type];
        return (
          <div key={t.id} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px', borderRadius: 12,
            background: c.bg, border: `1px solid ${c.border}`, color: c.color,
            fontSize: 13, fontWeight: 500, maxWidth: 320,
            backdropFilter: 'blur(8px)',
            animation: 'fadeIn 0.2s ease both',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}>
            {ICONS[t.type]}
            <span style={{ flex: 1 }}>{t.message}</span>
            {t.action && (
              <button
                onClick={() => { t.action!.onClick(); setToasts(prev => prev.filter(x => x.id !== t.id)); }}
                style={{
                  background: 'none', border: `1px solid ${c.border}`, cursor: 'pointer',
                  color: c.color, padding: '2px 8px', borderRadius: 6, fontSize: 12,
                  fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: c.color, padding: 0, opacity: 0.7 }}
              title="Закрити" aria-label="Закрити"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
