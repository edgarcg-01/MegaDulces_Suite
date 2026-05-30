# Portal B2B — Design System & UI Structure

> Documento de referencia para iterar el diseño del Portal B2B de Mega Dulces. Cubre paleta, tipografía, layout, componentes y estructura de cada pantalla.
>
> **Stack técnico:** Angular 18 standalone + PrimeNG + Tailwind + CSS variables tokens.
> **Idioma de UI:** Español (México) — voseo permitido (`tenés`, `decíme`).

---

## 1. Filosofía de diseño

**Monocromático con acentos brand sutiles.**

El portal usa una paleta dominantemente neutra (grises + blanco + negro) inspirada en Linear / Notion / Vercel. El color de la marca Mega Dulces (amarillo `#FDE707` / naranja `#F68F1E`) aparece **únicamente en momentos puntuales** para reforzar identidad sin saturar:

- Logo container del shell
- Badge del carrito (count)
- Línea de active state en sidebar/tab
- Underline de links secundarios
- Border-left de boxes de total
- Hover de CTAs primarios (línea inferior interior)
- Focus ring (translúcido)
- Sparkles/bolt en chat IA

Los **status semánticos** (warn / info / ok / bad) se mantienen en momentos críticos de comunicación (estado de pedido, alertas) pero como **soft colors** o solo en bordes/dots — nunca como fondos saturados llenos.

**Objetivo perceptual:** que el ojo no se canse, que los datos (precios, totales, códigos) destaquen por contraste tipográfico y no por color.

---

## 2. Paleta de colores (CSS tokens)

### 2.1 Brand (uso muy reducido)

| Token | Hex | Uso |
|---|---|---|
| `--brand-400` | `#FDE707` | Amarillo puro — badge cart count |
| `--brand-500` | `#F8B400` | Gold — accents en hover, border-left, underline |

> **Nota:** `--brand-600`, `--brand-700`, `--brand-800`, `--brand-900` existen como tokens pero **no se usan** en el portal monocromático. Quedan para gráficos / pages legacy.

### 2.2 Neutrales (paleta dominante)

| Token | Hex | Uso |
|---|---|---|
| `--neutral-50` | `#FAFAFA` | — |
| `--neutral-100` | `#F4F4F5` | Backgrounds soft (eyebrow chip, hover, side cells) |
| `--neutral-200` | `#E4E4E7` | Borders, badges secundarios |
| `--neutral-300` | `#D4D4D8` | Hover borders |
| `--neutral-400` | `#A1A1AA` | Text faint, dividers |
| `--neutral-500` | `#71717A` | Text muted (secondary) |
| `--neutral-700` | `#3F3F46` | Focus border, search bar focus |
| `--neutral-800` | `#27272A` | Hero AI background secundario |
| `--neutral-900` | `#18181B` | **CTAs primarios sólidos**, avatars |
| `--neutral-950` | `#09090B` | Text main, hero AI primary, promo dark |

### 2.3 Surfaces & text

| Token | Light value | Uso |
|---|---|---|
| `--card-bg` | `#FFFFFF` | Fondo de cards / shell sidebar |
| `--surface-ground` | `#F8FAFC` | Fondo base de la app |
| `--border-color` | `--neutral-200` | Border default |
| `--text-main` | `--neutral-950` | Texto principal |
| `--text-muted` | `--neutral-500` | Texto secundario |
| `--text-faint` | `--neutral-400` | Labels, eyebrows, metadata |

### 2.4 Semánticos (uso restringido)

| Token | Hex | Uso |
|---|---|---|
| `--ok-fg` | `#16A34A` | Status entregado, OK |
| `--warn-fg` | `#F59E0B` | Status borrador, warning |
| `--bad-fg` | `#DC2626` | Status cancelado, error |
| `--info-fg` | `#2563EB` | Status confirmado, info |
| `--*-soft-bg` / `--*-soft-fg` / `--*-border` | (variantes) | Para chips / dots / border-left |

**Regla:** los semánticos NO se usan como fondos llenos saturados. Solo en:
- `border-left: 4px` (status hero del order detail)
- dots circulares (timeline)
- soft bg en status circles (orders list) — bg con 12% alpha del color
- ícono coloreado dentro de container neutral

### 2.5 Sombras

```css
0 4px 14px -4px rgba(0,0,0,0.25)   /* CTA hover */
0 6px 16px -4px rgba(0,0,0,0.25)   /* Confirm CTA */
0 8px 18px -8px rgba(0,0,0,0.1)    /* Card hover */
0 12px 22px -10px rgba(0,0,0,0.12) /* Product card hover */
0 12px 28px -6px rgba(0,0,0,0.45)  /* FAB cart */
```

### 2.6 Halos / focus rings

