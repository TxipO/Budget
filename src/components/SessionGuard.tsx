'use client';
import { useEffect } from 'react';
import { APP_SHELL_HIDDEN_ROUTES } from '@/lib/utils';

// A tab/PWA left open past the 24h PIN-unlock (or session) expiry keeps its
// rendered UI while every API call 401s. Bounce to /lock or /login instead.
export default function SessionGuard() {
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (...args) => {
      const res = await orig(...args);
      if (res.status === 401 && !APP_SHELL_HIDDEN_ROUTES.includes(location.pathname)) {
        const u = new URL(res.url || location.href);
        // pin-unlock / auth routes return 401 for wrong credentials, not for expiry
        if (u.origin === location.origin && u.pathname.startsWith('/api/') && u.pathname !== '/api/account/pin-unlock' && !u.pathname.startsWith('/api/auth')) {
          const err = await res.clone().json().then((j: { error?: string }) => j?.error, () => undefined);
          if (err === 'Locked') location.replace('/lock');
          else if (err === 'Unauthorized') location.replace('/login');
        }
      }
      return res;
    };
    // Resumed/bfcache-restored tab: ping so the wrapper above bounces a stale one at once.
    const ping = () => { fetch('/api/account/me').catch(() => {}); };
    const onVis = () => { if (document.visibilityState === 'visible') ping(); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) ping(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.fetch = orig;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);
  return null;
}
