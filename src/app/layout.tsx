import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import MobileNav from '@/components/MobileNav';
import dynamic from 'next/dynamic';

const Particles = dynamic(() => import('@/components/Particles'), { ssr: false });
const ToastContainer = dynamic(() => import('@/components/ToastContainer'), { ssr: false });

const inter = Inter({ subsets: ['latin', 'cyrillic'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: 'Бюджет',
  description: 'Сімейний трекер бюджету',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uk">
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var t=localStorage.getItem('theme')||'dark';document.documentElement.setAttribute('data-theme',t);})();` }} />
      </head>
      <body className={inter.className} style={{ display: 'flex', minHeight: '100vh', position: 'relative' }}>
        <Particles />
        <div className="sidebar-wrap"><Sidebar /></div>
        <main style={{ flex: 1, minHeight: '100vh', overflow: 'auto', padding: 'clamp(16px, 4vw, 32px)', position: 'relative', zIndex: 1 }}>
          {children}
        </main>
        <MobileNav />
        <ToastContainer />
      </body>
    </html>
  );
}
