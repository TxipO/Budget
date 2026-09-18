'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, ArrowLeftRight, CalendarDays, BarChart3, Settings, Sun, Moon, Wallet, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme';
import { APP_SHELL_HIDDEN_ROUTES } from '@/lib/utils';


const NAV = [
  { href: '/',             icon: LayoutDashboard, label: 'Головна' },
  { href: '/transactions', icon: ArrowLeftRight,  label: 'Транзакції' },
  { href: '/planning',     icon: CalendarDays,    label: 'Планування' },
  { href: '/analytics',    icon: BarChart3,        label: 'Аналітика' },
  { href: '/settings',     icon: Settings,         label: 'Налаштування' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState('');
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [theme, toggleTheme] = useTheme();
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    // No session yet on /login. /lock is skipped too — every /api/* route
    // except the small unlock/logout allowlist 401s while locked (P4), so
    // these fetches would just fail there; nothing to gate or prefill on
    // that page anyway. Same for /onboarding and /setup: the sidebar itself
    // doesn't render on any of these (see APP_SHELL_HIDDEN_ROUTES below),
    // so there's nothing here to prefill and no redirect-loop risk to
    // guard against by fetching anyway.
    if (APP_SHELL_HIDDEN_ROUTES.includes(pathname)) return;

    const saved = localStorage.getItem('currentUser');
    if (saved) setUser(saved);

    fetch('/api/users').then(r => r.ok ? r.json() : []).then((list: { id: number; name: string }[]) => {
      setUsers(list);
      if (!saved || !list.some(u => u.name === saved)) setUser(list[0]?.name ?? '');
    }).catch(() => {});

    // A Telegram-linked login identifies a specific household member —
    // default the "who's entering" toggle to them instead of whatever was
    // last picked (e.g. on a shared family tablet). Still just a default:
    // the buttons below stay switchable, nothing is locked.
    //
    // Also the onboarding gate: a household whose wizard hasn't run yet
    // (empty categories, no PIN decision — see Household.onboardedAt) gets
    // bounced to /onboarding from every other page. Client-side only —
    // middleware runs on the Edge without Prisma, can't check this itself.
    fetch('/api/account/me').then(r => r.ok ? r.json() : null).then(data => {
      if (!data) return;
      if (data.onboarded === false && pathname !== '/onboarding') { router.replace('/onboarding'); return; }
      if (!data.shared && data.user?.name) {
        setUser(data.user.name);
        localStorage.setItem('currentUser', data.user.name);
      }
    }).catch(() => {});
  }, [pathname, router]);

  function switchUser(u: string) {
    setUser(u);
    localStorage.setItem('currentUser', u);
  }

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch('/api/account/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      setLoggingOut(false);
    }
  }

  if (APP_SHELL_HIDDEN_ROUTES.includes(pathname)) return null;

  return (
    <aside style={{
      width: 220,
      // `height`, not `minHeight` — the sidebar sits in a flex row next to
      // main content that's often much taller than the viewport (a long
      // dashboard), and align-items:stretch (.sidebar-wrap's default) was
      // stretching this aside to match THAT height. `position: sticky` only
      // keeps the TOP of a box pinned while scrolling — it doesn't stop the
      // box itself from being taller than the viewport, so the theme/user/
      // logout controls (pushed to the bottom via nav's flex:1) ended up
      // scrolled far below the fold on any long page. Capping height at the
      // viewport keeps the whole sidebar, controls included, always in view.
      height: '100vh',
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
            className={`nav-link${pathname === href ? ' active' : ''}`}
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
      {users.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--c-border)',
          paddingTop: 16,
          marginTop: 4,
        }}>
          <p style={{ fontSize: 11, color: '#475569', marginBottom: 8, paddingLeft: 4, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            Активний
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            {users.map(u => (
              <button
                key={u.id}
                onClick={() => switchUser(u.name)}
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
                  background: user === u.name ? 'rgba(249,115,22,0.2)' : 'var(--c-hover)',
                  color: user === u.name ? '#FB923C' : 'var(--c-text-muted)',
                }}
              >
                {u.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Logout — the /login guard this used to need is now the early
          `return null` above; the sidebar never reaches here on that route. */}
      <button
        onClick={logout}
        disabled={loggingOut}
        className="nav-link"
        style={{ width: '100%', justifyContent: 'flex-start', marginTop: 8, color: 'var(--c-text-muted)' }}
      >
        <LogOut size={17} />
        {loggingOut ? 'Вихід…' : 'Вийти'}
      </button>
    </aside>
  );
}
