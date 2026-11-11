'use client';
import { useEffect, useRef, useState } from 'react';
import { useCurrency } from '@/lib/useCurrency';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const DURATION = 600;

// Counts a money figure up from 0 (first paint) or from the last shown value
// (period change) to `value`: ~600ms ease-out, one rAF loop, and DOM text is
// written directly (no React re-render per frame). The amount and its currency
// suffix are separate nodes so the suffix can be styled small. Under
// prefers-reduced-motion the final value is rendered immediately.
export default function CountUp({ value, signed = false }: { value: number; signed?: boolean }) {
  const { currency, formatMoney, formatMoneySign } = useCurrency();
  const numRef = useRef<HTMLSpanElement>(null);
  const sufRef = useRef<HTMLElement>(null);
  const shown = useRef<number | null>(null);
  const fmt = useRef(signed ? formatMoneySign : formatMoney);
  fmt.current = signed ? formatMoneySign : formatMoney;
  // Never changes after mount, so React never overwrites what the loop writes.
  const [initial] = useState(() => parts(fmt.current, prefersReducedMotion() ? value : 0));

  useEffect(() => {
    const num = numRef.current, suf = sufRef.current;
    if (!num || !suf) return;
    const write = (v: number) => { const [n, s] = parts(fmt.current, v); num.textContent = n; suf.textContent = s; };
    const from = shown.current ?? 0;
    if (prefersReducedMotion() || from === value) { shown.current = value; write(value); return; }
    const t0 = performance.now();
    let raf = 0, last = NaN;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / DURATION);
      const v = from + (value - from) * (1 - Math.pow(1 - p, 3));
      shown.current = v;
      const r = Math.round(v);
      if (r !== last || p === 1) { last = r; write(p === 1 ? value : v); }
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, currency, signed]);

  return <><span ref={numRef}>{initial[0]}</span><small ref={sufRef}>{initial[1]}</small></>;
}

// "-1 631 kr" -> ["−1 631", "kr"] (typographic minus; suffix split at the last no-break space).
function parts(f: (n: number) => string, v: number): [string, string] {
  const s = f(v).replace(/^-/, '−');
  const i = s.lastIndexOf(' ');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}