Focus ring estándar (inputs / search bar):
```css
box-shadow: 0 0 0 3px rgba(253, 231, 7, 0.16);  /* Amarillo translúcido 16% */
border-color: var(--neutral-700);
```

---

## 3. Tipografía

**Familia:** `Inter`, sans-serif (font-display: swap)

### 3.1 Escala

| Clase | Tamaño | Line | Weight | Letter-spacing | Uso |
|---|---|---|---|---|---|
| `text-display` | 2.25rem (36px) | 2.5rem | 700 | -0.02em | Headlines hero |
| `text-headline` | 1.5rem (24px) | 2rem | 600 | -0.01em | Titles de page |
| `text-title` | 1.25rem (20px) | 1.75rem | 600 | — | Section titles |
| `text-body-large` | 1rem (16px) | 1.5rem | 400 | — | Body grande |
| `text-body` | 0.875rem (14px) | 1.25rem | 400 | — | Body default |
| `text-label` | 0.75rem (12px) | 1rem | 500 | 0.05em | Labels uppercase |

### 3.2 Patrón title de page (usado en `cat-head`, `ca-head`, `po-head`, `ai-head`)

```html
<header>
  <h1 style="
    font-size: clamp(1.375rem, 3.5vw, 1.75rem);
    font-weight: 800;
    letter-spacing: -0.015em;
    color: var(--text-main);
  ">Título</h1>
</header>
```

### 3.3 Números (precios, totales, códigos)

- `font-variant-numeric: tabular-nums` (siempre que sea número)
- Weight 700-800 para precios/totales
- Letter-spacing -0.01em en displays grandes

---

## 4. Spacing & layout

### 4.1 Container principal

```css
.portal-main {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem max(1.5rem, env(safe-area-inset-right))
    calc(1.5rem + env(safe-area-inset-bottom))
    max(1.5rem, env(safe-area-inset-left));
}

/* Mobile <900px */
padding: 1rem max(1rem, ...);
```

### 4.2 Border radius

| Tamaño | Uso |
|---|---|
| `6px` | Chips pequeños, mono IDs |
| `8px` | Tags, badges, IDs |
| `10px` | Buttons, qty steppers, inputs |
| `12px` | Cards default, totals box |
| `14px` | Product cards, list items |
| `16px` | Empty states |
| `18px` | Hero blocks |
| `999px` | Pills, eyebrow chips, badges |

### 4.3 Sidebar / main split

```
Desktop (≥900px):  sidebar 248px  |  main flex
Mobile (<900px):   sticky header + bottom tab bar (full width)
```

### 4.4 Grids productos

```css
grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
gap: 0.875rem;
```

### 4.5 Catalog layout split

```
Desktop: aside 240px (brand sidebar)  |  section 1fr (product grid)
Mobile:  brand chips horizontal scroll  +  product grid 1-2 cols
```

### 4.6 Order detail layout

```
Desktop: lines 1.6fr  |  timeline 1fr
Mobile:  stack vertical (lines arriba, timeline abajo)
```

---

## 5. Iconografía

**Set:** PrimeIcons (`pi pi-*`). Ya viene con la app.

### Iconos clave del portal

| Ícono | Uso |
|---|---|
| `pi-home` | Inicio (nav) |
| `pi-th-large` | Catálogo (nav) |
| `pi-bolt` | IA / Asistente |
| `pi-shopping-bag` | Carrito (nav, FAB) |
| `pi-receipt` | Pedidos (nav) |
| `pi-shopping-cart` | Agregar al carrito |
| `pi-pencil` | Status borrador |
| `pi-check` / `pi-check-circle` | Status confirmado |
| `pi-truck` | Status entregado / repartir |
| `pi-times` / `pi-times-circle` | Cancelar / cerrar |
| `pi-sparkles` | Chat IA welcome |
| `pi-megaphone` | Promociones |
| `pi-calendar` | Fechas |
| `pi-clock` | Búsquedas recientes |
| `pi-search` | Buscar |
| `pi-trash` | Quitar línea |
| `pi-arrow-right` | Navegación / CTA |
| `pi-arrow-left` | Back link |
| `pi-replay` | Repetir pedido |
| `pi-info-circle` | Info, razón |
| `pi-exclamation-circle` | Stock bajo, warning |
| `pi-history` | Historial |
| `pi-user` | Perfil / usuario chat |
| `pi-sign-out` | Cerrar sesión |
| `pi-percentage` | % promo |
| `pi-eye` | Vista admin |

**Tamaños usados:** 0.65rem (pills), 0.75rem (chips), 1rem (default), 1.125rem (tabs), 1.25rem (cards), 1.5rem (hero icons), 1.75rem (hero detail), 2rem (welcome).

---

## 6. Componentes y patrones reusables

### 6.1 Eyebrow chip

