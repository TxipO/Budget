'use client';
import { useEffect, useRef } from 'react';

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  opacity: number;
  opacityDir: number;
  color: string;
  isOrb: boolean;
}

const DOT_COLORS = [
  'rgba(249,115,22,',
  'rgba(251,146,60,',
  'rgba(245,158,11,',
  'rgba(253,224,71,',
  'rgba(255,255,255,',
];
const ORB_COLORS = [
  'rgba(249,115,22,',
  'rgba(251,146,60,',
  'rgba(245,158,11,',
  'rgba(234,88,12,',
];

function makeParticle(w: number, h: number, isOrb: boolean): Particle {
  const palette = isOrb ? ORB_COLORS : DOT_COLORS;
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * (isOrb ? 0.12 : 0.28),
    vy: -(Math.random() * 0.18 + 0.04),
    size: isOrb ? Math.random() * 3.5 + 3 : Math.random() * 1.6 + 0.5,
    opacity: Math.random() * 0.35 + 0.08,
    opacityDir: (Math.random() > 0.5 ? 1 : -1) * (isOrb ? 0.0025 : 0.0035),
    color: palette[Math.floor(Math.random() * palette.length)],
    isOrb,
  };
}

export default function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse     = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvas = canvasEl;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const ctx = ctx2d;

    let w = window.innerWidth;
    let h = window.innerHeight;
    canvas.width  = w;
    canvas.height = h;

    const particles: Particle[] = [
      ...Array.from({ length: 52 }, () => makeParticle(w, h, false)),
      ...Array.from({ length: 18 }, () => makeParticle(w, h, true)),
    ];

    let raf: number;

    function draw() {
      ctx.clearRect(0, 0, w, h);

      const mx = mouse.current.x;
      const my = mouse.current.y;

      // Constellation lines
      ctx.lineWidth = 0.5;
      for (let i = 0; i < particles.length; i++) {
        const a = particles[i];
        for (let j = i + 1; j < particles.length; j++) {
          const b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = dx * dx + dy * dy;
          if (d < 10000) { // 100px
            const alpha = (1 - Math.sqrt(d) / 100) * 0.13;
            ctx.strokeStyle = `rgba(249,115,22,${alpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Particles
      for (const p of particles) {
        // Mouse repulsion
        const dx = p.x - mx, dy = p.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < 10000 && d2 > 0) {
          const d = Math.sqrt(d2);
          const force = (1 - d / 100) * 0.45;
          p.x += (dx / d) * force;
          p.y += (dy / d) * force;
        }

        p.x += p.vx;
        p.y += p.vy;
        p.opacity += p.opacityDir;

        const maxOp = p.isOrb ? 0.58 : 0.44;
        if (p.opacity > maxOp || p.opacity < 0.05) p.opacityDir *= -1;

        if (p.y < -12)    p.y = h + 12;
        if (p.x < -12)    p.x = w + 12;
        if (p.x > w + 12) p.x = -12;

        ctx.fillStyle   = p.color + p.opacity.toFixed(3) + ')';
        ctx.shadowColor = p.color + (p.isOrb ? '0.7' : '0.5') + ')';
        ctx.shadowBlur  = p.isOrb ? 14 : 5;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(draw);
    }

    draw();

    function onResize() {
      w = canvas.width  = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    function onMouseMove(e: MouseEvent) {
      mouse.current = { x: e.clientX, y: e.clientY };
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, opacity: 0.9 }}
    />
  );
}
