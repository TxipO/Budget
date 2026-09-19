import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { headers } from 'next/headers';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import MobileNav from '@/components/MobileNav';
import dynamic from 'next/dynamic';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

const Particles = dynamic(() => import('@/components/Particles'), { ssr: false });
const ToastContainer = dynamic(() => import('@/components/ToastContainer'), { ssr: false });

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Бюджет',
  description: 'Сімейний трекер бюджету',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Бюджет' },
  icons: { icon: '/icon-192.png', apple: '/icon-192.png' },
};

export const viewport = {
  themeColor: '#F97316',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers() opts this layout (and everything under it) out of
  // static rendering — required so each request gets its own CSP nonce
  // (see middleware.ts) instead of one baked in at build time.
  const nonce = headers().get('x-nonce') ?? undefined;
  return (
    <html lang="uk" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t);})();` }} />
      </head>
      <body className={inter.className} style={{ display: 'flex', minHeight: '100vh', position: 'relative' }}>
        <Particles />
        <div className="sidebar-wrap"><Sidebar /></div>
        {/* No zIndex here on purpose (found live 2026-09-19, mobile audit):
            position:relative + an explicit z-index together make <main> its
            own stacking context, which traps every position:fixed descendant
            (TransactionForm's .modal-overlay included) at main's own paint
            layer — so no z-index inside main, however high, could ever beat
            a sibling like MobileNav's z-index:100. Root cause confirmed by
            hit-testing: the modal's Save button resolved to a MobileNav
            <svg> underneath it. Dropping zIndex removes that trap; Particles
            (position:fixed, z-index:0) still paints behind <main> from plain
            DOM order (canvas mounts first), no explicit z-index needed for
            that ordering. */}
        <main style={{ flex: 1, minHeight: '100vh', overflow: 'auto', padding: 'clamp(16px, 4vw, 32px)', position: 'relative' }}>
          {children}
        </main>
        <MobileNav />
        <ToastContainer />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