Etiqueta uppercase pequeña en pill — abre páginas y bloques.

```css
display: inline-block;
font-size: 0.7rem;
font-weight: 700;
text-transform: uppercase;
letter-spacing: 0.08em;
color: var(--text-muted);
background: var(--neutral-100);
border: 1px solid var(--border-color);
padding: 0.2rem 0.625rem;
border-radius: 999px;
```

### 6.2 CTA primario neutral (con acento brand en hover)

```css
background: var(--neutral-900);
color: #fff;
border: none;
border-radius: 10px;
padding: 0.875rem 1.25rem;
font-weight: 700;

/* Hover: brillo + línea inferior interior amarilla */
&:hover {
  filter: brightness(1.18);
  box-shadow: inset 0 -2px 0 var(--brand-500);
}
```

### 6.3 CTA secundario / outlined

```css
background: transparent;
border: 1.5px solid var(--border-color);
color: var(--text-main);
border-radius: 10px;

&:hover {
  background: var(--neutral-100);
  border-color: var(--neutral-400);
}
```

### 6.4 Card básica

```css
background: var(--card-bg);
border: 1px solid var(--border-color);
border-radius: 12px;
padding: 1rem;

/* Hover */
&:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 18px -8px rgba(0,0,0,0.1);
  border-color: var(--neutral-300);
}
```

### 6.5 Qty stepper

```html
<div class="qty">
  <button class="qty-btn">−</button>
  <input type="number" />
  <button class="qty-btn">+</button>
</div>
```

```css
.qty {
  display: flex;
  border: 1.5px solid var(--border-color);
  border-radius: 10px;
  height: 38px;
  overflow: hidden;
}
.qty input {
  width: 100%;
  text-align: center;
  border: none;
  background: transparent;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.qty-btn {
  background: var(--surface-ground);
  width: 30px;
  cursor: pointer;
}
.qty-btn:hover:not(:disabled) {
  background: var(--neutral-200);
  color: var(--text-main);
}
```

### 6.6 Status circle (orders list)

Círculo con bg soft + ícono coloreado al centro.

```css
.po-card-status {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  font-size: 1.375rem;
}
.po-status-draft     { background: rgba(245, 158, 11, 0.12); color: var(--warn-fg); }
.po-status-confirmed { background: rgba(37, 99, 235, 0.12); color: var(--info-fg); }
.po-status-fulfilled { background: rgba(22, 163, 74, 0.12); color: var(--ok-fg); }
.po-status-cancelled { background: rgba(220, 38, 38, 0.12); color: var(--bad-fg); }
```

### 6.7 Total box (con border-left brand)

```css
display: flex;
justify-content: space-between;
padding: 1rem;
background: var(--neutral-100);
border: 1px solid var(--border-color);
border-left: 3px solid var(--brand-500);   /* Único accent amarillo */
border-radius: 12px;
```

### 6.8 Avatar gradient (líneas de pedido, suggestions IA)

Hash-based **monocromo** sobre paleta neutra de 8 grises. Mismo producto → mismo color persistente en catalog/cart/order-detail/chat.

```ts
const NEUTRAL_PALETTE = [
  '#3F3F46', '#52525B', '#71717A', '#27272A',
  '#404040', '#525252', '#262626', '#171717',
];

function hashColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return NEUTRAL_PALETTE[Math.abs(h) % NEUTRAL_PALETTE.length];
}
```

```css
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 0.875rem;
  box-shadow: inset 0 -6px 12px rgba(0,0,0,0.12);  /* depth */
}
```

### 6.9 Mini-cart drawer (catalog)

Slide-in derecha, full-height (100dvh), 380px ancho.

```css
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  width: min(380px, 100vw);
  height: 100dvh;
  background: var(--card-bg);
  transform: translateX(100%);   /* hidden */
  transition: transform 320ms cubic-bezier(0.2, 0, 0, 1);
  box-shadow: -12px 0 32px -8px rgba(0,0,0,0.2);
}
.drawer.open { transform: translateX(0); }

.drawer-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  transition: opacity 220ms;
}
```

### 6.10 Filter chips (orders)

Píldoras horizontales scrollables.

```css
.filter {
  background: var(--card-bg);
  border: 1.5px solid var(--border-color);
  border-radius: 999px;
  padding: 0.375rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-muted);
}
.filter:hover {
  border-color: var(--neutral-400);
  color: var(--text-main);
}
.filter.active {
  background: var(--neutral-900);
  border-color: var(--neutral-900);
  color: #fff;
}
.filter-count {  /* badge dentro del chip */
  background: var(--neutral-100);
  color: var(--text-muted);
  font-size: 0.7rem;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
}
.filter.active .filter-count {
  background: rgba(255,255,255,0.22);
  color: #fff;
}
```

---

## 7. Estructura de páginas

