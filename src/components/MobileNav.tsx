'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ArrowLeftRight, CalendarDays, BarChart3, Settings } from 'lucide-react';

const NAV = [
  { href: '/',             icon: LayoutDashboard, label: 'Головна' },
  { href: '/transactions', icon: ArrowLeftRight,  label: 'Транзакції' },
  { href: '/planning',     icon: CalendarDays,    label: 'Планування' },
  { href: '/analytics',    icon: BarChart3,        label: 'Аналітика' },
  { href: '/settings',     icon: Settings,         label: 'Налаш.' },
];

export default function MobileNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" style={{
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
          <Link key={href} href={href} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            padding: '6px 12px', borderRadius: 10, textDecoration: 'none',
            color: active ? '#FB923C' : '#475569',
            background: active ? 'rgba(249,115,22,0.12)' : 'transparent',
            transition: 'all 0.15s',
            minWidth: 56,
          }}>
            <Icon size={20} />
            <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
