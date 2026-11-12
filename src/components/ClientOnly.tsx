'use client';
import dynamic from 'next/dynamic';

// Next 15 forbids `ssr: false` in Server Components (layout.tsx), so the
// client-only widgets are wrapped here.
export const Particles = dynamic(() => import('@/components/Particles'), { ssr: false });
export const ToastContainer = dynamic(() => import('@/components/ToastContainer'), { ssr: false });
export const SessionGuard = dynamic(() => import('@/components/SessionGuard'), { ssr: false });