### 7.1 `/portal/login`

**Propósito:** entrada del cliente B2B (tenant + user + pass).

```
┌───────────────────────────────┬─────────────────────────────┐
│                               │                             │
│   HERO (desktop only)         │   FORM SIDE                 │
│   ────────────────            │   ──────────                │
│   Background: --neutral-900   │   eyebrow "Portal B2B"      │
│   to --neutral-950 gradient   │   h2 Bienvenido de vuelta   │
│   + sutil halo amarillo       │   subtitle                  │
│                               │                             │
│   [Logo Mega Dulces 88×88]    │   [field] Empresa           │
│                               │   [field] Usuario           │
│   h1 "Tu dulcería,            │   [field] Contraseña + Mostrar │
│       surtida en minutos."    │                             │
│   ↳ accent underline 64×3px   │   [error message si invalid]│
│     en brand-500              │                             │
│                               │   [CTA Ingresar al portal]  │
│   subtitle 1.0625rem opacity  │   ↳ Sólido --neutral-900,    │
│                               │     hover yellow accent     │
│   ✓ Bullet list (4 features)  │                             │
│   ↳ Check icons --brand-400   │   "¿No tienes acceso?"      │
│                               │   ↳ mailto support          │
└───────────────────────────────┴─────────────────────────────┘
```

**Mobile:** solo el form side ocupa todo. Logo de 56×56 arriba del eyebrow.

**Breakpoint:** `≥960px` para split layout.

### 7.2 Shell (`portal-shell`)

**Propósito:** layout común. Sidebar desktop + bottom tab bar mobile + header mobile.

```
DESKTOP (≥900px)
┌─────────────┬──────────────────────────────────────────────┐
│ SIDEBAR     │ MAIN CONTENT                                 │
│ 248px       │ max-width: 1280px                            │
│             │                                              │
│ [Logo]      │                                              │
│ Mega Dulces │                                              │
│ PORTAL B2B  │                                              │
│ ───────     │                                              │
│             │                                              │
│ • Inicio    │                                              │
│ • Catálogo  │                                              │
│ • IA        │                                              │
│ • Carrito ³ │  ← Badge amarillo (brand-400)                │
│ • Pedidos   │                                              │
│             │                                              │
│ (flex grow) │                                              │
│             │                                              │
│ ───────     │                                              │
│ ⬤ Juan      │                                              │
│   Cliente   │                                              │
│ [Salir]     │                                              │
└─────────────┴──────────────────────────────────────────────┘

MOBILE (<900px)
┌──────────────────────────────────────────────────────────┐
│ [Logo] Mega Dulces                              ⤴ Salir  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  CONTENT                                                 │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  🏠      🟦      ⚡      🛍️ ³     📜                      │ ← Bottom tab
│  Inicio  Cat.   IA    Carrito  Pedidos                  │   bar fijo
└──────────────────────────────────────────────────────────┘
```

**Active state nav (desktop):**
```css
background: var(--neutral-100);
color: var(--text-main);
font-weight: 600;
&::before {  /* línea izquierda */
  position: absolute;
  left: -0.875rem;
  width: 3px;
  background: var(--brand-500);
}
```

**Active state tab (mobile):** dot circular 4×4 `--brand-500` debajo del ícono.

**Logo container:** `--neutral-100` bg, 10px radius, 44×44 desktop / 32×32 mobile.

**Avatar usuario:** círculo 36×36, `--neutral-900` bg, texto blanco con inicial.

### 7.3 `/portal/home`

**Propósito:** dashboard de acceso rápido (Rappi-style compact).

```
┌──────────────────────────────────────────────────────────┐
│ h1 "Hola, Juan"  ← brand underline 3px en el nombre     │
│ "¿Qué vas a pedir hoy?"                                  │
├──────────────────────────────────────────────────────────┤
│ ┌──────┬──────┬──────┬──────┐                            │
│ │  🟦  │  ⚡  │  📢  │  ↻   │   QUICK ACTIONS            │
│ │ Cat. │  IA  │Promo │Repet.│   4 columnas grid          │
│ └──────┴──────┴──────┴──────┘   Iconos circulares 40×40 │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ Promociones                              Ver todas →    │
│ ┌──────────┬──────────┬──────────┐ ← horizontal scroll  │
│ │ % off    │ NxM      │ Bundle   │   strip Rappi-style  │
│ │ Title    │ Title    │ Title    │   (no banner full)   │
│ └──────────┴──────────┴──────────┘                       │
├──────────────────────────────────────────────────────────┤
│ Tus pedidos recientes                    Ver todos →    │
│ ┌──────────┬──────────┬──────────┐                       │
│ │ PD-001   │ PD-002   │ PD-003   │ scroll-snap           │
│ │ $1,234   │ $5,678   │ $999     │ tabular nums          │
│ │ ⓘ Entreg │ ⓘ Confirm│ ⓘ Borrad │ p-tag severity       │
│ └──────────┴──────────┴──────────┘                       │
└──────────────────────────────────────────────────────────┘
```

