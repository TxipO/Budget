'use client';
import { useEffect, useRef } from 'react';

// Warm ember field behind the whole app: small glowing embers drifting upward
// with a slight sway and twinkle, thin constellation lines between nearby
// embers (desktop), and a pointer that scatters them (they drift back). Plus a
// few large soft bokeh motes.
//
// Performance (phones are a red line): one canvas 2D context, one rAF loop,
// glow comes from pre-rendered sprites + drawImage (no shadowBlur, no gradients
// per frame), typed arrays and no allocation inside the loop. The loop only
// runs while the tab is visible, the canvas intersects the viewport and the
// user has not asked for reduced motion (then a single faint static frame is
// drawn). DPR is fixed at 1 (the glow is soft, it gains nothing from more
// pixels), drawing is throttled to ~30fps and paused while the page scrolls
// (scroll jank otherwise), and the particle count scales with area.

const MAX = 64;
const LINK = 130;  // px, constellation link distance (desktop only)
const REPEL = 130; // px, pointer influence radius
const FRAME_MS = 33; // ~30fps
const SCROLL_IDLE_MS = 150;
const SPRITE = 64; // px, square; ember and bokeh share the size and are scaled on draw

type Sprites = HTMLCanvasElement[]; // [ember orange, ember amber, bokeh orange, bokeh amber]

function sprite(stops: [number, string][]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, SPRITE, SPRITE);
  return c;
}

function buildSprites(light: boolean): Sprites {
  // Dark ground: pale-hot cores blended additively. Light ground: saturated
  // deeper oranges with normal blending (a pale core would vanish).
  const ember = (core: string, mid: string, glow: string) => sprite(light
    ? [[0, core], [0.22, mid], [0.55, glow], [1, 'rgba(249,115,22,0)']]
    : [[0, core], [0.16, mid], [0.42, glow], [1, 'rgba(249,115,22,0)']]);
  // Bokeh: a pure radial falloff (no rim, no visible edge) in a warm orange; alpha is set per particle, <= 0.06 at the centre.
  const bokeh = (rgb: string) => sprite([[0, `rgba(${rgb},1)`], [0.4, `rgba(${rgb},0.5)`], [0.75, `rgba(${rgb},0.12)`], [1, `rgba(${rgb},0)`]]);
  return light
    ? [
        ember('rgba(234,88,12,0.95)', 'rgba(249,115,22,0.6)', 'rgba(249,115,22,0.18)'),
        ember('rgba(217,119,6,0.95)', 'rgba(245,158,11,0.6)', 'rgba(245,158,11,0.18)'),
        bokeh('234,88,12'),
        bokeh('217,119,6'),
      ]
    : [
        ember('rgba(255,236,200,1)', 'rgba(255,170,80,0.85)', 'rgba(249,115,22,0.3)'),
        ember('rgba(255,244,200,1)', 'rgba(253,200,80,0.85)', 'rgba(245,158,11,0.3)'),
        bokeh('249,115,22'),
        bokeh('245,158,11'),
      ];
}

