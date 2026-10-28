'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ArrowLeftRight, CalendarDays, BarChart3, Settings } from 'lucide-react';
import { APP_SHELL_HIDDEN_ROUTES } from '@/lib/utils';

const NAV = [
  { href: '/',             icon: LayoutDashboard, label: 'Головна' },
  { href: '/transactions', icon: ArrowLeftRight,  label: 'Транзакції' },
  { href: '/planning',     icon: CalendarDays,    label: 'Планування' },
  { href: '/analytics',    icon: BarChart3,        label: 'Аналітика' },
  { href: '/settings',     icon: Settings,         label: 'Налаш.' },
];

export default function MobileNav() {
  const pathname = usePathname();
  if (APP_SHELL_HIDDEN_ROUTES.includes(pathname)) return null;

  return (
    <nav className="bottom-nav" aria-label="Основна навігація" style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
      background: 'var(--c-sidebar)',
      borderTop: '1px solid var(--c-border-mid)',
      padding: '8px 4px 12px',
      gap: 0,
      justifyContent: 'space-around',
      alignItems: 'center',
    }}>
      {NAV.map(({ href, icon: Icon, label }) => {
        const active = pathname === href;
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '6px 0', borderRadius: 10, textDecoration: 'none',
            color: active ? 'var(--c-accent-hi)' : 'var(--c-text-muted)',
            background: active ? 'rgba(249,115,22,0.12)' : 'transparent',
            transition: 'all 0.15s',
            flex: 1, minWidth: 0,
          }}>
            <Icon size={20} />
            {/* Fixed line-height keeps the nav at --nav-h (71px) at 11px. */}
            <span style={{ fontSize: 11, lineHeight: '15px', fontWeight: active ? 700 : 500, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