**Quick actions:** grid 4 columnas, cada item con ícono circular `--neutral-100` bg + label compact.

### 7.4 `/portal/catalog`

**Propósito:** catálogo con SU lista de precios. Búsqueda IA + filtros marca + mini-cart drawer.

```
┌──────────────────────────────────────────────────────────┐
│ [admin banner si super-admin]                            │
├──────────────────────────────────────────────────────────┤
│ Catálogo                                  [Pedir con IA] │
│ "Lista de precios de Dulcería Demo"       ↳ neutral-900  │
├──────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 🔍 Buscar producto o marca...    [×]  [⚡ IA toggle] │ │
│ └──────────────────────────────────────────────────────┘ │
│ ↳ focus: border neutral-700 + ring yellow 16% alpha     │
├──────────────────────────────────────────────────────────┤
│ [Búsquedas recientes: chip1 chip2 chip3]  (si IA + sin texto)│
├──────────────────────────────────────────────┬───────────┤
│ ASIDE MARCAS                                 │ MAIN GRID │
│ 240px desktop / horiz scroll mobile          │           │
│                                              │ h2 "Resultados para..." │
│ [Todos          120]  ← avatar neutral-900  │ Producto count  │
│ [─B─] Brand1   42                            │           │
│ [─C─] Brand2   28      ← avatares hash      │ ┌─┬─┬─┐    │
│ [─D─] Brand3   18         neutrales grises  │ │P│P│P│ ... │
│                                              │ └─┴─┴─┘    │
│ ↳ active: bg --neutral-100, line 3px brand  │ grid auto-fill │
│                                              │ minmax(200px, 1fr) │
└──────────────────────────────────────────────┴───────────┘

PRODUCT CARD (200-240px wide, aspect-ratio 1:1 image)
┌──────────────────┐
│                  │  ← cat-card-img: bg hash neutral
│        AB        │     iniciales 48px white
│                  │     ::after radial gradient (depth)
│  [⚡ 87%]  [⚠ 3] │  ← score pill (left, IA mode) / stock pill (right)
├──────────────────┤
│ BRAND NAME       │  ← uppercase 0.65rem text-faint
│ Producto Nombre  │  ← 0.875rem semibold, 2 line clamp
│ $1,234.56  [mín3]│  ← text-main 1.0625rem 800
├──────────────────┤
│ [-][3][+]   [🛒] │  ← qty stepper + add btn (neutral-900)
└──────────────────┘
```

**FAB cart (mobile, cuando hay items):**
```
╭──────────╮
│ 🛍️ ³ $234 │  ← bottom-right, sobre tab bar
╰──────────╯    bg neutral-900, badge count yellow
```

**Mini-cart drawer (slide-in derecha):**
```
┌──────────────────┐
│ TU CARRITO    [×]│
│ 3 productos      │
├──────────────────┤
│ [1] abc12345     │
│      $100/u  -2+ │
│             [🗑] │
│ [2] def67890 ... │
│ [3] ghi54321 ... │
├──────────────────┤
│ Total          │ │
│ $1,234.56      │ │  ← bg neutral-100 + border-left brand-500
├──────────────────┤
│ [Seguir] [Ver →] │  ← secondary | primary neutral
└──────────────────┘
```

### 7.5 `/portal/cart`

**Propósito:** revisar y confirmar pedido draft.

```
┌──────────────────────────────────────────────────────────┐
│ eyebrow "Tu carrito"                                     │
│ h1 "Revisá tu pedido"                  [← Seguir comprando]│
│ PD-2026-00001 · creado 03/06 14:23                       │
├──────────────────────────────────────────┬───────────────┤
│ LINES (1fr)                              │ SUMMARY (320px│
│                                          │ sticky desktop│
│ ┌──[1]──── abc12345 ────[−5+]──$500─[🗑]┐│ / sticky bottom│
│ │   Avatar  Code+meta   Stepper  Total ││ │ mobile)      │
│ └──────────────────────────────────────┘│                │
│ ┌──[2]──── def67890 ─────────────────┐ │ │ RESUMEN      │
│ │ ...                                 │ │ │ ──────       │
│ └─────────────────────────────────────┘ │ │ Productos  3 │
│ ┌──[3]── ...                          ┐ │ │ Unidades  12 │
│ └─────────────────────────────────────┘ │ │ Subtotal  XX │
│                                          │ │ IVA       XX │
│                                          │ │              │
│                                          │ │┌─────────┐  │
│                                          │ ││ Total  │  │  ← border-left brand
│                                          │ ││ $X,XXX │  │     box neutral-100
│                                          │ │└─────────┘  │
│                                          │ │              │
│                                          │ │ [Confirmar  ]│ ← CTA primary
│                                          │ │   pedido    ]│   neutral-900
│                                          │ │              │
│                                          │ │ Vaciar carrito│ ← ghost rojo on hover
│                                          │ │              │
│                                          │ │ ⓘ Al confirmar│
│                                          │ │   reservamos │
│                                          │ │   stock      │
└──────────────────────────────────────────┴───────────────┘
```