export default function Particles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const x = new Float32Array(MAX), y = new Float32Array(MAX);
    const size = new Float32Array(MAX), speed = new Float32Array(MAX);
    const phase = new Float32Array(MAX), swayA = new Float32Array(MAX), swayF = new Float32Array(MAX);
    const twF = new Float32Array(MAX), base = new Float32Array(MAX);
    const kind = new Uint8Array(MAX);
    const ox = new Float32Array(MAX), oy = new Float32Array(MAX); // pointer displacement
    const rx = new Float32Array(MAX), ry = new Float32Array(MAX); // render positions

    let w = 0, h = 0, dpr = 1, count = 0, seeded = 0;
    let light = document.documentElement.getAttribute('data-theme') === 'light';
    let sprites = buildSprites(light);
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = mq.matches;
    let tabVisible = !document.hidden;
    let inView = true;
    let raf = 0, prev = 0, t = 0, lastDraw = 0, scrolling = false;
    let links = false, mx = -9999, my = -9999;

    function seed(i: number, anywhere: boolean) {
      const bokeh = i < 3; // exactly three soft warm motes
      kind[i] = (bokeh ? 2 : 0) + (Math.random() < 0.35 ? 1 : 0);
      size[i] = bokeh ? 40 + Math.random() * 30 : 5 + Math.random() * 6;
      speed[i] = bokeh ? 4 + Math.random() * 8 : 9 + Math.random() * 20;
      swayA[i] = 6 + Math.random() * 18;
      swayF[i] = 0.25 + Math.random() * 0.45;
      twF[i] = 0.8 + Math.random() * 1.4;
      phase[i] = Math.random() * 6.283;
      base[i] = bokeh ? 0.035 + Math.random() * 0.025 : 0.35 + Math.random() * 0.45;
      ox[i] = oy[i] = 0;
      x[i] = Math.random() * w;
      y[i] = anywhere ? Math.random() * h : h + size[i];
    }

    function resize() {
      const narrow = window.innerWidth <= 768;
      dpr = 1;
      w = window.innerWidth; h = window.innerHeight;
      canvas!.width = Math.round(w * dpr); canvas!.height = Math.round(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      links = !narrow;
      count = Math.min(narrow ? 22 : MAX, Math.max(8, Math.round((w * h) / (narrow ? 15000 : 22000))));
      for (let i = seeded; i < count; i++) seed(i, true);
      seeded = Math.max(seeded, count);
      for (let i = 0; i < count; i++) if (x[i] > w) x[i] = Math.random() * w;
      if (!running()) draw(); // keep a static frame correct after resize
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = light ? 'source-over' : 'lighter';
      const scale = (light ? 0.55 : 1) * (reduced ? 0.5 : 1);
      for (let i = 0; i < count; i++) {
        rx[i] = x[i] + Math.sin(t * swayF[i] + phase[i]) * swayA[i] + ox[i];
        ry[i] = y[i] + oy[i];
      }
      // Constellation: embers (not the bokeh motes, i < 3) closer than LINK get a hairline.
      if (links && !reduced) {
        ctx!.strokeStyle = light ? 'rgb(234,88,12)' : 'rgb(249,115,22)';
        ctx!.lineWidth = 0.6;
        for (let i = 3; i < count; i++) {
          for (let j = i + 1; j < count; j++) {
            const dx = rx[i] - rx[j], dy = ry[i] - ry[j];
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK * LINK) {
              ctx!.globalAlpha = (1 - Math.sqrt(d2) / LINK) * 0.22 * scale;
              ctx!.beginPath(); ctx!.moveTo(rx[i], ry[i]); ctx!.lineTo(rx[j], ry[j]); ctx!.stroke();
            }
          }
        }
      }
      for (let i = 0; i < count; i++) {
        const s = size[i];
        const fy = ry[i] / h;
        // Fade in from the bottom edge and out at the top so respawns never pop.
        const edge = Math.min(1, Math.max(0, fy) * 5, Math.max(0, 1.04 - fy) * 12);
        const a = base[i] * (0.62 + 0.38 * Math.sin(t * twF[i] + phase[i] * 1.7)) * edge * scale;
        if (a < 0.01) continue;
        ctx!.globalAlpha = a;
        ctx!.drawImage(sprites[kind[i]], rx[i] - s, ry[i] - s, s * 2, s * 2);
      }
      ctx!.globalAlpha = 1;
    }

    function frame(ts: number) {
      raf = requestAnimationFrame(frame);
      if (scrolling || ts - lastDraw < FRAME_MS) return;
      const dt = prev ? Math.min(0.05, (ts - prev) / 1000) : 0;
      prev = ts; lastDraw = ts; t += dt;
      // Pointer repulsion: push away from the cursor/touch, then ease back to the drift path.
      const decay = Math.min(1, 1.6 * dt);
      const R2 = REPEL * REPEL;
      for (let i = 0; i < count; i++) {
        y[i] -= speed[i] * dt;
        if (y[i] < -size[i] * 2) { seed(i, false); continue; }
        const dx = rx[i] - mx, dy = ry[i] - my, d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 1) {
          const d = Math.sqrt(d2), f = (1 - d / REPEL) * 300 * dt / d;
          ox[i] += dx * f; oy[i] += dy * f;
        }
        ox[i] -= ox[i] * decay; oy[i] -= oy[i] * decay;
      }
      draw();
    }

    function running() { return raf !== 0; }
    function sync() {
      const want = tabVisible && inView && !reduced;
      if (want && !raf) { prev = 0; raf = requestAnimationFrame(frame); }
      else if (!want && raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!want) draw();
    }

    let rt = 0;
    const onResize = () => { clearTimeout(rt); rt = window.setTimeout(resize, 150); };
    // Listen on window (the canvas stays pointer-events:none, so clicks reach the content).
    const onPtr = (e: PointerEvent) => { mx = e.clientX; my = e.clientY; };
    const onPtrEnd = (e: PointerEvent) => { if (e.pointerType !== 'mouse') mx = my = -9999; };
    const onLeave = () => { mx = my = -9999; };
    let st = 0;
    // Capture: scroll events don't bubble, and the page scrolls inside <main>, not the window.
    const onScroll = () => { scrolling = true; clearTimeout(st); st = window.setTimeout(() => { scrolling = false; prev = 0; }, SCROLL_IDLE_MS); };
    const onVis = () => { tabVisible = !document.hidden; sync(); };
    const onMotion = () => { reduced = mq.matches; sync(); };
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); });
    const mo = new MutationObserver(() => {
      const nowLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (nowLight !== light) { light = nowLight; sprites = buildSprites(light); if (!running()) draw(); }
    });

    resize();
    sync();
    io.observe(canvas);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('pointermove', onPtr, { passive: true });
    window.addEventListener('pointerdown', onPtr, { passive: true });
    window.addEventListener('pointerup', onPtrEnd);
    window.addEventListener('pointercancel', onPtrEnd);
    document.documentElement.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVis);
    mq.addEventListener('change', onMotion);
    return () => {
      cancelAnimationFrame(raf); raf = 0;
      clearTimeout(rt); clearTimeout(st);
      io.disconnect(); mo.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointermove', onPtr);
      window.removeEventListener('pointerdown', onPtr);
      window.removeEventListener('pointerup', onPtrEnd);
      window.removeEventListener('pointercancel', onPtrEnd);
      document.documentElement.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      mq.removeEventListener('change', onMotion);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}
    />
  );
}
