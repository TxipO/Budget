'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, ArrowLeftRight, CalendarDays, BarChart3, Settings, Sun, Moon, Wallet, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTheme } from '@/lib/theme';
import { APP_SHELL_HIDDEN_ROUTES } from '@/lib/utils';
import { CURRENT_USER_EVENT, setCurrentUser } from '@/lib/currentUser';


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

    // Storage can be blocked (private mode, site data off); the pick just isn't remembered then.
    let saved: string | null = null;
    try { saved = localStorage.getItem('currentUser'); } catch {}
    if (saved) setUser(saved);

    fetch('/api/users').then(r => r.ok ? r.json() : []).then((list: { id: number; name: string }[]) => {
      setUsers(list);
      // No fallback to list[0]: showing someone active that the form won't
      // actually use is how entries got attributed to the wrong person.
      setUser(cur => list.some(u => u.name === cur) ? cur : '');
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
        setCurrentUser(data.user.name);
      }
    }).catch(() => {});
  }, [pathname, router]);

  // The transaction form also writes currentUser (the one source of truth) —
  // follow it so the highlight here never disagrees with the form.
  useEffect(() => {
    const sync = () => { try { setUser(localStorage.getItem('currentUser') ?? ''); } catch {} };
    window.addEventListener(CURRENT_USER_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(CURRENT_USER_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);

  function switchUser(u: string) {
    setUser(u);
    setCurrentUser(u);
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
    // Transparent on purpose: the ember field (Particles) drifts behind the
    // sidebar too; the active nav item and the who-card carry the surfaces.
    <aside className="side">
      {/* Logo */}
      <div className="side-brand">
        <div className="side-logo"><Wallet size={18} /></div>
        <span>Бюджет</span>
      </div>

      {/* Navigation */}
      <nav className="side-nav" aria-label="Основна навігація">
        {NAV.map(({ href, icon: Icon, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? 'page' : undefined}
            className={`nav-link${pathname === href ? ' active' : ''}`}
          >
            <Icon size={20} />
            {label}
          </Link>
        ))}
      </nav>

      {/* Theme toggle */}
      <button onClick={toggleTheme} className="nav-link" style={{ width: '100%', border: 0, background: 'transparent' }}>
        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        {theme === 'dark' ? 'Світла тема' : 'Темна тема'}
      </button>

      {/* Who is entering on this device (localStorage currentUser stays the source of truth) */}
      {users.length > 0 && (
        <div className="who">
          <p>Хто вносить</p>
          <div className="seg" role="group" aria-label="Хто вносить">
            {users.map(u => (
              <button key={u.id} type="button" aria-pressed={user === u.name} onClick={() => switchUser(u.name)} title={u.name}>
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
        style={{ width: '100%', border: 0, background: 'transparent' }}
      >
        <LogOut size={20} />
        {loggingOut ? 'Вихід…' : 'Вийти'}
      </button>
    </aside>
  );
}