**Línea responsive mobile (<640px):**
```
[Avatar] [Body         ] [🗑]
[              Qty         Total ]
```
con `grid-template-areas` reordenando 2 filas.

### 7.6 `/portal/orders`

**Propósito:** lista de todos los pedidos del cliente con filtros por estado.

```
┌──────────────────────────────────────────────────────────┐
│ eyebrow "Historial"                         [+ Nuevo pedido]│
│ h1 "Mis pedidos"                            ↳ neutral-900 │
│ 12 pedido(s) en total                                    │
├──────────────────────────────────────────────────────────┤
│ [Todos 12] [Borradores 1] [Confirmados 2] ...            │
│ ↳ active: bg neutral-900, badge count blanco semi-trans  │
├──────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ [Status   ] [PD-001 [tag]    ]      [Total $1,234] │ │
│ │ [Circle   ] [📅 03 Jun        ]      [Ver detalle →]│ │
│ │  soft bg    [Subtotal $XX IVA]                      │ │
│ │  con ícono                                          │ │
│ │  color                                              │ │
│ └─────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ...                                                  │ │
│ └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

EMPTY STATE CONTEXTUAL (por filtro)
┌──────────────────────────────────────────────────────────┐
│              [🚚 ícono grande faint]                     │
│                                                          │
│      "Todavía no tenés pedidos entregados."             │
│      [Ver todos los pedidos]  ← solo si filtro != all   │
└──────────────────────────────────────────────────────────┘
```

### 7.7 `/portal/orders/:id`

**Propósito:** detalle de pedido + timeline historial.

```
┌──────────────────────────────────────────────────────────┐
│ ← Volver a mis pedidos                                   │
├──────────────────────────────────────────────────────────┤
│ STATUS HERO (border-left 4px del color del estado)       │
│ ┌────────────────────────────────────────────────────┐ │
│ │ │  [🚚] │ Pedido                Total              │ │
│ │ │ icon  │ PD-001                $1,234.56          │ │
│ │ │ soft  │ "Tu pedido fue entregado."               │ │
│ │ │ color │ 📅 Creado 03/06 · ✓ Confirmado · 🚚 Entr.│ │
│ └────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────┬───────────────┤
│ LÍNEAS (1.6fr)                           │ HISTORIAL (1fr)│
│                                          │                │
│ ⓘ Líneas del pedido         3 productos │ ⓘ Historial   │
│                                          │                │
│ ┌[1] abc12345  3 unid · $100/u ─ $300┐ │ │ ●─ inicio    │
│ ├[2] def67890                        ┤ │ │ │  → draft    │
│ ├[3] ghi54321                        ┤ │ │ ⓘ Juan · 03 Jun│
│ └──────────────────────────────────────┘ │ │                │
│                                          │ ●─ draft       │
│ ┌── TOTALS BOX ───────────────────────┐ │ │  → confirmed │
│ │ Subtotal      $XX.XX                │ │ │ ⓘ Juan · 03 Jun│
│ │ IVA           $XX.XX                │ │ │ "razón…"     │
│ │ ─────────────────────────────       │ │ │                │
│ │ │TOTAL ✦       $1,234.56            │ │ │ ●─ confirmed   │
│ │ ↑ accent line brand-500             │ │ │  → fulfilled │
│ │                                     │ │ ⓘ sistema · 04 Jun│
│ │ ⚠ Saldo pendiente $XX (si > 0)      │ │                │
│ └─────────────────────────────────────┘ │                │
└──────────────────────────────────────────┴────────────────┘
```

**Hero gradients (cada estado, solo border-left, NO bg saturado):**
```css
.od-hero { background: var(--card-bg); border-left-width: 4px; }
.od-hero-draft     { border-left-color: var(--warn-fg); }
.od-hero-confirmed { border-left-color: var(--info-fg); }
.od-hero-fulfilled { border-left-color: var(--ok-fg); }
.od-hero-cancelled { border-left-color: var(--bad-fg); }
```

**Timeline dots:** círculos 32×32 sólidos del color semántico + ícono blanco adentro.

### 7.8 `/portal/recommendations` (chat IA)

**Propósito:** asistente conversacional que arma pedidos a partir de texto natural.

