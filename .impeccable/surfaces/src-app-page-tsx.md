---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/components/Sidebar.tsx","src/components/MobileNav.tsx","src/app/globals.css","src/components/Particles.tsx"]
---

## Scope

Головна (dashboard) plus the shared shell (Sidebar, MobileNav, global tokens/type, particle field) — first surface of the 2026-11 visual update. Mode: Operate. Other pages inherit the new tokens and shell now; their own composition comes later.

Audience/job: Паша і Женя check "how are we doing this month" on a phone and desktop; see where money went vs plan; scan the latest ~20 transactions without leaving the page; see bank-pending purchases. Constraints: numbers must stay instantly readable, phone must stay fast, light theme must keep working. Ukrainian copy unchanged.

## Direction contract

THESIS: The category standard played straight at full craft — a warm, polished upgrade of the incumbent app (user-approved sketch .impeccable/mocks/decision/combo.html). Refuses the flat cold-grey panel look: neutrals tinted warm, colour does real jobs.

OWN-WORLD: Warm near-black ground (~#0D0B0A), cards one warm step up (~#18140F), raised ~#211C16, warm border, warm muted text; 24px card radius, pill controls. Orange #F97316 brand: primary button, active nav, hero glow, focus ring. Green income, red expense, amber savings/near-limit, violet pool as tinted round icon chips. Category series in saturated distinct hues, never grey. Manrope, tabular figures. Ember particle field, warm and sparse.

STORY: Open → free balance in words and a big number with since-start; four stat cards; where money went (donut) beside how each category stands against the plan; latest transactions expandable in place to ~20; bank-pending purchases shown apart, not counted.

FIRST VIEWPORT: Header: month title, round prev/next, period pills, Синхронізувати + primary Додати. Left column ≈450px: hero card (glow, 68px figure, delta pill in words, footer З початку | Перекази) over 2×2 stat cards. Right: «Витрати за категоріями» donut card beside «Категорії проти плану» bars (in-plan / ≥90% amber / over red). Bottom full width: «Останні транзакції» (3 rows, expands to ~20), then «Очікують підтвердження». Signature interaction: figures count up, donut sweeps, plan bars fill, cards rise in stagger, transactions list expands with height animation; all off under prefers-reduced-motion.

FORM: category standard (canon), composition from the surface round (calendar style + donut + plan bars), user-steered; seed:2d1f2d65f3c9278a

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
