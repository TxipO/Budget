'use client';
import { useEffect, useState } from 'react';

export interface DashboardPrefs {
  banners: boolean;  // накопичений залишок
  budget:  boolean;  // бюджет по категоріях
  charts:  boolean;  // донат витрат + тренд
  byUser:  boolean;  // хто скільки
  recent:  boolean;  // останні транзакції
}

export const DEFAULT_PREFS: DashboardPrefs = {
  banners: true, budget: true, charts: true, byUser: true, recent: true,
};

export const PREF_LABELS: Record<keyof DashboardPrefs, string> = {
  banners: 'Накопичений залишок',
  budget:  'Бюджет по категоріях',
  charts:  'Графіки (витрати + тренд)',
  byUser:  'Хто скільки',
  recent:  'Останні транзакції',
};

const KEY = 'dashboardSections';

// Per-device preference, so localStorage (not DB) is the right home —
// telephone and laptop can show different dashboards.
export function useDashboardPrefs(): [DashboardPrefs, (patch: Partial<DashboardPrefs>) => void] {
  const [prefs, setPrefs] = useState<DashboardPrefs>(DEFAULT_PREFS);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
      setPrefs({ ...DEFAULT_PREFS, ...saved });
    } catch { /* corrupted value — keep defaults */ }
  }, []);

  function update(patch: Partial<DashboardPrefs>) {
    setPrefs(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }

  return [prefs, update];
}
