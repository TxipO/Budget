// formatMoney/formatMoneySign moved to lib/currencies.ts — they now take the
// household's own currency code instead of hardcoding NOK/'kr'. Use the
// useCurrency() hook (lib/useCurrency.ts) from a component instead of
// importing these two names from here.

// Full-screen auth/setup gates — each renders its own fixed, full-viewport
// overlay (position:fixed, inset:0) with no destination behind it yet. The
// app shell (Sidebar, MobileNav) skips rendering entirely on these routes:
// nesting a fixed overlay inside <main>'s own stacking context (position:
// relative + z-index) traps it at main's paint layer instead of truly
// covering the page, so the shell was visible AND clickable underneath a
// "full-screen" login/lock/onboarding/setup gate (found live 2026-09-18).
export const APP_SHELL_HIDDEN_ROUTES = ['/login', '/lock', '/onboarding', '/setup'];

export const MONTH_NAMES = [
  'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень',
];

export const MONTH_SHORT = [
  'Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер',
  'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру',
];

export const TYPE_LABELS: Record<string, string> = {
  income: 'Дохід',
  expense: 'Витрати',
  savings: 'Збереження',
  transfer: 'Перекази',
};

export const TYPE_COLORS: Record<string, string> = {
  income: '#22C55E',
  expense: '#EF4444',
  savings: '#F59E0B',
  transfer: '#64748B',
};

export const CATEGORY_PALETTE = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#F59E0B', '#EC4899', '#14B8A6', '#A78BFA', '#FB923C',
  '#3B82F6', '#8B5CF6',
];

// Provenance marker, not a category color: the small Landmark icon next to a
// transaction that was auto-imported from a bank. One documented constant
// instead of the same literal repeated at every call site.
export const BANK_SYNC_COLOR = '#38BDF8';

export type Period = 'month' | 'quarter' | '6m' | 'year' | 'all';

export const PERIOD_LABELS: Record<Period, string> = {
  month:   'Місяць',
  quarter: 'Квартал',
  '6m':    '6 місяців',
  year:    'Рік',
  all:     'Весь час',
};
