---
name: Бюджет
description: Спільний сімейний трекер бюджету — тепла «категорійна класика»: теплий near-black, оранжевий бренд, колір із реальною роботою
colors:
  brand-orange: "#F97316"
  brand-orange-hover: "#FB8A3C"
  on-brand: "#1A0E05"
  accent-fill: "#C2410C"
  accent-fill-hover: "#9A3412"
  accent-hi: "#FB923C"
  accent-text-light-theme: "#B93A0B"
  bg: "#0D0B0A"
  elevated: "#18140F"
  raised: "#211C16"
  line: "#2B241C"
  text: "#F6F1EB"
  text-secondary: "#D8CEC2"
  text-muted: "#A89F94"
  text-subtle: "#9A9084"
  bg-light: "#F8F4EF"
  elevated-light: "#FFFFFF"
  raised-light: "#F5F0E9"
  line-light: "#E6DDD2"
  text-light: "#1F1710"
  text-secondary-light: "#4A3F34"
  text-muted-light: "#665B4F"
  income-green: "#4ADE80"
  income-green-light-theme: "#166534"
  expense-red: "#F87171"
  expense-red-light-theme: "#B91C1C"
  savings-amber: "#FBBF24"
  savings-amber-text: "#FCD34D"
  savings-amber-light-theme: "#8F4108"
  pool-violet: "#A99CFF"
  pool-violet-light-theme: "#5B49C4"
  attention-red: "#DC2626"
typography:
  display:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "68px"
    fontWeight: 800
    lineHeight: 1.05
    letterSpacing: "-0.035em"
    fontFeature: "tnum"
  headline:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "24px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontFeature: "tnum"
  body:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "Manrope, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  card: "16px"
  tile: "18px"
  xl: "20px"
  panel: "24px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  panel: "28px"
components:
  d-card:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "28px"
  d-pane:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "24px"
  d-stat:
    backgroundColor: "{colors.elevated}"
    rounded: "{rounded.panel}"
    padding: "16px 18px"
    height: "96px"
  d-chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    size: "40px"
  d-btn-primary:
    backgroundColor: "{colors.brand-orange}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  d-btn-primary-hover:
    backgroundColor: "{colors.brand-orange-hover}"
  d-btn:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  d-btn-hover:
    backgroundColor: "{colors.raised}"
  d-pills:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    padding: "4px"
  d-pills-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  d-round:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.pill}"
    size: "36px"
  nav-link:
    textColor: "{colors.text-muted}"
    rounded: "{rounded.lg}"
    padding: "0 14px"
    height: "46px"
  nav-link-active:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  tx-row:
    rounded: "{rounded.tile}"
    height: "64px"
    padding: "10px 12px"
  input-field:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
---

# Design System: Бюджет

## Overview

**Creative North Star: "Тепла категорійна класика"**

Це стандартний вигляд фінансового застосунку, зіграний прямо й до кінця: картки на темній основі, велика головна цифра, кільце витрат, смуги проти плану. Новизни у формі немає навмисно; робота виконана в матеріалі. Нейтралі тепло-коричневі (від `#0D0B0A` до `#211C16`), а не холодно-сірі, колір виконує реальну роботу (дохід, витрата, заощадження, поточна сторінка, головна дія), а категорії в діаграмах завжди насичені та розрізнювані, ніколи не сірі.

