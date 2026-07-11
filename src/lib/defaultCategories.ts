// Recommended starting categories for a brand-new household's onboarding
// wizard — generalized from household #1's real category list (see
// project memory), with personal/name-specific entries (Кредит, Залежності,
// per-person income categories, individual savings goals) stripped out.
// Fully editable in the wizard (rename/remove/add/recolor) — this is a
// starting point, not a fixed set.
export interface DefaultCategory {
  name: string;
  type: 'income' | 'expense' | 'savings';
  color: string;
  icon: string;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // Дохід
  { name: 'Зарплата',          type: 'income',  color: '#22C55E', icon: 'cash' },
  { name: 'Додатковий дохід',  type: 'income',  color: '#4ADE80', icon: 'star' },

  // Витрати
  { name: 'Оренда',            type: 'expense', color: '#EF4444', icon: 'home' },
  { name: 'Комунальні',        type: 'expense', color: '#F97316', icon: 'zap' },
  { name: 'Їжа',                type: 'expense', color: '#EAB308', icon: 'pizza' },
  { name: 'Транспорт',         type: 'expense', color: '#3B82F6', icon: 'car' },
  { name: 'Медицина',          type: 'expense', color: '#EC4899', icon: 'health' },
  { name: 'Одяг і дім',        type: 'expense', color: '#8B5CF6', icon: 'sofa' },
  { name: 'Розваги',           type: 'expense', color: '#06B6D4', icon: 'game' },
  { name: 'Підписки',          type: 'expense', color: '#6366F1', icon: 'wifi' },
  { name: 'Подарунки',         type: 'expense', color: '#BE185D', icon: 'gift' },
  { name: 'Інше',              type: 'expense', color: '#6B7280', icon: 'circle' },

  // Збереження
  { name: 'Фінансова подушка', type: 'savings', color: '#A855F7', icon: 'shield' },
];