```
┌──────────────────────────────────────────────────────────┐
│ [admin banner si super-admin]                            │
├──────────────────────────────────────────────────────────┤
│ HEAD (--neutral-950 bg)                                  │
│ ┌──[⚡]── Asistente                          [📋 Manual]│ │
│ │ icon    Pedido con IA                                 │
│ │ amarillo "Decíme qué necesitás y armo el pedido..."  │
│ └──────────────────────────────────────────────────────┘
├──────────────────────────────────────────────────────────┤
│ BODY (scrollable, surface-ground bg)                     │
│                                                          │
│ WELCOME (turns vacío):                                   │
│              [⚡ icono 80×80 ─ neutral-900 + brand]       │
│              h2 "¿Qué vas a pedir hoy?"                  │
│              p subtitle                                  │
│              "Probá con:"                                │
│              [💬 chip1] [💬 chip2] [💬 chip3]           │
│                                                          │
│ TURNS (cuando hay conversación):                         │
│  [⚡]──── Hola, ¿qué necesitás?                          │ ← AI bubble
│           (card-bg, border-color)                        │
│                                                          │
│           Quiero 3 cajas de chocolate ─[⬤]               │ ← user bubble
│           (neutral-900, white)                           │
│                                                          │
│  [⚡]──── Acá tenés mi sugerencia:                       │
│           ┌── SUGERENCIAS BLOCK ──────────────────┐     │
│           │ 🛍️ 3 sugerencia(s)                    │     │
│           ├───────────────────────────────────────┤     │
│           │ [CH] BRAND                            │     │
│           │      Chocolate Bar                    │     │
│           │      ⓘ razón                          │     │
│           │      $50/u  [-3+] $150     [×]       │     │
│           ├───────────────────────────────────────┤     │
│           │ ...                                   │     │
│           ├───────────────────────────────────────┤     │
│           │ TOTAL              [Agregar al carrito]│    │ ← neutral-900
│           │ $1,234.56                              │    │
│           └────────────────────────────────────────┘    │
│                                                          │
│  [⚡]──── ●●● typing (3 dots animados)                   │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ INPUT                                                    │
│ [textarea: Escribí lo que necesitás...]          [↦]    │
│ ↳ border + focus ring yellow                ↳ neutral-900│
└──────────────────────────────────────────────────────────┘
```

**Bubbles:**
- AI: `bg: var(--card-bg)`, `border: 1px solid var(--border-color)`
- User: `bg: var(--neutral-900)`, `color: #fff`

**AI avatar:** `bg: var(--neutral-900)`, ícono bolt en `var(--brand-400)`.
**User avatar:** `bg: var(--neutral-200)`, texto `var(--text-main)`.

---

## 8. Estados de componentes

### 8.1 Hover (CTA primario)

```css
filter: brightness(1.18);
box-shadow: inset 0 -2px 0 var(--brand-500);
transform: translateY(-1px);
```

### 8.2 Hover (card)

```css
transform: translateY(-2px);
box-shadow: 0 8-12px 18-22px -8-10px rgba(0,0,0,0.10-0.12);
border-color: var(--neutral-300);
```

### 8.3 Disabled

```css
opacity: 0.4-0.55;
cursor: not-allowed;
box-shadow: none;
```

### 8.4 Loading

- Spinner `pi-spin pi-spinner` inline
- Skeleton de PrimeNG con `height` fija
- Typing dots animados (chat IA): 3 dots con `@keyframes typingBlink` 1.2s infinite, delay 0/180/360ms

### 8.5 Focus visible (inputs)

```css
border-color: var(--neutral-700);
box-shadow: 0 0 0 3px rgba(253, 231, 7, 0.16);  /* yellow translucent */
```

### 8.6 Active (nav item)

Desktop: `bg: var(--neutral-100)`, `font-weight: 600`, línea izquierda 3px `--brand-500`.
Mobile tab: dot 4×4 `--brand-500` bajo el ícono.

### 8.7 Empty state pattern

```html
<div class="empty">
  <i class="pi pi-inbox empty-icon"></i>   <!-- 1.875rem faint -->
  <h2>Título corto</h2>                     <!-- 1.25rem 800 -->
  <p>Mensaje explicativo.</p>              <!-- text-muted -->
  <button>Acción CTA</button>              <!-- neutral-900 -->
</div>
```

```css
.empty {
  text-align: center;
  padding: 3rem 1.5rem;
  background: var(--card-bg);
  border: 1px dashed var(--border-color);
  border-radius: 16px;
  max-width: 480px;
  margin: 2rem auto;
}
.empty-icon-circle {  /* opcional */
  width: 72px;
  height: 72px;
  margin: 0 auto 1rem;
  border-radius: 18px;
  background: var(--neutral-100);
  display: grid;
  place-items: center;
  font-size: 1.875rem;
  color: var(--text-faint);
}
```

