'use client';
import { useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    let saved: Theme = 'dark';
    try { saved = (localStorage.getItem('theme') as Theme) || 'dark'; } catch {} // storage can be blocked
    setTheme(saved);
    document.documentElement.setAttribute('data-theme', saved);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('theme', next); } catch {}
    document.documentElement.setAttribute('data-theme', next);
  }

  return [theme, toggle];
}
