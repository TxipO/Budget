import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(amount)) + ' kr';
}

export function formatMoneySign(amount: number): string {
  const abs = new Intl.NumberFormat('nb-NO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.abs(amount));
  return (amount >= 0 ? '+' : '-') + abs + ' kr';
}

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
};

export const TYPE_COLORS: Record<string, string> = {
  income: '#22C55E',
  expense: '#EF4444',
  savings: '#F59E0B',
};

export const CATEGORY_PALETTE = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#F97316', '#F59E0B', '#EC4899', '#14B8A6', '#EAB308',
  '#3B82F6', '#8B5CF6',
];

export type Period = 'month' | 'quarter' | '6m' | 'year' | 'all';

export const PERIOD_LABELS: Record<Period, string> = {
  month:   'Місяць',
  quarter: 'Квартал',
  '6m':    '6 місяців',
  year:    'Рік',
  all:     'Весь час',
};