Характер — спокійний, пухкий, зручний для великого пальця: радіус карток 24px, керування у формі пігулок (999px), іконки в тонованих круглих чипах. Сторінка відкривається цифрою: «вільний баланс» розміром до 68px у картці з тьмяним помаранчевим сяйвом у куті. Рух — це момент завантаження (цифри долічують, кільце розгортається, смуги наповнюються, картки з'являються каскадом) і повністю вимикається за `prefers-reduced-motion`.

За вмістом — розріджене поле вуглинок (Particles): до 48 теплих світних цяток, що повільно здіймаються вгору. Воно ніколи не конкурує з даними.

**Key Characteristics:**
- Тепла темна тема як база, світла тема — повне дзеркало через `data-theme` та ті самі імена токенів `--c-*`
- Один бренд-колір (`#F97316`): головна кнопка, активна навігація (іконка), сяйво героя, фокус
- Колір = значення: зелений дохід, червоний витрата, бурштиновий заощадження й «майже ліміт», фіолетовий пул
- Одна гарнітура (Manrope, variable, latin + cyrillic), вага 600–800, табличні цифри на всьому
- Картки 24px, пігулки 999px, круглі іконки-чипи
- Глибина: тон + 1px тепла межа; тінь лише у світлій темі та на випадних меню
- Поле вуглинок як фірмовий фон

## Colors

Теплий коричнево-чорний нейтральний ряд, один оранжевий бренд і семантична четвірка, що читається швидше за текст.

### Primary
- **Sunset Orange** (`{colors.brand-orange}`, `--c-brand`): фон головної кнопки (з майже чорним текстом `{colors.on-brand}`, 6.8:1), фокус-кільце, сяйво героя (`--hero-glow`, 14–16% оранжевого), курсор поля вводу, виділення тексту. Hover — `{colors.brand-orange-hover}`.
- **Accent Fill** (`{colors.accent-fill}`, hover `{colors.accent-fill-hover}`): суцільна заливка під білим текстом на старіших сторінках, `accent-color` чекбоксів. `#F97316` із білим дає лише 2.8:1, тому білий текст ніколи не кладеться на нього.
- **Accent Hi** (`{colors.accent-hi}`): іконка активного пункту навігації; у світлій темі замінюється на `{colors.accent-text-light-theme}`.

### Tertiary — семантика
- **Income Green** (`{colors.income-green}`, світла тема `{colors.income-green-light-theme}`): дохід, позитивна дельта, чип доходу.
- **Expense Red** (`{colors.expense-red}`, світла `{colors.expense-red-light-theme}`): витрата, негативна дельта, перевищення плану.
- **Savings Amber** (`{colors.savings-amber}`, текст `{colors.savings-amber-text}`, світла `{colors.savings-amber-light-theme}`): заощадження, смуга плану ≥90%, очікувані (pending) банківські покупки.
- **Pool Violet** (`{colors.pool-violet}`, світла `{colors.pool-violet-light-theme}`): пул/спільні гроші, лише як тонований чип.
- **Attention Red** (`{colors.attention-red}`): кругла кнопка «потребує уваги» з білою іконкою.

Кожен семантичний колір існує як пара: чип (фон 9–16% + текст кольору) і «велике число» (`--c-income-num` тощо).

### Neutral
- **Warm Void** (`{colors.bg}`): фон сторінки. **Warm Card** (`{colors.elevated}`): картки, пігулки, кнопки. **Warm Raised** (`{colors.raised}`): вибраний стан, чипи, поля вводу, hover. **Line** (`{colors.line}`): розділювачі всередині карток.
- Текст: `{colors.text}` → `{colors.text-secondary}` → `{colors.text-muted}` → `{colors.text-subtle}`; усі ≥4.5:1 на фоні, картці й raised в обох темах (за вимірюванням у коментарі globals.css).
- Межі — прозорість теплого кремового: `rgba(255,236,214, 0.06 / 0.08 / 0.13)`.
- Світла тема: `{colors.bg-light}` фон, `{colors.elevated-light}` картки, `{colors.raised-light}` raised, `{colors.line-light}` розділювачі, текст `{colors.text-light}` / `{colors.text-secondary-light}` / `{colors.text-muted-light}`; межі `rgba(60,40,20, 0.08 / 0.10 / 0.16)`.

### Категорійна палітра
Категорії отримують колір через `displayColor(hex, id)`: збережений колір з низькою насиченістю (S<0.3) або надто темний (L<0.25) замінюється детермінованим вибором за id із 8 насичених відтінків (`#F97316 #8B7CF6 #38BDF8 #F472B6 #FBBF24 #2DD4BF #A3E635 #FB7185`). Збережений колір у БД не змінюється; одна категорія має один відтінок у кільці, смугах плану та чипах транзакцій.

### Named Rules

**The Color-Does-A-Job Rule.** Зелений, червоний, бурштиновий і фіолетовий — лише за змістом (дохід, витрата, заощадження/майже ліміт, пул). Декоративного кольору немає. Категорії розрізняються насиченими відтінками, а не сірим.

**The One Orange Rule.** Оранжева заливка — лише головна дія екрана (одна primary-кнопка), логотип і сяйво героя. Активна навігація позначається оранжевою іконкою, текст лишається нейтральним.

**The Fill-Is-Not-White Rule.** На суцільному `#F97316` текст завжди `{colors.on-brand}`; білий текст дозволений лише на `{colors.accent-fill}` чи `{colors.attention-red}`.

## Typography

**Основна гарнітура:** Manrope (variable 200–800, підмножини latin + cyrillic, `next/font`, змінна `--font-manrope`), фолбек `system-ui, -apple-system, sans-serif`. Єдина гарнітура; моноширинної немає.

**Character:** округла геометрична гротеск-гарнітура з хорошою кирилицею; ієрархія вагою (600 / 700 / 800) і розміром, а не контрастом гарнітур. Табличні цифри ввімкнені на `body` (`font-variant-numeric: tabular-nums`).

### Hierarchy
- **Display** (800, `clamp(40px, 17cqw, 68px)`, 1.05, −0.035em): головна цифра героя; масштабується контейнерним запитом, щоб не обрізатися.
- **Headline** (800, 30px; 24px на мобільному, −0.02em): заголовок сторінки/місяця.
- **Title** (700, 18px, −0.01em): заголовки карток-панелей.
- **Figure** (800, `clamp(16px, 12cqw, 24px)`, −0.02em): цифри stat-карток; кільце — до 28px.
- **Body** (600, 14px): навігація, рядки, легенди; назви транзакцій 700.
- **Label** (600, 13px): підписи, нотатки, залишок на смузі. Суфікс валюти — `small`, 0.42em від цифри, колір muted.

### Named Rules

**The One-Face Rule.** Лише Manrope; ієрархія вагою та розміром.

**The Tabular Rule.** Будь-яка сума набрана табличними цифрами; мінус — типографський «−» (CountUp).

## Layout

Двоколонковий шел: липкий сайдбар 248px (220px на 769–1099px) і основна область з відступом `clamp(16px, 4vw, 32px)`. Сайдбар прозорий — поле вуглинок видно крізь нього; поверхні несуть лише активний пункт і картка «Хто вносить».

Головна (`.dash`, max-width 1320px): шапка (заголовок + круглі prev/next, пігулки періоду, Синхронізувати, primary Додати); сітка `.dash-grid`, що на ≥1360px стає `450px | 1fr` (ліворуч герой і 2×2 stat-картки, праворуч кільце та смуги плану поруч на ≥900px); нижче на всю ширину «Останні транзакції» й «Очікують підтвердження». Відступи між картками 20px, всередині stat 16px. Ритм: 4 / 8 / 10 / 14 / 16 / 20 / 24 / 28.

Адаптація: мобільний брейкпойнт 768px — сайдбар зникає, з'являється нижня навігація (`--nav-h: 71px`), `--card-pad` 24 → 16px, stat-картки стають колонкою, кільце 140px. Проміжні смуги 769–1099px (старі сітки) і ≥900 / ≥1360 (головна). Мінімальна цільова зона дотику 40px на мобільному.

### Named Rules

**The Reserved Height Rule.** Блок, що чекає даних, тримає форму результату (skeleton `.skel`, фіксовані min-height), контент не стрибає.

## Elevation & Depth

Тональна гібридна система. У темній темі глибина — це тонова сходинка (`bg → elevated → raised`) і 1px тепла межа; `--card-shadow: none`. У світлій темі картки, пігулки й круглі кнопки отримують м'яку подвійну тінь `0 1px 2px rgba(60,40,20,0.06), 0 6px 18px -8px rgba(60,40,20,0.10)`. Випадні меню шапки (синк, квартал, експорт) мають тінь `0 12px 32px -8px rgba(0,0,0,0.45)` в обох темах, бо вони відірвані від потоку. Модальний оверлей: `rgba(0,0,0,0.7)` + `blur(4px)`.

Картка на hover міняє лише межу (`--c-border-hi`); stat-картка додатково піднімається на `translateY(-2px)`.

### Named Rules

**The Tone-Then-Edge Rule.** Глибина в темній темі = тон + межа; тінь лише у світлій та на плаваючих меню.

## Shapes

М'яка, щедра форма, радіус росте з вагою: 6px (бейджі) → 8px (ghost, скелетони) → 10px (поля, логотип) → 14px (пункти навігації) → 16px (старі `.card`) → 18px (рядки транзакцій) → 20px (старі stat, мобільні d-card) → 24px (головні картки) → 999px (усі кнопки, пігулки, сегменти, чипи, дельта, лічильники).

Круг — основа іконок-чипів (40px; 44px у списках), круглих кнопок prev/next (36px, 40px мобільний) та крапок легенди (10px). Смуги плану — 10px висотою, повністю округлі, з тонкою вертикальною міткою плану. Кільце: внутрішній радіус 69%, зовнішній 91%, проміжок між секторами 1.2°, старт з 12:00 за годинниковою.

## Components

### Кнопки
- **Primary** (`.d-btn.pr`): пігулка 44px, фон `--c-brand`, текст `--c-on-brand`, 700/14px, без тіні; hover `--c-brand-hover`; active `scale(0.98)`. Одна на екран.
- **Вторинна** (`.d-btn`): пігулка 44px на `--c-elevated`, текст `--c-text`, hover `--c-raised`.
- **Кругла** (`.d-round`): 36px, `--c-elevated`, muted-іконка; `.d-attn` — 44px, `#DC2626` з білою іконкою.
- **Старі сторінки** лишають `.btn-primary` (пігулка, `--c-brand`) та `.btn-ghost` (8px).

### Пігулки та сегменти
`.d-pills` / `.seg`: контейнер-пігулка 4px padding, кнопки 34px; вибраний (`aria-pressed`) — `--c-raised`, вага 700, внутрішнє кільце 1px `--c-border-mid`. Використовуються для періоду та «Хто вносить».

### Картки
`.d-card`: 24px, padding 28px (18px мобільний), `--c-elevated`, 1px межа. Герой додає радіальне сяйво `--hero-glow` у верхньому правому куті, footer з роздільниками `--c-line`. `.d-stat`: іконка-чип + мітка + цифра, min-height 96px. `.d-pend` (очікують підтвердження): пунктирна бурштинова межа та бурштиновий градієнт, пульсуюча крапка; суми курсивом, не входять у підсумки.

### Чипи, дельта
Круглі чипи `.d-chip` з тонованою семантикою (`gr/rd/am/vi/or`: фон 10–16%, текст і іконка в відтінку). Чип категорії: `color-mix` 16% кольору категорії. Дельта-пігулка словами («на X менше, ніж…»), колір за добром зміни.

### Смуги плану
`.d-trk` 10px: у плані — колір категорії, ≥90% — бурштиновий текст залишку, перевищення — червоний сегмент `.ov` і червоний залишок. Мітка плану — 2px вертикальна.

### Рядки транзакцій
`.d-tx-row`: 18px радіус, min-height 64px, hover `--c-raised`, чип 44px, сума 16px/700 зеленою/червоною/бурштиновою; перші 3 рядки, решта розкриваються на місці з анімацією висоти (0.45s) до ~20.

### Навігація
- **Сайдбар:** `.nav-link` 46px, радіус 14px, 14px/600, іконка Lucide 20px; hover `--c-elevated`; активний — `--c-raised`, текст нейтральний, іконка `--c-accent-hi`. Логотип — плитка 32px, радіус 10px, `--c-brand`. Тема й вихід — той самий `.nav-link`.
- **Мобільна:** `.m-tab`, іконка над підписом, активна — `--c-raised` + оранжева іконка; фон `--c-sidebar`, z-index 100.

### Поля
`.input-field`: `--c-raised`, межа `--c-border-hi`, радіус 10px; на фокусі межа `#F97316`; на мобільному 16px (проти iOS-зуму).

### Рух
`d-rise` 260ms (затримка `min(i,7)*20ms`), `d-fill` 700ms clip-path, кільце 900ms, CountUp 600ms (ease-out cubic), список транзакцій 450ms; ease `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`. Під `prefers-reduced-motion` усе вимикається; CountUp показує кінцеве значення, Particles малює один статичний кадр.

### Particles (signature)
Один canvas `position: fixed`, `z-index: 0`, `pointer-events: none`. До 48 вуглинок (22 на мобільному) + 3 великі м'які боке; спрайти попередньо промальовані (без `shadowBlur`), темна тема — адитивне змішування з блідо-гарячими серцевинами, світла — насичені оранжеві зі звичайним змішуванням і множником 0.55. Цикл працює лише коли вкладка видима, canvas у в'юпорті й рух не вимкнено; DPR ≤2 (1.25 на мобільному). Нові повноекранні поверхні успадковують поле.

## Do's and Don'ts

### Do:
- **Do** брати нейтралі лише з токенів `--c-*` обох тем; усі текстові токени мають ≥4.5:1.
- **Do** тримати одну primary-кнопку (пігулка 44px, `--c-brand` + `--c-on-brand`) на екран.
- **Do** кодувати зміст кольором: зелений дохід, червоний витрата, бурштиновий заощадження та ≥90% плану, фіолетовий пул.
- **Do** подавати категорії через `displayColor`, щоб кільце, смуги та чипи мали той самий насичений відтінок.
- **Do** набирати суми Manrope з табличними цифрами, суфікс валюти — малим `small`.
- **Do** давати нові картки 24px, кнопки й сегменти 999px, а іконки — у круглих тонованих чипах.
- **Do** анімувати лише transform/opacity/clip-path та вимикати все під `prefers-reduced-motion`.
- **Do** називати наступну дію в порожньому стані.

### Don't:
- **Don't** повертатися до холодно-сірих нейтралів або сірих категорій у діаграмах.
- **Don't** класти білий текст на суцільний `#F97316` (2.8:1).
- **Don't** використовувати семантичні кольори декоративно.
- **Don't** додавати другу гарнітуру чи моноширинну для чисел.
- **Don't** ховати вміст за анімацією: усе читається в кінцевому стані без руху.
- **Don't** додавати тінь у темній темі, окрім випадних меню.
- **Don't** хардкодити нейтральні hex повз токени (ламає світлу тему).
- **Don't** розсувати поле вуглинок за межі «розріджене й тепле»: воно не змагається з цифрами.

## Known drift (не канонізовано)

- Сторінки Транзакції, Планування, Аналітика, Налаштування успадковують токени й шел, але зберігають старі композиції (`.card` 16px, `.stat-card` 20px з градієнтом, `.btn-primary` 10px 20px, `.btn-ghost` 8px, `.tx-grid`, `.plan-table`); їхні розкладки не є частиною цієї системи.
- `.input-field:focus` і `.d-attn` хардкодять `#F97316` / `#DC2626` замість токена; `.badge-*` використовують власні rgba замість `--chip-*`.
- Випадні меню шапки головної мають жорстку тінь `rgba(0,0,0,0.45)` у світлій темі також (інлайн у `page.tsx`).
- Токен `--c-sidebar` лишився лише для мобільної навігації та модалок; сайдбар прозорий.
- Коментар у `globals.css` досі посилається на «примітиви, описані в DESIGN.md» (старі назви).
