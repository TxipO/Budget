'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ArrowLeftRight, CalendarDays, BarChart3, Settings, Sun, Moon, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme';


const NAV = [
  { href: '/',             icon: LayoutDashboard, label: 'Головна' },
  { href: '/transactions', icon: ArrowLeftRight,  label: 'Транзакції' },
  { href: '/planning',     icon: CalendarDays,    label: 'Планування' },
  { href: '/analytics',    icon: BarChart3,        label: 'Аналітика' },
  { href: '/settings',     icon: Settings,         label: 'Налаштування' },
];

const USERS = ['Паша', 'Женя'];

export default function Sidebar() {
  const pathname = usePathname();
  const [user, setUser] = useState('Паша');
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const saved = localStorage.getItem('currentUser');
    if (saved) setUser(saved);
  }, []);

  function switchUser(u: string) {
    setUser(u);
    localStorage.setItem('currentUser', u);
  }

  return (
    <aside style={{
      width: 220,
      minHeight: '100vh',
      background: 'var(--c-sidebar)',
      borderRight: '1px solid var(--c-border)',
      display: 'flex',
      flexDirection: 'column',
      padding: '24px 12px',
      gap: 4,
      position: 'sticky',
      top: 0,
      flexShrink: 0,
      zIndex: 2,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 10px 20px' }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: 'linear-gradient(135deg, #F97316, #F59E0B)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Wallet size={18} color="white" />
        </div>
        <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--c-text)' }}>Бюджет</span>
      </div>

      {/* Navigation */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
        {NAV.map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            className={cn('nav-link', pathname === href && 'active')}
          >
            <Icon size={17} />
            {label}
          </Link>
        ))}
      </nav>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="nav-link"
        style={{ width: '100%', justifyContent: 'space-between', marginBottom: 4 }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          {theme === 'dark' ? 'Світла тема' : 'Темна тема'}
        </span>
      </button>

      {/* User switcher */}
      <div style={{
        borderTop: '1px solid var(--c-border)',
        paddingTop: 16,
        marginTop: 4,
      }}>
        <p style={{ fontSize: 11, color: '#475569', marginBottom: 8, paddingLeft: 4, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Активний
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          {USERS.map(u => (
            <button
              key={u}
              onClick={() => switchUser(u)}
              style={{
                flex: 1,
                padding: '7px 4px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                fontFamily: 'inherit',
                transition: 'all 0.15s',
                background: user === u ? 'rgba(249,115,22,0.2)' : 'var(--c-hover)',
                color: user === u ? '#FB923C' : 'var(--c-text-muted)',
              }}
            >
              {u}
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