---

## 9. Responsive breakpoints

| Breakpoint | Aplicación |
|---|---|
| `<480px` | Mobile chico (compact paddings, fonts ≥16px en inputs para evitar iOS zoom) |
| `<640px` | Mobile (line items stack vertical, qty steppers full-width en cart) |
| `<768px` | Tablet (catálogo sidebar marcas pasa a horizontal scroll, layout grids 1 col) |
| `<900px` | Portal shell mobile (sidebar → bottom tab bar, header mobile activado) |
| `≥960px` | Login split layout activado |
| `≥900px` | Sidebar desktop activado |

**Safe areas (PWA mobile):** todos los containers usan `env(safe-area-inset-*)` con `max(...)` o `calc(...)`.

---

## 10. Animaciones

### Easings (CSS custom props ya definidos)

```css
--ease-standard:    cubic-bezier(0.4, 0, 0.2, 1);
--ease-decelerate:  cubic-bezier(0, 0, 0.2, 1);
--ease-accelerate:  cubic-bezier(0.4, 0, 1, 1);
--ease-spring:      cubic-bezier(0.34, 1.4, 0.5, 1);
--ease-emphasized:  cubic-bezier(0.2, 0, 0, 1);
```

### Keyframes destacados

```css
/* Welcome icon chat IA */
@keyframes floatY {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-6px); }
}

/* Typing dots */
@keyframes typingBlink {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40%           { opacity: 1; transform: scale(1.1); }
}

/* FAB cart aparición */
@keyframes fabIn {
  from { transform: translateY(20px) scale(0.85); opacity: 0; }
  to   { transform: translateY(0) scale(1); opacity: 1; }
}

/* Turn nuevo (chat) */
@keyframes turnIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

### Transition timings

| Caso | Duración | Easing |
|---|---|---|
| Color/border change | 150ms | standard |
| Background hover | 150ms | standard |
| Transform hover (translateY) | 180-200ms | standard |
| Box-shadow expansion | 200ms | standard |
| Drawer slide | 320ms | emphasized |
| FAB pop-in | 360ms | spring |
| Chat turn fade-in | 280ms | decelerate |

---

## 11. Accesibilidad

- **Aria labels** en botones icon-only (badges cart, qty steppers, close drawer, etc.)
- **Aria-selected** en filter chips role="tab"
- **Aria-hidden** en decorativos (background deco, backdrops)
- **Min touch target 44×44** en todos los botones (cumple Apple HIG)
- **Color contrast AA** en todos los textos (text-main sobre card-bg, text-muted sobre card-bg, white sobre neutral-900)
- **focus-visible** con ring amarillo translúcido en inputs
- **Inputs `font-size: 16px` mínimo en mobile** para evitar iOS auto-zoom
- **scroll-snap-type: x mandatory** en strips horizontales (orders, promos)
- **prefers-reduced-motion: reduce** ya respetado por liquid tabs (heredado de styles globales)

---

## 12. Resumen filosofía visual

> El portal se siente como una herramienta profesional sobria con identidad de marca discreta pero reconocible. Linear meets WhatsApp Business: neutro alto, datos densos, amarillo Mega Dulces solo en momentos de identidad o feedback de acción.

**3 reglas mentales para mantener consistencia:**

1. **¿Necesita color?** Default: NO. Solo si comunica estado crítico (status semánticos), identidad (logo / badge cart), o feedback de acción (hover de primario).
2. **¿Hay gradient?** Default: NO. Solo backgrounds neutral-900/950 para hero/CTAs, no gradients brand saturados llenos.
3. **¿El color va de fondo lleno?** Default: NO. Borde, dot, underline, accent line — sí. Fondo lleno saturado — NO.

---

## 13. Files / locations

```
apps/view/src/app/modules/portal/
├── portal-shell.component.ts         # Layout común (sidebar + tab bar)
├── portal.service.ts                 # API + cart signals (cartLineCount/Total/Detail)
├── portal.guard.ts                   # Solo customer_b2b (+ super-admin override en algunas)
└── pages/
    ├── portal-login.component.ts     # /portal/login
    ├── portal-home.component.ts      # /portal/home
    ├── portal-catalog.component.ts   # /portal/catalog
    ├── portal-cart.component.ts      # /portal/cart
    ├── portal-orders.component.ts    # /portal/orders
    ├── portal-order-detail.component.ts  # /portal/orders/:id
    └── portal-recommendations.component.ts  # /portal/recommendations (chat IA)
```

**Tokens CSS:** `apps/view/src/styles/tokens.css`
**Estilos globales:** `apps/view/src/styles.css`
**Logo:** `apps/view/src/assets/logos/mega-dulces-logo.webp` (88×88 hero / 56×56 form / 44×44 sidebar / 32×32 mobile)
