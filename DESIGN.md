# Design System — Mega Dulces ("Mercado")

> Fuente de verdad de UI para toda la app.
> Dirección **"Mercado"**, creada por `/design-consultation` (2026-06-04, extendida 2026-06-08).
> Los tokens viven en [`apps/view/src/styles/tokens.css`](apps/view/src/styles/tokens.css). Este archivo manda sobre cualquier valor hardcodeado.
> **Fundamentos (el *por qué* + estado del arte, con citas):** [`docs/DESIGN_FOUNDATIONS.md`](docs/DESIGN_FOUNDATIONS.md) — color perceptual (OKLCH/APCA), tokens DTCG, tipografía óptica, densidad, WCAG 2.2, motion. Este archivo es operativo; ése es la base teórica.
> **Benchmark CRM/Inventario (cómo lo hacen Linear/Attio/Carbon/Polaris/Stripe, con números):** [`docs/DESIGN_BENCHMARK_CRM_INVENTORY.md`](docs/DESIGN_BENCHMARK_CRM_INVENTORY.md). Las reglas canónicas de datos densos de aquí abajo salen de ahí.

> **Estado de implementación (2026-06-16):** la migración Operations (Hanken/Stone/sunset/ember en `:root`) **ya está aplicada** en `tokens.css` — la nota histórica "pendiente de aprobación" más abajo quedó vieja. El dark de Operations es **zinc neutro `#111111`** (decisión "esto es serio"), NO el espresso `#16130F` que describen las tablas históricas; el espresso quedó scopeado solo a `/portal`.

> **Contrato de ingeniería de UI (2026-07-10):** el *cómo se construye* (fundamento cognitivo, matriz de estados, a11y AA+APCA, presupuesto de motion + limpieza de ciclo de vida, container queries, error boundaries, formateo de dominio, XSS, estado-en-URL) está codificado como BINDING en la sección [Ingeniería de UI](#ingeniería-de-ui--contrato-de-implementación-binding). Se verifica en review.

> **Norte de estilo — directiva "quiet luxury" (2026-06-23):** el surface Operations toma como referencia absoluta a **Linear · Stripe · Vercel (Geist)**: minimalismo técnico, herramienta profesional, máxima densidad sin sacrificar claridad. Reglas que **mandan** (refuerzan/afinan lo de abajo):
> 1. **Estructura casi monocromática.** El color de marca (sunset `--action`) se reserva para **CTAs, enlaces activos y el estado seleccionado** — nada de decorar con color. Semánticos (ok/warn/bad) **desaturados y controlados**, solo en badges de estado.
>    - **Excepción confirmada (decisión Edgar 2026-06-23):** los **accents de color por card** en `MetricCard` y las gráficas (sparkline/bars/gauge/donut) **se conservan** — ahí el color **codifica dato**, no decora (igual que los charts de Linear/Stripe). No atenuar a monocromo. La regla "casi monocromático" aplica a la **estructura/chrome** (tablas, paneles, navegación, formularios), no a la capa de data-viz.
> 2. **Separadores apenas perceptibles:** borde 1px (`--border-color`/`--c-divider`); profundidad con sombras mínimas (`shadow-sm`) o ring 1px, **nunca** sombras difusas/pesadas. Radios discretos (`md`/`lg`); pill solo para badges.
> 3. **Densidad Stripe:** `--fs-sm` base, `--fs-xs` para metadatos; jerarquía por **contraste de texto** (`c-text-1` principal / `c-text-2`/`c-text-3` secundario).
> 4. **Tablas:** padding compacto, números/estados a la derecha, texto a la izquierda, **filas separadas por divisor inferior 1px fino**. ⛔ **NADA de zebra striping** (se ve anticuado) — `surf-table--zebra` quedó **neutralizado (no-op)**. Detalle en [`docs/DESIGN_TABLES.md`](docs/DESIGN_TABLES.md).

---

## ✈️ Checklist pre-vuelo (LEER ANTES DE TOCAR FRONTEND)

> **Regla dura:** antes de crear o editar cualquier archivo frontend (componente Angular, HTML, SCSS/CSS, token), se lee esta sección + [`tokens.css`](apps/view/src/styles/tokens.css). No es opcional.
> Cada punto enlaza a su detalle binding abajo. Si algo aquí choca con el requerimiento, se expone el conflicto y decide Edgar — no se resuelve en silencio.

**1. Ubicá tu surface.** [Storefront](#surfaces--dos-modes-del-mismo-sistema) (`/portal/*`, editorial, Poppins, comfortable) o [Operations](#mercado--operations--surface-interno) (`/dashboard` · `/comercial` · `/logistica` · `/admin` · `/vendor` · `/televenta`; denso, sin Fraunces/Poppins display, quiet-luxury). Las reglas cambian por surface.

**2. Cero hex crudo.** Referenciá un [rol/token de 3 tiers](#arquitectura-de-tokens-3-tiers--interacción--densidad-por-puntero); si no existe, agregá el token, no un literal. Estados de superficie = alpha-overlays sobre `--ink-rgb`, no hex por interacción.

**3. PrimeNG-first.** Lo que PrimeNG cubra, con PrimeNG (`p-table`, `p-tag`, `p-dialog`), no HTML crudo. Overrides vía theming/token, sin `!important`.

**4. Tipografía por rol.** Body = Hanken Grotesk · data/cifras/SKU/folio = Geist Mono con **`tabular-nums` obligatorio** · display Poppins **solo** en Storefront. Nunca Fraunces (retirada) ni `system-ui` como display.

**5. Color disciplinado (quiet-luxury).** Marca (sunset `--action`) solo en CTA / activo / seleccionado / foco. IA = **ember** (mata morado `#8b5cf6` y azul `#2563EB`). Semánticos vía `p-tag [severity]`, nunca hex inline. Color nunca es único portador de significado (+ icono/texto). Excepción: data-viz (`--chart-*`) y accent por `MetricCard` codifican dato.

**6. Matriz de estados completa** (el happy path no basta): `hover` · `focus-visible` (ring tokenizado, jamás `outline:none`) · `active` (crítico en touch) · `disabled`; `loading` (skeleton dimensionado, CLS 0) · `empty` (con CTA + microcopy de dominio) · `error` (`catchError` + banner + reintento) · `overflow` (texto 10×). **Empty ≠ error de red.** → [Ingeniería de UI §2](#ingeniería-de-ui--contrato-de-implementación-binding).

**7. Datos densos** (Operations): [elevación = borde 1px *o* sombra, nunca ambas](#reglas-canónicas-de-datos-densos-crm--inventario--binding); fila tokenizada (`--row-h-*`); optimistic UI sin spinner; skeleton-filas; header sticky + 1ª columna congelada; side-peek para detalle; inline-edit 1 campo; **nada de zebra**.

**7b. Cards — cero `p-card` plana / stat-card suelta.** Toda card se construye con un arquetipo del **repertorio** ([`FASE_J16_CARD_REPERTOIRE.md`](docs/IMPLEMENTACION/FASES/FASE_J16_CARD_REPERTOIRE.md)): KPIs → `MetricCard` (`shared/components/cards/`), y para entidad/alerta/checklist/insight/donut/mini-table/timeline los componentes del mismo dir. Base compartida (hairline + stripe 3px + spotlight), cifras Geist mono con **count-up**, [dinamismo = dato, no decoración](#motion-de-kpi-cards-binding) (`DESIGN_MOTION_KPI_CARDS.md`), **variedad por tipo de dato** (nunca 4 cards idénticas), 0 hex. Evolución en diseño (cards vivas: odómetro/flash, bullet/heat-strip, drill): [`FASE_J17_CARD_SYSTEM_2.0.md`](docs/IMPLEMENTACION/FASES/FASE_J17_CARD_SYSTEM_2.0.md).
>
> **ADR-033 (2026-07-17) — arquetipo `MetricStrip` "sin caja" para KPI headers.** Para los **encabezados de KPIs de página** (el número+etiqueta que antes vivía en decenas de cajitas `.kpi`/`rk-card` ad-hoc) el arquetipo canónico ahora es [`MetricStrip`](apps/view/src/app/shared/components/metric-strip/metric-strip.component.ts) (`shared/components/metric-strip/`): **cero bg/borde/radio por métrica**, separación por hairline 1px, cifras Geist mono tabular con count-up on-view, color solo en la cifra vía token semántico (`ok/warn/bad/brand`, flipa en dark), delta multimodal, modo texto refinado (nombres/fechas), y modos `strip · spark · ring · bullet · composition` por forma del dato. `prefers-reduced-motion` respetado; móvil colapsa a grid 2×2. `MetricCard` (cajita rica con stripe/spotlight) se conserva para **dashboards con micro-viz propia** (home, /dashboard/reports, routes-analysis, stores-tab): esos NO se aplanan — ahí la caja + gauge/sparkline codifican dato. Regla: **header de KPIs de una pantalla → `MetricStrip`; tile rico individual con su viz → `MetricCard`.** Barrido de adopción 2026-07-17 (28 pantallas view migradas).

**8. Motion con techo** (150/250/**350ms máx**, ease-out): **solo `transform`+`opacity`**; `prefers-reduced-motion`; `NgZone.runOutsideAngular` para callbacks de alta frecuencia; limpiar en `DestroyRef`. GSAP **no** es dependencia hoy. → [Ingeniería de UI §4](#ingeniería-de-ui--contrato-de-implementación-binding).

**9. Reutilizable = `libs/` + container queries.** Componente que se embebe en varios anchos reacciona a `@container`, no a viewport. → [§5](#ingeniería-de-ui--contrato-de-implementación-binding).

**10. Dominio + seguridad.** Divisa/fecha vía `Intl`/pipes es-MX (`registerLocaleData`); TZ ya normalizada en backend, no re-convertir con `new Date()`. Cero `[innerHTML]` sin `DomSanitizer`; jamás `bypassSecurityTrustHtml` sobre input de usuario. Estado de filtros/selección en URL. → [§7–§9](#ingeniería-de-ui--contrato-de-implementación-binding).

**11. a11y AA piso** (APCA guía en texto chico): `aria-label` en icon-buttons, foco al abrir/retorno al cerrar dialogs, targets ≥44px en touch (`pointer: coarse`). → [§3](#ingeniería-de-ui--contrato-de-implementación-binding).

**12. Verificá.** Build prod `nx build <p> --skip-nx-cache` de lo tocado; probar vivo (endpoint nuevo → o avisar que falta restart); QA con datos reales extremos, **light + dark + móvil** (los tres, siempre).

**12b. Modo oscuro — SIEMPRE.** Dark es first-class, no un pase final. En cada componente/estilo: usar solo tokens que flipean por tema (nunca hex crudo — un `#fff`/`#ddd`/`--border` inexistente se ve bien en light y roto en dark); las sombras casi desaparecen en dark → la profundidad la lleva el **borde 1px**; verificar contraste AA en **ambos** temas (no naive-invert). `#fff`/`#000` literales solo si son correctos en los dos (ej. preview de hoja de papel).

---

## Arquitectura de tokens (3 tiers + interacción + densidad por puntero)

Implementado 2026-06-24 en [`tokens.css`](apps/view/src/styles/tokens.css). Regla: **un componente nuevo referencia un rol/token, nunca inventa un hex.**

- **Tier 1 — Primitivas** (valor crudo, sin significado): rampa `--stone-50..950`, `--brand-*`, paleta cruda. No usar directo en componentes.
- **Tier 2 — Semánticos/rol** (qué significa): `--action`/`--action-hover/press`, `--ok/warn/bad/info-*`, superficies (`--card-bg`, `--border-color`, `--text-1/2/3`), y la **capa de interacción por alpha-overlay**: `--overlay-hover` / `--overlay-active` / `--overlay-selected`, derivados de **`--ink-rgb`** (la tinta del overlay; **se voltea por modo** — light=stone-950, dark=stone-50 — así una sola definición sirve en ambos temas).
- **Tier 3 — Componente** (valor exacto por elemento; cambiar el look de un componente = tocar SU token, sin efectos colaterales): `--table-row-hover-bg`, `--table-row-selected-bg`, `--surface-hover-bg/active/selected`, `--btn-primary-bg/-hover/-press/-ink`. (`--table-hover` quedó repuntado a `--overlay-hover`.)
- **Estados de superficie** = **alpha overlays** sobre `--ink-rgb`, no hex por interacción → consistencia garantizada en cualquier fondo y en dark sin segunda definición.
- **Spacing — escala 4px** (`--sp-1`=4 … `--sp-12`=48, en rem para respetar zoom). Es el **único origen** de paddings/gaps/margins de layout; nada de rem sueltos fuera de grid. Excepciones legítimas: 1px (bordes/hairlines) y micro-nudges <4px en chips/badges. La tipografía tiene su propia escala (`--fs-*`).
- **Densidad por método de entrada** (Polaris/Carbon): la densidad la decide el **puntero**, no el surface. `@media (pointer: coarse)` sube `--row-h-sm/md` y `--tap-min` a **≥44px** (Ley de Fitts en touch / `apps/vendor` Capacitor); `pointer: fine` mantiene ultra-compacto. Hit areas táctiles aplicadas en `styles.css` sin tocar componentes.
- **Data-viz**: secuencia categórica `--chart-1..8` (light+dark), ordenada por separación perceptual, **sin morado** (`--chart-3` es verde). El color codifica dato → exenta de la regla monocromática.
- **Diferido**: SSOT JSON + Style Dictionary (export web/Tailwind/Android nativo) — se monta cuando la divergencia multiplataforma realmente lo exija; por ahora puente manual de los ~4 colores que la status-bar/splash de Capacitor necesita.

## Surfaces — dos modes del mismo sistema

| Surface | Alcance | Mode | Decoración | Display font |
|---|---|---|---|---|
| **Storefront** | `/portal/*` (Portal Web B2B) | storefront + tool | intencional (ilustraciones SVG, eyebrows) | Poppins + Hanken Grotesk + Geist Mono |
| **Operations** | `/dashboard`, `/comercial`, `/logistica`, `/admin`, `/vendor`, `/televenta` | **solo tool** | nula | Hanken Grotesk + Geist Mono (sin Fraunces) |

Ambos surfaces comparten: paleta Stone, sunset acción, IA ember, dark espresso, escala de radios, tokens semánticos. Lo que **Operations** descarta: Fraunces, ilustraciones, momentos editoriales, densidad comfortable.

La regla 1-línea: Operations es el portal pero sin storefront. Mismo lenguaje, menos drama.

---

## Tesis de diseño

Una herramienta de pedido mayorista que se siente como una **marca CPG mexicana premium**, no como un dashboard SaaS genérico. Resuelve el hueco que casi nadie ocupa: los gigantes B2B que la gente ama (McMaster-Carr, Uline) son utilitarios y rapidísimos pero feos; la nueva ola (Faire) es editorial y cálida pero lenta. **Mercado hace las dos cosas**, porque el comprador no es un agente de compras — es un dueño de dulcería (prosumer) que quiere sentir que por fin tiene una herramienta seria.

**Lo memorable, ordenado por jerarquía** (no los tres con el mismo peso — eso sería memorable por nada):
1. **Velocidad = la columna.** Pantallas transaccionales densas, instantáneas, teclado-first (la lección McMaster).
2. **Premium = la textura.** Tipografía y calidez hacen ver pro a un changarro. Momentos editoriales solo en home/promos (la lección Faire).
3. **IA = el acento.** El diferenciador real, con identidad visual propia (**ember ámbar**) — nunca el morado genérico de la industria.

### Regla de dos modos (define todo)
- **Tool mode** (catálogo, carrito, pedidos): denso, escaneable, compacto. Body bold, cifras tabulares, naranja-acción.
- **Storefront mode** (home, promos, login): editorial, con aire, Poppins display (sans geométrica), ilustración.

---

## Product Context
- **Qué es:** portal de autoservicio B2B donde una dulcería/tienda inicia sesión, ve el catálogo con SU lista de precios, busca (texto o IA semántica), recibe recomendaciones IA, arma carrito y hace/seguimiento de pedidos con estado en tiempo real.
- **Para quién:** dueños de pequeños comercios de dulces en México (prosumers, no compradores profesionales). Mobile-first (Capacitor) y desktop.
- **Espacio:** wholesale ordering / B2B e-commerce. Peers de referencia: McMaster-Carr y Uline (velocidad utilitaria), Faire (editorial branded), Pepperi/Wizcommerce (order-taking).
- **Tipo:** web app transaccional con superficies editoriales.

---

## Aesthetic Direction
- **Dirección:** Warm Editorial Utilitarian ("Mercado").
- **Nivel de decoración:** intencional — gradientes cálidos, ilustraciones SVG propias de dulces (mantener: son originales y encantadoras), sin fotos stock.
- **Mood:** cálido, confiado, rápido. "Mi herramienta de trabajo, y se ve bien."
- **Anti-slop (prohibido):** morado/violeta para IA, gradientes morados, grids de 3 features con íconos en círculos de color, todo centrado, fotos stock genéricas, `system-ui` como display.

---

## Typography

Cargadas desde Google Fonts en [`apps/portal/src/index.html`](apps/portal/src/index.html).

- **Display/Hero:** **Poppins** (sans geométrica redondeada — look "delivery app" tipo Rappi). Pesos 500/600/700/800. Solo en **storefront mode**: hero h1, section heads, empty states, títulos de promo, monogramas. **Nunca** en tablas/UI densa. *(Cambiado de Fraunces serif → Poppins el 2026-06-24, decisión de marca: identidad táctil tipo Rappi sobre editorial.)*
- **Body/UI:** **Hanken Grotesk** (reemplaza a Inter) — grotesca redonda, cálida, amigable, muy legible. Pesos 400/500/600/700/800.
- **Data/Tablas/Code:** **Geist Mono** (reemplaza a JetBrains Mono) — SKUs, códigos de pedido, precios en columna, atajo `⌘K`. **Obligatorio `font-variant-numeric: tabular-nums`** en todo lo que sea dinero o cantidad.
- **Por qué:** Inter es el default de convergencia. Poppins (display) + Hanken Grotesk (body) dan el carácter geométrico-cálido de las apps de delivery, sin serif. Poppins NO se usa en Operations (sigue tool-only).
- **Escala display** (clamp responsive, ya en tokens):
  - `--text-display-xl: clamp(2.5rem, 7vw, 3.5rem)` — hero h1
  - `--text-display-lg: clamp(1.875rem, 4.5vw, 2.5rem)` — section feature
  - `--text-display-md: clamp(1.375rem, 3vw, 1.625rem)` — card title
- **Escala UI:** 0.7 / 0.75 / 0.8125 / 0.875 / 0.9375 / 1 / 1.125rem. Tool mode tira hacia abajo; storefront hacia arriba.

```html
<!-- index.html -->
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700;800&family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```
```css
--font-display: 'Poppins', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-body:    'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--font-mono:    'Geist Mono', ui-monospace, 'Courier New', monospace;
```

---

## Color

Mantiene la calidez de marca Mega Dulces, pero **reasigna los roles**: el amarillo deja de ser "primary de acción" (no puede llevar texto blanco — el propio token lo admite) y pasa a ser sello de marca; el **naranja-sunset toma la acción**.

### Brand ramp (cálido — se conserva)
```css
--brand-50:#FFFEF0; --brand-100:#FFF8BC; --brand-200:#FEEC7C; --brand-300:#FDE044;
--brand-400:#FDE707; /* SELLO de marca — momentos, logo, pulsos "live". NUNCA bg de botón con texto. */
--brand-500:#F8B400; --brand-600:#F68F1E;
--brand-700:#F05A28; /* SUNSET */
--brand-800:#C53E15; --brand-900:#8C2308; --brand-950:#4B1300;
```

### Acción (color interactivo — NUEVO rol)
```css
--action:       #F05A28;            /* botones, links, foco, steppers, "+" */
--action-hover: #D2451C;
--action-press: #B83C15;
--action-ink:   #FFFFFF;            /* texto sobre --action (AA OK) */
--action-ring:  rgba(240,90,40,0.30);
```
Regla: amarillo `#FDE707` solo con texto oscuro (`--stone-950`), nunca blanco.

### Neutrales cálidos — Stone (reemplaza Zinc frío)
```css
--stone-50:#FBF9F6; --stone-100:#F5F1EA; --stone-200:#E8E2D7; --stone-300:#D8CFC0;
--stone-400:#B0A595; --stone-500:#837A6C; --stone-600:#5E564B; --stone-700:#463F36;
--stone-800:#2B2620; --stone-900:#1A1611; --stone-950:#100D09;
```
Esta es la palanca que mata el "frío SaaS": cada superficie toma un sustrato cálido.

### IA — Ember (mata el `#8b5cf6` morado)
```css
--ember-from:  #F8B400;
--ember-to:    #F05A28;
--ember-grad:  linear-gradient(135deg, #F8B400 0%, #F05A28 100%);
--ember-soft:  rgba(248,180,0,0.12);   /* dark: 0.16 */
--ember-border:rgba(240,90,40,0.30);
```
Toda superficie de IA (búsqueda semántica, chips "Sugeridos IA", recomendaciones, scores de relevancia, FAB asistente) usa el gradiente ember + un sello ✦. La IA se vuelve reconocible de un vistazo **y** on-brand.

### Semánticos
```css
--ok-fg:#16A34A; --ok-soft-bg:#DCFCE7; --ok-soft-fg:#166534; --ok-border:#BBF7D0;
--warn-fg:#D97706; --warn-soft-bg:#FEF3C7; --warn-soft-fg:#92400E; --warn-border:#FDE68A;
--bad-fg:#DC2626; --bad-soft-bg:#FEE2E2; --bad-soft-fg:#991B1B; --bad-border:#FECACA;
--info-fg:#2563EB; --info-soft-bg:#DBEAFE; --info-soft-fg:#1E40AF; --info-border:#BFDBFE;
```

### Superficies — LIGHT
```css
--surface-ground: var(--stone-50);
--card-bg:        #FFFFFF;
--layout-bg:      var(--stone-100);
--hover-bg:       var(--stone-100);
--border-color:   var(--stone-200);
--text-main:  var(--stone-950);
--text-muted: var(--stone-600);
--text-faint: var(--stone-400);
```

### Dark mode — espresso cálido (reemplaza `#000` puro)
`body.theme-monochrome`:
```css
--surface-ground:#1A1611; --card-bg:#1F1A14; --layout-bg:#16130F;
--hover-bg:#2B2620; --border-color:#352E25;
--text-main:#FBF4E9; --text-muted:#B0A595; --text-faint:#837A6C;
--ember-soft: rgba(248,180,0,0.16);
```
Negro puro bajo una marca cálida se ve duro/barato; el espresso conserva la calidez en oscuro.

---

## Spacing
- **Base:** 4px.
- **Densidad:** **compact** en tool mode (catálogo, carrito, pedidos, listas), **comfortable** en storefront (home, promos, login).
- **Escala:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).

## Layout
- **Enfoque:** híbrido — utilitario en tool mode, editorial en storefront.
- **Velocidad primero:** búsqueda sticky con `⌘K`, acceso permanente a reordenar, steppers inline, agregado directo desde la card.
- **Catálogo: vista conmutable grid ⇄ lista.**
  - **Grid:** cards `minmax(180px, 1fr)`, 4-5 columnas desktop. Default.
  - **Lista:** filas densas `[thumb 38px | nombre+SKU/marca/mín | flag IA/promo | precio tabular | stepper]`. Para el que sabe exactamente qué quiere (estilo McMaster). Estado recordado por usuario.
- **Reorder rail:** strip horizontal de los más pedidos (90d) arriba del catálogo.
- **Sticky cart bar:** pill flotante con conteo + total tabular + CTA (tool mode).
- **Max content width:** 1180–1280px. **Mobile:** tab bar flotante (pill) + sidebar desktop (ya implementado).
- **Border radius (tokens en `tokens.css`):** `--r-sm` 8px · `--r-md` 12px (controles/botones) · `--r-lg` 16px (tarjetas) · `--r-xl` 20px (tarjetas grandes) · `--r-2xl` 24px (hero) · `--r-pill` 999px. Usar siempre el token, no el valor hardcodeado.

## Motion
- **Enfoque:** intencional, rápido. No decorativo.
- **Easing:** `--ease-standard: cubic-bezier(0.2, 0, 0, 1)`.
- **Duración:** micro 50-120ms · short 150-250ms · medium 250-400ms.
- **Mobile:** usar `HapticService` en acciones (add to cart, confirmar).
- **Siempre** respetar `@media (prefers-reduced-motion: reduce)` (ya hecho en el portal).

---

## Sistema de botones «Confite» (Storefront) — BINDING

> Implementado 2026-06-24 en `apps/portal/src/styles.css` (átomos `.portal-btn-*`).
> **Identidad táctil repetible** — análoga a la "esencia" de Rappi pero monocromática
> con acento de marca. NO re-estilar botones por componente: usar estos átomos.

**El ADN (5 rasgos):** geometría redonda (pill) · profundidad suave (sombra de color difusa) ·
tactilidad (lip inferior + press físico) · brillo "render" sutil (gloss neutro) · tipografía confiada (700).

**La receta (los 5 ingredientes de la firma):**

1. **Píldora** — `border-radius: var(--r-pill)` por default (la `-pill` legacy es no-op ahora).
2. **Gloss** — `::before` con `linear-gradient(180deg, rgba(255,255,255,.16), transparent)` en el tercio superior. Solo en rellenos sólidos (primary/ember/hero), NO en ghost.
3. **Lip** — `inset 0 -3px 0 rgba(0,0,0,.16)` (borde inferior que da cuerpo físico).
4. **Halo** — drop-shadow de color (`--action-ring`) SOLO en primary; el resto usa sombra neutra.
5. **Press** — `:hover` sube `translateY(-2px)`; `:active` baja `translateY(1px)` y colapsa la sombra. Easing `--ease-spring`.

**Regla de color (monocromática — BINDING):**

- **`.portal-btn-primary` = la ÚNICA acción en color** (sunset `--action`). Es el CTA de conversión.
- `.portal-btn-ghost` = neutro; **hover en gris** (`--neutral-400`), nunca en color.
- `.portal-btn-ember` (IA) = **carbón** (`--neutral-950`) + susurro ámbar (glow en la sombra). Ya NO es gradiente.
- `.portal-btn-hero` = carbón + texto amarillo sello (`--brand-400`).
- El `+` del catálogo (`.cat-add`) y la promo nativa (`.cat-promo-add`): negro + sello, con lip/press.
- El gloss y el lip son **blanco/negro** → dan profundidad sin agregar color.

**Cómo extender:** cualquier botón nuevo usa `.portal-btn-primary|ghost|ember|hero` (+ `-lg`/`-block`). Un control custom (stepper, FAB, circle) copia los 3 insets (`halo, lip, gloss`) + el patrón hover/active. Mantener el gloss **sutil** (≤.18 alpha) — quiet-luxury, no caricatura.

---

## Patrones del portal aplicados (2026-06-24) — referencia para seguir construyendo

Derivados de la investigación (`docs/IMPLEMENTACION/INVESTIGACION_UX_PORTAL_VENTA.md`: Baymard, NN/g, Polaris, Material 3, Instacart). Estado: **en código, builds verdes**.

| Patrón | Dónde | Regla para replicar |
|---|---|---|
| **Thumbnails monocromáticos** | `core/util/brand-placeholder.ts` (fuente única) | Placeholder sin foto = gradiente **Stone oscuro** determinista por `product_id`. Monograma blanco. Cero color en thumbnails — el color es para CTA/promo/estado. |
| **Reorden-primero** | `portal-home` | "Comprar de nuevo" va en el **primer pliegue**, sobre el hero. El cliente B2B es transaccional, no exploratorio. |
| **Promo nativa** | `portal-catalog` (`.cat-promo-native`) | Promos = unidad **en contexto** al tope de resultados (estética de card + etiqueta amarilla "Destacado"), NUNCA banner hero (banner blindness). 1 por pliegue. |
| **CTA sticky en sheet** | `portal-catalog` (`.cat-sheet-actions`) | En bottom-sheets, el botón de acción va `position: sticky; bottom: 0` para que nunca se pierda al scrollear. |
| **Cross-sell** | `portal-catalog` (`sheetCrossSell`) | "Va bien con esto" = 3 SKUs. Hoy heurístico (top-sellers); migrar a afinidad real (Thot) cambiando la fuente del `computed`. |
| **Upsell de mínimo** | `portal-cart` (`.ca-min-upsell`) | Convertir la restricción ($2,500) en oportunidad: "te faltan $X" + barra de progreso + sugerir. No bloquea. |
| **Tab bar Material 3 + búsqueda circular** | `portal-shell` (`.portal-tabdock`) | Móvil = **4 destinos persistentes** + botón de búsqueda circular aparte (firma Rappi). El carrito es acción con badge, no tab co-igual. Desktop conserva la nav completa. |

**Color discipline (toda superficie nueva):** lienzo neutro Stone; el color de marca solo en — (1) CTA de conversión, (2) tab/chip activo, (3) badge de descuento/promo, (4) estado "en vivo", (5) focus ring. El color **nunca** es el único portador de significado (Polaris/WCAG): siempre + icono o texto.

---

## Hallazgos del portal actual (auditoría 2026-06-04)

> 🗄️ **HISTÓRICO — mayormente resuelto.** Los 🔴/🟡 (morado IA→ember, Inter→Hanken, amarillo→sunset, Zinc→Stone, dark espresso) ya se aplicaron; se conserva por trazabilidad, no es checklist operativo. Lo vigente está en el [checklist pre-vuelo](#️-checklist-pre-vuelo-leer-antes-de-tocar-frontend).

Prioridad: 🔴 alto impacto · 🟡 medio · 🟢 pulido.

1. 🔴 **AI-slop morado.** `--ai-accent: #8b5cf6` (chips "Sugeridos IA" en `portal-catalog`) es exactamente el morado al que toda la industria convergió. La IA — tu diferenciador #1 — está pintada del color más genérico posible. **Fix:** reemplazar por `--ember-grad`. Bajo esfuerzo, máximo payoff.
2. 🔴 **Inter como body.** Default de convergencia. **Fix:** swap `--font-body` → Hanken Grotesk (token único).
3. 🟡 **Rol del amarillo inconsistente.** `--brand-400` está documentado como "PRIMARY" pero no puede llevar texto blanco (AA 1.07). Hoy los botones primary terminan siendo `--neutral-900`/negro porque el amarillo no sirve. **Fix:** formalizar naranja-sunset como `--action`; amarillo = sello.
4. 🟡 **Display font inconsistente.** `.cat-h1` y `.ph-hero-h1` usan Fraunces, pero la utilidad compartida `.portal-page-head h1` (styles.css:1833) usa Inter weight-800. Títulos de página distintos según el componente. **Fix:** regla de dos modos — editorial = Fraunces, tool = body bold; aplicarla a `.portal-page-head`.
5. 🟡 **Neutrales fríos (Zinc) bajo una marca cálida.** Choque sutil pero omnipresente que empuja el "feel SaaS". **Fix:** rampa Stone.
6. 🟡 **Dark mode `#000` puro.** Duro bajo marca cálida. **Fix:** espresso `#16130F`.
7. 🟢 **`--accent-soft-bg: #fde68a22`, `--promo-accent: #ef4444` hardcodeados** en `portal-catalog` con fallbacks inline. **Fix:** tokenizar (`--promo-accent` puede mapear a `--brand-700` o un rojo semántico).
8. 🟢 **Mucho color inline en SVGs/gradientes** repetido entre componentes. **Fix:** consolidar en utilidades/tokens (alinea con el sprint UX/UI en curso, ver memoria `project_sprint_ux_ui`).

**Lo que ya está muy bien (conservar):** ilustraciones SVG propias de dulces · accesibilidad (focus rings, `prefers-reduced-motion`, `aria-*`, safe-area insets) · arquitectura de tokens en `tokens.css` · tab bar flotante mobile · steppers inline + estados de carga (skeletons) · estructura editorial del home.

---

## Plan de migración (cuando se implemente — no tocar código aún)

> 🗄️ **HISTÓRICO — APLICADO.** La migración del portal (fonts, Stone, `--action`, ember, dark espresso, regla display) ya está en código. Se conserva como registro del alcance ejecutado.

Casi todo es **swap de tokens** en `tokens.css`, por eso el costo real es bajo:
1. Cargar fonts nuevas en `index.html` (Fraunces + Hanken Grotesk + Geist Mono).
2. `--font-body` → Hanken Grotesk; `--font-mono` → Geist Mono.
3. Renombrar/agregar rampa Stone; apuntar superficies/textos a Stone.
4. Agregar `--action*` y `--ember*`; reemplazar usos de `--ai-accent` (#8b5cf6) y normalizar botones primary a `--action`.
5. Reescribir bloque dark (`body.theme-monochrome`) a espresso.
6. Aplicar la regla display: `.portal-page-head h1` con `var(--font-display)` solo en storefront.
7. Agregar toggle grid/lista en `portal-catalog`.
8. QA: contraste AA en botones `--action`, dark espresso, y `tabular-nums` en toda cifra.

> Alcance acordado: **solo `/portal`**. El resto de la app (dashboard, comercial, logística) sigue con los tokens actuales hasta decidir extender "Mercado" globalmente.

Preview de referencia: `~/.gstack/projects/edgarcg-01-Trade_marketing/designs/portal-redesign-20260604/mercado-preview.html`

---

---

## Mercado / Operations — surface interno

> Alcance: `/dashboard/*` (Trade Marketing), `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`. Usuario tipo: supervisor PdV, vendedor, gerente comercial / logística, admin de tenant. NO es el cliente B2B (eso es Storefront).

### Tesis Operations
Una herramienta de operación que se siente de Mega Dulces, no de Salesforce. **McMaster-Carr LATAM**: densa, instantánea, keyboard-first, cifras alineadas. La calidez viene del color y la tipografía; la velocidad viene del layout y la disciplina. "Esto es serio."

### Memorable thing
Un supervisor que entra una vez recuerda: **velocidad y densidad** — está usando software profesional, no un dashboard pintado.

### Decisiones del sistema (delta vs Storefront)

| Dimensión | Operations | Storefront |
|---|---|---|
| Display font | NO Fraunces. Page-head = Hanken Bold + tracking tight | Fraunces |
| Body font | Hanken Grotesk 13/14/16 | Hanken Grotesk 14/15/16 |
| Data font | Geist Mono + `tabular-nums` obligatorio | Geist Mono |
| Neutrales | Stone cálido (igual que portal) | Stone |
| Acción | `--action` sunset (igual que portal) | Sunset |
| IA | Ember `--ember-grad` (mata `--ai-accent` azul actual) | Ember |
| Dark | Espresso `#16130F` (mata `#000` puro actual) | Espresso |
| Density | **compact++** (más denso que tool-mode portal) | compact / comfortable |
| Primary organism | **Tabla densa + master-detail**. Cards solo para KPIs minimal | Card grid |
| Decoración | nula (sin ilustraciones SVG dulces — son del storefront) | intencional |
| Motion | minimal-functional | intencional |

### Type scale Operations
| Token (sugerido) | Value | Uso |
|---|---|---|
| `--text-page-head` | 18px / 700 / -0.01em | h1 de cada apartado (`Rutas`, `Pedidos`, etc.) |
| `--text-section-head` | 14px / 600 | h2 dentro de cards (`Visitas y tiempos`) |
| `--text-body` | 14px / 400 | filas de tabla, párrafos |
| `--text-data` | 14px / 500 (mono, `tabular-nums`) | cifras, SKU, folios, horas |
| `--text-data-lg` | 18px / 600 (mono, `tabular-nums`) | KPI value |
| `--text-meta` | 12px / 400 / muted | hint, helper, hora secundaria |
| `--text-label` | 11px / 500 / `uppercase 0.06em` / muted | column header, KPI label |

### Color semántico de Trade (estado de visita / ejecución)
- **visitada / fulfilled**: `--ok-soft-bg/fg` (verde)
- **parcial / pending_approval**: `--warn-soft-bg/fg` (ámbar)
- **sin visitar / draft**: chip neutral Stone-200
- **atípica / out-of-range**: `--bad-soft-bg/fg` (rojo) — visita > 2× duración promedio, captura sin geofence, expirada
- **cancelada / fallida**: `--bad-soft-bg/fg` muted
- **sugerencia IA**: ember (`--ember-soft` bg + `--ember-border`)

Regla: siempre `p-tag` con `[severity]` mapeado a token semántico. Nunca hex inline.

### Patrones canónicos Operations
1. **Master-Detail** — Rutas, Pedidos, Clientes, Embarques, Tickets. Aside 280-320px sticky + section flex-1. Mobile: stack con back-button (patrón implementado en `/dashboard/routes` 2026-06-08 — referencia).
2. **KPI Strip** — 4-5 metrics en row, mono-tabular, delta vs target con color semántico. SIN íconos en círculos de color (eso es AI slop).
3. **Tabla densa** — row 40px desktop / 56px mobile, sticky header, scroll horizontal con primera columna pegada, sort visible en header, paginación abajo. PrimeNG `p-table` con `styleClass="p-datatable-sm"`. **Spec completa de tablas profesionales (anatomía, estados, a11y, sort, selección, gaps + plan de adopción): [`docs/DESIGN_TABLES.md`](docs/DESIGN_TABLES.md).**
4. **Empty state operacional** — ícono PrimeIcon mediano + título neutral + descripción + CTA accionable. NUNCA "No items found." sin más. Voz: técnica, no editorial. Ejemplo correcto: "Ninguna ruta registra actividad entre 01/06/26 y 08/06/26. [Ampliar a 30 días]".
5. **Mapa Leaflet** — pin numerado sequence (sunset `--action`), pin gris en pendientes (`--neutral-400`), polyline dashed sunset para recorrido. Token canónico: `var(--action)`, no `var(--brand)`.
6. **Filtros** — rango de fechas top-right del header del apartado, filtros secundarios contextualizados en el card específico que filtran (NO banda global de filtros mid-page que parece ruido).
7. **Status pills** — `p-tag` con severity mapeada al color semántico arriba. Nunca hardcodear bg/fg.
8. **Navegación** — sidebar hover-expand desktop (patrón VS Code) + bottom-nav mobile 4 items + drawer overflow (patrón FB / IG / Slack). Ya implementado en `LayoutComponent`.
9. **Acción única** — `--action` sunset para CTA primario en formularios, modales, headers. Secundaria = ghost. Destructiva = `--bad-fg` ghost (botón ghost-bad pattern de la memoria `feedback_ghost_buttons_pattern`).
10. **A11y línea base** — `focus-visible:ring-2 ring-action`, `aria-current="true"` en master selection, `aria-label` rica en botones sin texto, labels `for/id` formales en inputs, touch targets ≥ 44px mobile.

### Reglas canónicas de datos densos (CRM / Inventario) — BINDING

> Destiladas del benchmark de líderes. Aplican a toda surface Operations con tablas, registros o stock. Fuente y números: [`docs/DESIGN_BENCHMARK_CRM_INVENTORY.md`](docs/DESIGN_BENCHMARK_CRM_INVENTORY.md).

1. **Elevación = una de dos, nunca ambas.** Superficies **in-page** (cards, filas, paneles, KPIs) = **borde 1px hairline `--border-color`, sin sombra**. **Overlays** (menú, popover, modal, ⌘K, toast, drawer) = **sombra + borde**. Prohibido card con sombra dentro de la página. (Attio/Linear)
2. **Densidad de fila tokenizada.** Tabla Operations default **40px (`--row-h-md`)**; toggle a **32px (`--row-h-sm`)** para power users; **48px (`--row-h-lg`)** solo si la fila lleva avatar + 2 líneas. Nunca dos densidades en un mismo card. (Carbon)
3. **Optimistic UI en toda mutación de 1 registro** (cambiar estado, asignar, editar inline, ajustar qty): mutar estado local sync → reconciliar con server → rollback visible en error. **Sin spinner** en estas acciones. (Linear)
4. **Carga:** skeleton-shell a nivel ruta + **filas skeleton** a nivel data (shimmer, nunca spinner de bloque). Spinner solo <300ms inline. (Stripe/Linear)
5. **Tabla:** header **sticky**; **primera columna congelada** (nombre entidad / SKU) en grids anchas; hover de fila con tint sutil; selección = checkbox + bg tintado; acciones de fila = icon-buttons ghost revelados en hover, a la derecha.
6. **Acciones masivas:** al seleccionar ≥1 fila, sube una **bulk-bar** (slide-up ~200ms) con conteo + ops batch, reemplazando el toolbar.
7. **Paginar** data transaccional/auditable (pedidos, facturas, ledger de stock) — server pagination 25–50 filas; **infinite virtualizado** solo en listas exploratorias o >200 filas visibles.
8. **Detalle = side-peek drawer** (~480–560px, slide desde derecha, ~250ms) para ver/editar manteniendo la lista; **full page** solo para create/edit multi-sección complejo. (Attio)
9. **Inline edit** para cambios de 1 campo (Enter commit / Esc cancel / Tab→derecha). Modal solo para confirmaciones destructivas o create con muchos requeridos.
10. **Escala tipográfica de tabla** (ya en tokens Operations): header `--text-label` 11–12px/600 muted +0.02–0.06em · valor `--text-data` 13–14px/450 · meta `--text-meta` 12px muted · lh 1.25–1.35. `tabular-nums` **obligatorio** en toda celda numérica/dinero/qty/fecha (Geist Mono **y** números inline en Hanken).
11. **Motion con techo duro:** 150ms micro · 250ms standard · **350ms máx**, ease-out. Animar **solo `transform`+`opacity`**; jamás `width/height/margin/padding` en tablas (reflow). No animar filas/celdas al cargar data.
12. **Command palette ⌘K / Ctrl+K** cuando una surface tenga 20+ destinos/acciones: navegar **+ actuar** (cambiar estado, asignar, crear), fuzzy, solo-teclado, modal 560–640px con sombra.
13. **A11y piso:** anillo de foco **2px ≥3:1 contraste** (`--action-ring`) en todo interactivo; **icon-button hit area ≥24px** (44px objetivo mobile); focus no obstruido por headers sticky.

### Motion de KPI cards (BINDING)

> Cómo hacer las cards dinámicas/gráficas sin romper "esto es serio". Fuente y números: [`docs/DESIGN_MOTION_KPI_CARDS.md`](docs/DESIGN_MOTION_KPI_CARDS.md).

1. **Dinamismo = dato, no decoración.** El movimiento permitido es: count-up del número, sparkline/mini-chart de la serie, delta con flecha, flash-on-change. Prohibido: gradientes que laten, íconos girando, badges flotando, ember decorativo en tiles.
2. **Tile canónico de 3 capas:** número (Geist Mono `tabular-nums`) + sparkline SVG inline + **delta multimodal `▲ +3.2%`** (flecha+signo+número, nunca solo color).
3. **Count-up:** on-view (IntersectionObserver), **una vez**, ~900ms `--ease-out`, vía `rAF`→signal. Valor final en el DOM para SR. Bajo `prefers-reduced-motion` → instantáneo. **Nunca** en poll/re-render.
4. **Micro-charts = SVG crudo (0 KB).** Nada de Chart.js/Apex para sparklines. uPlot solo si aparece panel time-series interactivo.
5. **Entrada:** stagger one-time en primer paint (`translateY(8–12px)+opacity`, 150–250ms/card, stagger 30–60ms). Jamás en refresh.
6. **Hover/press:** `:active scale(0.97)`; hover lift `translateY(-1px)` + revelar borde/acento, 120–150ms. Sin glow ni barrido de color.
7. **Presupuesto:** todo **<300ms**, `ease-out`, **solo `transform`+`opacity`**, CSS para hover/entrada y rAF solo para count-up.
8. **Skeleton dimensionado** (CLS 0) + crossfade ~180ms a data.
9. **Variedad por tipo de dato — las cards NO deben ser todas iguales.** Cada KPI lleva la micro-viz que su dato pide, y eso las diferencia visualmente: **serie temporal → sparkline/mini-barras** · **ratio/cobertura → barra de progreso con %** · **actual vs meta → bullet** · **% acotado → ring** · **valor único sin serie → headline grande** (count-up, sin chart falso). Un strip donde las 4 cards son idénticas (mismo layout, solo cambia el número) es plano y se siente genérico — usar el tipo de métrica para dar ritmo visual. Nunca inventar una serie/chart si no hay dato real (eso es slop, §9).

### Tokens de estado de dominio (mapear, no inventar hex)
- **Inventario (escalada gradual):** in-stock → `--ok-*` · low-stock → `--warn-*` · out-of-stock → `--bad-*` · overstock (opcional) → `--info-*`. El umbral low→crítico mueve el chip de ámbar a rojo.
- **CRM / pipeline:** new/lead → `--info-*` (slate/azul) · qualified/in-progress → `--warn-*` · won/fulfilled → `--ok-*` · lost/cancelled → `--bad-*` · on-hold/draft → chip neutral Stone-200.
- **Regla:** siempre `p-tag [severity]` mapeado a estos semánticos. Nunca hex inline.

### SAFE choices (no inventar — es categoría operacional)
- Master-detail patrón
- Tabla como primary organism (no card grids)
- Sidebar desktop hover-expand + bottom-nav mobile
- Status semantics clásico verde/ámbar/rojo

### RISK choices (donde Mega Dulces se diferencia de cualquier ERP)
1. **Stone + sunset + ember en backoffice**: 95% de tools internas son Zinc/blue/Inter. Mover Operations a la paleta del portal hace que el supervisor sienta que es la MISMA empresa, no "el portal por un lado y la herramienta de trabajo por otro". Costo: swap de tokens. Win: identidad cross-app.
2. **No Fraunces ni decoración en internal**: muchos ERPs meten serif en empty states para no verse crudos. Aquí vamos full grotesque honesto. Costo: empties visualmente más fríos. Win: refuerza la promesa "esto es serio".
3. **IA ember preventivo en backoffice**: cuando Trade agregue scoring assist / anomaly detection / product match (Fase K extension), ya tiene identidad coherente con portal. Costo: nada hoy. Win: evita el reflejo "azul SaaS" o "morado AI" cuando aparezca el primer feature IA en operations.

### Plan de migración Operations (tokens-only, sin tocar componentes)

> 🗄️ **HISTÓRICO — APLICADO (2026-06-16).** La migración Operations (Hanken/Stone/sunset/ember en `:root`) ya está en `tokens.css`; el dark de Operations quedó en **zinc neutro `#111111`** (no espresso — ver nota de estado del encabezado). Se conserva como registro. *(La nota "NO aplicado todavía" quedó obsoleta.)*

Costo bajo: casi todo es swap de tokens en `tokens.css`.

1. `--font-body` → Hanken Grotesk globalmente en `:root` (hoy `Inter`).
2. `--font-mono` → Geist Mono globalmente (hoy `JetBrains Mono`).
3. Aliasar `--neutral-50..950` → `--stone-50..950` en `:root`. El portal ya lo hace localmente; será no-op para él.
4. `--ai-accent` → `--action` sólido (o `--ember-grad` para chips que soporten gradiente). Mata el `#2563EB` azul tibio actual.
5. `--active-bg: var(--neutral-950)` → revaluar: ¿negro hard o stone-950? Bajo paleta cálida el negro puro se ve agresivo. Recomendación: stone-950 light, stone-50 dark.
6. Dark mode `:root` → espresso: copiar el bloque `.portal-shell body.theme-monochrome` al `body.theme-monochrome` global.
7. Cargar Hanken + Geist Mono en `index.html` sin scope (ya están cargados — verificar).
8. Pin tokenizado en [`MapComponent`](apps/view/src/app/shared/components/map/map.component.ts): `var(--brand, #f97316)` → `var(--action)`. Aplica también a [`routes-analysis`](apps/view/src/app/modules/dashboard/routes-analysis/routes-analysis.component.ts) que tiene el mismo fallback inline.
9. `--focus-ring` → `--action-ring` globalmente.
10. NUNCA Fraunces fuera de `.portal-shell` ni `.pl-wrap` — regla explícita.

QA tras migrar:
- Contraste AA en `--action` sobre `--card-bg` light + dark.
- `tabular-nums` en TODO precio, cantidad, hora, score, folio.
- Dark espresso no rompe la paleta de charts (`--chart-1..8` dark ya redefinida — verificar contra fondo espresso).
- Smoke visual: `/dashboard`, `/dashboard/routes`, `/comercial/command-center`, `/comercial/orders`, `/logistica/dashboard`, `/admin/users`.

### Antipatrones para Operations (flag en review)
- Inter como `--font-body` en cualquier surface (es default de convergencia).
- Cards con íconos en círculos de color como decoración (AI slop #3).
- 3-column feature grid (AI slop #2) — aquí no aplica porque es tool, pero alguien podría caer en eso para un dashboard de KPIs.
- `#000` puro en dark mode.
- `--ai-accent: #8b5cf6` morado o `#2563EB` azul.
- Hex inline en color de pin Leaflet u otros componentes compartidos.
- Centered everything en empties.
- Empty state "No items found." sin contexto ni CTA.

---

## Ingeniería de UI — contrato de implementación (BINDING)

> Alcance: **toda** superficie (Storefront + Operations + apps instalables). Añadido 2026-07-10.
> Complementa lo visual con el *cómo se construye*: por qué una composición funciona a nivel cerebral, cómo no se rompe con datos/errores reales, y cómo el motion no janquea ni fuga memoria. Base teórica: [`docs/DESIGN_FOUNDATIONS.md`](docs/DESIGN_FOUNDATIONS.md). Estas reglas se **verifican en review**, no son aspiracionales.

### 1. Fundamento cognitivo obligatorio (el *por qué*, no la etiqueta)
Toda decisión de layout se justifica por su **mecanismo perceptual**, no citando la ley suelta:
- **Gestalt (proximidad/similitud/continuidad)** = agrupación que baja el parsing visual de *n* elementos a *k* grupos. Un grupo se forma con **espaciado** (escala 4px), no con cajas/bordes por default — el borde es el último recurso, no el primero.
- **Hick** = recortar decisiones *simultáneas*. En toolbars densas y menús: curaduría + progressive disclosure antes que listar 20 acciones planas (→ `⌘K` cuando hay 20+ destinos, regla ya binding en datos densos §12).
- **Fitts** = target = f(distancia, tamaño). CTA primario grande y en zona alcanzable; en touch, `≥44px` (ya tokenizado por `pointer: coarse`). **Conflicto densidad↔Fitts:** en Operations `fine` gana la densidad (32–40px); en `coarse` gana Fitts (44px). No se promedia — lo decide el puntero.
- **Carga cognitiva** = la composición elegida debe *reducir esfuerzo mental*; si un layout necesita una leyenda para entenderse, falló. Jerarquía por **contraste de texto y peso**, no por más color.
- Patrón de lectura **Z** (pantallas de marketing/storefront) vs **F** (tablas/listas densas Operations): el CTA/acción principal cae donde el patrón deposita el ojo, no centrado por estética.

### 2. Matriz de estados por componente (el happy path es la fila 1, no la entrega)
Ningún componente se considera terminado sin sus estados. Cada entrega los declara:
- **Interacción:** `hover` · `focus-visible` (ring tokenizado, **nunca** `outline:none` a secas) · `active` · `disabled`. En touch, `active` (feedback ≤100ms) es el estado crítico — **nada** puede depender solo de `hover`.
- **Datos:** `loading` (skeleton dimensionado al contenido real → CLS 0; shimmer, no spinner de bloque — ya binding §4 datos densos) · `empty` (con acción de recuperación y microcopy de dominio, ver §7) · `error` (`catchError` + banner + reintento aislado — regla del repo "nunca fallar callado") · `overflow` (texto 10× — `truncate`+`title` o `line-clamp` justificado; números de 8 dígitos que no rompan columna).
- **Empty ≠ error de red:** son pantallas distintas. Nunca mostrar "no hay datos" cuando fue un fetch fallido (bug vivo documentado en PWA §5).

### 3. a11y técnica — AA piso duro, APCA como guía perceptual
- **Contraste:** WCAG **AA** es el requisito formal/legal (piso innegociable); **APCA** es el mejor predictor perceptual y manda cuando difieren, sobre todo en texto ≤14px de celdas densas (buscar Lc≥75 para body chico). Justificar el par de color con ambas métricas cuando no coincidan. Tokens en OKLCH (`FOUNDATIONS`).
- **Semántica + ARIA:** roles correctos; `aria-label` en todo icon-button; `aria-current` en selección master; labels `for/id` en inputs. El color **nunca** es único portador de significado (+ icono/texto — ya binding).
- **Foco:** navegación por teclado fluida; al abrir `p-dialog`/side-peek → mover foco dentro + **retornarlo al trigger** al cerrar; foco no obstruido por headers sticky. PrimeNG trae base ARIA pero **no es gratis** — se verifica, no se asume.

### 4. Presupuesto de motion + ciclo de vida (60fps o no se anima)
> Extiende el techo de motion ya binding (§11 datos densos, §Motion KPI). **GSAP no es dependencia del monorepo hoy** — estas reglas rigen CSS/Web Animations API por default y GSAP *si/cuando* se introduzca (evaluar bundle + lazy).
- **Solo propiedades de compositor:** `transform` + `opacity`. Prohibido animar `width/height/top/left/margin/padding/box-shadow` (layout thrashing/reflow). Si un efecto "lo necesita", se rediseña con `scale`/`clip-path`/crossfade de capas.
- **`will-change` quirúrgico y temporal**, nunca permanente (cada capa promovida come VRAM).
- **Zone.js:** toda animación con callbacks de alta frecuencia (`onUpdate`, ScrollTrigger, rAF) corre en `NgZone.runOutsideAngular()`; solo re-entrar (`zone.run()`) si un callback debe mutar estado de app. El jank suele venir de change detection por tick, no del compositor.
- **Limpieza (memory leaks):** escopar al host y limpiar en `DestroyRef`. Con GSAP: `gsap.context(...)` + `destroyRef.onDestroy(() => ctx.revert())` — `revert()` sobre `kill()` porque además **restaura estilos inline** (crítico si el componente se re-instancia por navegación). ScrollTriggers viven dentro del context y mueren con él.
- **`prefers-reduced-motion`** gatea todo (`gsap.matchMedia()` o media query CSS) — ya patrón en el repo (`motion-safe`).

### 5. Container queries sobre media queries en componentes reutilizables (Nx)
- Un componente que vive en `libs/` y se embebe en distintos anchos (tabla de inventario en Operations *y* en `/portal`) **no** decide su layout interno por viewport (`md:`/`lg:`/`@media`) sino por el espacio que le da el padre: `@container` de Tailwind sobre un wrapper con `container-type: inline-size`.
- **Trampa:** `container-type` establece contención de tamaño y **rompe elementos que se desbordan a propósito** (overlays PrimeNG, `p-overlay`, tooltips). Regla: container query en el *wrapper de layout*, no en el nodo que ancla overlays.
- Componente reutilizable cross-app = vive en `libs/`, no en `apps/view`.

### 6. Error boundaries por sección + degradación elegante
- Angular **no** tiene error boundaries nativos — se construyen. Dos capas: `ErrorHandler` global para lo no capturado + por sección el patrón `catchError` con estado local y reintento aislado (reintenta *esa* query, no recarga la vista).
- Si una sección revienta (datos o render), el error se **contiene en ese nodo**; header, nav y demás secciones siguen operativas. Nada de pantalla en blanco.

### 7. Rigor de dominio (divisas, cantidades, fechas, TZ)
- La UI **nunca** renderiza número/fecha crudos. Divisa vía `Intl.NumberFormat('es-MX', {currency:'MXN'})` o `CurrencyPipe`; fechas con locale MX explícito.
- **`tabular-nums` innegociable** en toda columna numérica/dinero/qty/fecha (ya binding) — sin él los montos "bailan" y la tabla densa se ve rota. Números a la derecha, texto a la izquierda (jerarquía de lectura, no estética).
- **TZ:** backend ya normaliza en `America/Mexico_City` (`apps/api/src/shared/date/mx-date.ts`). Frontend: **no** re-convertir con `new Date()` ingenuo del navegador (descuadra el pedido de las 11:50 PM). Renderizar la fecha ya normalizada sin doble conversión.
- **i18n gotcha:** los pipes con locale `es-MX` requieren `registerLocaleData(localeEsMx)` en bootstrap, o `CurrencyPipe`/`DatePipe` caen a `en-US` en silencio. Verificar una vez a nivel app.
- **Microcopy = capa de diseño.** Empty/error/confirmaciones en español operativo de Mega Dulces con acción de recuperación ("No hay pedidos hoy" + CTA), nunca "No data found" placeholder.

### 8. Sanitización del render (XSS) — cero confianza en datos inyectados
- La data la teclean vendedores y captura de campo (nombres de producto, notas de visita): el vector es real en el backoffice.
- Default: interpolación `{{ }}` (Angular ya escapa). `[innerHTML]` **solo** con directiva de negocio explícita y pasando por `DomSanitizer.sanitize(SecurityContext.HTML, …)`.
- ⛔ **Nunca** `bypassSecurityTrustHtml` sobre input de usuario (ése es exactamente el agujero). Rich text real → allowlist de tags, no saneo ad-hoc.

### 9. Estado en la URL + optimistic UI
- **URL como fuente de verdad** en Operations con filtros/master-detail: filtro activo, fila seleccionada, tab y rango de fechas viven en query params, no solo en signals. Si no, F5 pierde contexto y no se puede compartir "este pedido filtrado".
- **Optimistic UI** en toda mutación de 1 registro (confirmar pedido, aprobar requisición, editar inline): pintar resultado optimista → reconciliar con server → rollback **visible** en error, sin spinner (ya binding §3 datos densos). Es decisión de UX por acción.

### 10. Verificación (definition of done)
- **Se prueba vivo, no se promete.** Con Chrome DevTools/Playwright MCP: screenshot en light/dark/móvil, trace de performance real. Endpoint nuevo → probar vivo o avisar que falta restart (regla del repo).
- Build de prod `nx build <p> --skip-nx-cache` de **todo** lo tocado (dev/caché tapa errores).
- QA visual contra **datos reales extremos** (nombres 80c, RFC raro, tablas 4k filas → virtual scroll, montos 8 dígitos), no lorem ipsum.

### 11. Gobernanza
Cuando un requerimiento choque con `DESIGN.md`, **no se resuelve en silencio**: se expone el conflicto y decide el usuario. "No desviarse del DS sin aprobación."

---

## PWA / App instalable (BINDING)

> Alcance: toda app que se **instala** en el dispositivo. Hoy `apps/vendor` (mobile-first, vendedor en campo); candidatos: `/portal` y `apps/view`. Origen: auditoría del vendor 2026-06-18 (manifest copiado de `apps/view`, sin service worker, `theme-color` hardcodeado). Bases teóricas + fuentes en [`docs/DESIGN_FOUNDATIONS.md` §10](docs/DESIGN_FOUNDATIONS.md).

### Tesis
Una app instalada **promete capacidades nativas**: arranca offline, se ve como app (no como pestaña), respeta el notch, y no muere sin señal. Si instalás algo que falla igual que la web, rompiste el contrato. El vendedor en ruta es el caso límite: **señal intermitente es el estado normal, no el error.**

### 1. Service worker — OBLIGATORIO en app instalable
- Registrar con `provideServiceWorker` (Angular) + `ngsw-config.json` por app. Sin SW, "instalable" es una mentira: cero offline, cero caché, cero update flow.
- **App shell + chunks lazy**: `prefetch`/`lazy` en `assetGroups` → la cáscara abre sin red.
- **Datos (GET)**: `dataGroups` con `freshness` (red primero, cae a caché) para listas de ruta/cartera; `performance` (caché primero) solo para catálogo/recursos casi-estáticos. Definir `maxAge`/`maxSize` explícitos.
- **Update flow visible**: al detectar `VersionReady`, ofrecer "Hay una nueva versión — actualizar" (no recargar a la fuerza en medio de un pedido).

### 2. Manifest — por app, nunca copiado
- **Prohibido reusar el manifest de otra app.** Cada `manifest.webmanifest` describe SU app.
- `name` / `short_name`: nombre real user-facing (no `vendor-MD`).
- `start_url`: la **ruta real de arranque** del rol (vendedor → `/vendor/route-home`), no `/`.
- `shortcuts`: **solo rutas que existen en esa app**. Un shortcut a una ruta inexistente cae al `**` redirect = bug silencioso.
- `theme_color` / `background_color`: derivados del tema (superficie de chrome = `--card-bg`), **no `#FFFFFF` fijo** si la app tiene dark mode.
- `icons`: incluir `192` y `512` + variantes `purpose: "maskable"` (Android adaptive). `display: "standalone"`.

### 3. Chrome del SO (status bar / splash / theme-color)
- `theme-color` en `index.html` debe **derivar de `--card-bg`** (regla cross-proyecto, ver `feedback_pwa_mobile_chrome`), no un hex suelto.
- Si el tema togglea en runtime (modo oscuro del shell), **actualizar el `<meta name="theme-color">` por JS** al cambiar — el meta estático no sigue al toggle.
- iOS: `apple-mobile-web-app-status-bar-style: black-translucent` + `apple-mobile-web-app-title` real.

### 4. Safe-area (notch / home indicator) — BINDING
- Header sticky, bottom-nav, FAB y bottom-sheets usan `env(safe-area-inset-*)` (ya correcto en `vendor-shell` y `route-home` — **conservar**).
- `viewport` con `viewport-fit=cover` siempre que se use `env(safe-area-inset-*)`.

### 5. Offline UX — contrato de UI (aunque la cola sea deferred)
- **Distinguir "vacío real" de "fallo de red".** Empty-state ("no tenés cartera") y error-state ("no se pudo cargar — reintentar") son pantallas DISTINTAS. Nunca mostrar el empty cuando fue un error de fetch. *(Bug vivo en `route-home`: `forkJoin` que falla cae al empty de "sin cartera".)*
- Todo error de carga ofrece **Reintentar** explícito.
- Escrituras críticas (tomar pedido, marcar visita) → destino futuro es **cola offline (Dexie)** con reintento; mientras siga deferred, el estado de red debe ser **visible** (banner "sin conexión", no fallar en silencio).
- Indicador de conexión cuando la app está instalada (no hay barra del browser que lo delate).

### 6. A11y de superpuestos en app instalada (sin chrome del browser)
- Bottom-sheets / modales: **focus trap + cierre con Escape + `scroll-lock` del body + restaurar foco al abridor + `aria-labelledby`**. En instalada no existe "back del browser" como escape — el patrón debe bastarse solo. *(Gap vivo en el bottom-sheet de `route-home`.)*
- Touch targets ≥44px en flujos críticos (ya se cumple en FAB/sheet-primary).

### 7. Viewport / zoom
- `user-scalable=no` + `maximum-scale=1` **rompe WCAG 1.4.4** (zoom). Se tolera como excepción documentada solo por la desalineación de inputs en iOS (`feedback_pwa_mobile_chrome`). Preferir arreglar el layout y **permitir zoom**; si se mantiene el bloqueo, justificarlo en el PR.

### Antipatrones PWA (flag en review)
- App "instalable" (con manifest) **sin service worker**.
- Manifest copiado de otra app (shortcuts/start_url/colores de otra superficie).
- `theme_color` / `theme-color` blanco fijo bajo una app con dark mode.
- Empty-state mostrado en un fallo de red (sin Reintentar).
- Modal/sheet sin focus-trap ni Escape en app instalada.
- Escritura crítica que falla en silencio sin señal de "sin conexión".

---

## Decisions Log
| Fecha | Decisión | Razón |
|------|----------|-------|
| 2026-07-10 | **Contrato de ingeniería de UI BINDING** (fundamento cognitivo, matriz de estados, a11y AA+APCA, presupuesto de motion + ciclo de vida/Zone.js/`ctx.revert`, container queries en `libs/`, error boundaries por sección, formateo `Intl`+TZ+`tabular-nums`, XSS/`DomSanitizer`, estado-en-URL, optimistic UI, i18n locale) | Codifica el *cómo se construye* que faltaba: el DS visual no garantiza que la UI no se rompa con datos reales/errores ni que el motion no janquee/fugue memoria. GSAP aún no es dependencia — reglas rigen CSS/WAAPI hoy y GSAP si/cuando entre. |
| 2026-06-24 | **Display Storefront: Fraunces serif → Poppins** (sans geométrica). *Supersede la decisión 2026-06-04 de conservar Fraunces.* | El usuario quiere la identidad tipográfica tipo Rappi (delivery app), no editorial-serif. Poppins es el análogo libre más cercano a "Rappi Sans". Body sigue Hanken Grotesk. Operations no cambia. |
| 2026-06-24 | Firma de botones «Confite» (pill + gloss + lip + press) + portal monocromático con acento de marca | Darle al portal una identidad táctil propia (la "esencia" tipo Rappi) sin perder el quiet-luxury. Una sola acción en color; thumbnails/chrome neutros. Implementado en `.portal-btn-*` + util de placeholders. |
| 2026-06-24 | Patrones P0/P1 aplicados al portal (reorden-primero, promo nativa, CTA sticky, cross-sell, upsell de mínimo, tab bar 4+búsqueda) | Traducción de la investigación UX (Baymard/NN-g/Polaris/M3/Instacart) a código. Ver `docs/IMPLEMENTACION/INVESTIGACION_UX_PORTAL_VENTA.md`. |
| 2026-06-18 | Estándares PWA BINDING (SW obligatorio, manifest por-app, theme-color derivado, offline-UX contract) | Auditoría del vendor reveló app "instalable" sin service worker + manifest copiado de `apps/view` con shortcuts a rutas inexistentes. El vendedor en campo necesita offline real, no una web envuelta. |
| 2026-06-08 | Extender "Mercado" como sistema único con 2 surfaces (Storefront + Operations) | Coherencia cross-app: cliente B2B y operador interno ven la MISMA empresa visual. Costo: tokens-only. Win: identidad de marca y reuso del trabajo del portal. |
| 2026-06-08 | Operations = tool-mode-only (sin Fraunces ni decoración) | El usuario interno no tiene "storefront moments". Type bold + density + mono cifras = tesis "esto es serio". |
| 2026-06-08 | Operations hereda Stone, sunset action, ember IA, espresso dark de Storefront | Reuso completo de paleta. Evita 2 fuentes de verdad. Migración es swap de tokens en `:root`. |
| 2026-06-04 | Dirección "Mercado" (Warm Editorial Utilitarian) para `/portal` | Hueco de mercado: velocidad utilitaria + textura premium + IA no-genérica, para un comprador prosumer |
| 2026-06-04 | Inter → Hanken Grotesk (body), JetBrains Mono → Geist Mono (data) | Evitar el default de convergencia; calidez + tabular-nums para precios |
| 2026-06-04 | Fraunces se conserva como display, disciplinado a storefront mode | Serif óptico cálido ya presente y de calidad |
| 2026-06-04 | Naranja-sunset `#F05A28` = acción; amarillo `#FDE707` = sello | El amarillo no soporta texto blanco (AA); formalizar lo que el código ya hacía de facto |
| 2026-06-04 | Neutrales Zinc → Stone cálido; dark `#000` → espresso `#16130F` | Matar el "feel SaaS frío" bajo una marca cálida |
| 2026-06-04 | IA: matar `#8b5cf6` morado → identidad ember (ámbar→sunset) | Diferenciar la IA sin caer en el AI-slop de la industria |
| 2026-06-04 | Catálogo: vista conmutable grid ⇄ lista | Servir tanto al que explora como al que reordena rápido (lección McMaster) |
| 2026-06-04 | Adoptar principios formales (Atomic Design + leyes UX + guías nativas) | Cómo diseñan Rappi/Uber/Airbnb: sistema de componentes + psicología, no pantallas sueltas |

---

## Principios de diseño (cómo diseñan Rappi / Uber / Airbnb)

> Marco de referencia para TODA decisión de UI en el portal. No diseñar pantallas sueltas — construir un sistema.

### 1. Sistema de Diseño + Atomic Design
Las grandes apps no diseñan una pantalla desde cero: componen un **Design System** con la metodología **Atomic Design**:
- **Átomos**: botón, tipografía, color, input, badge, ícono. (≈ nuestros `tokens.css`.)
- **Moléculas**: combinaciones simples (search bar = input + botón; stepper = −/valor/+).
- **Organismos**: bloques completos (nav bar, product card, cart drawer).
- **Coherencia absoluta**: si el botón primario es radio 10px + sombra X, **ese mismo componente** se reutiliza en toda la app. Nunca re-estilar a mano por pantalla.
- Referencia pública: **Base Web** de Uber (https://baseweb.design) — cómo estructuran componentes.

**Regla para este repo:** un cambio visual recurrente = un componente/clase compartida, NO copy-paste de estilos por componente. (Ver auditoría abajo: hoy violamos esto.)

### 2. Guías nativas (estándar de los SO)
Antes de inventar interacciones, respetar:
- **Material Design 3** (Android/web): sombras, animaciones, transiciones, estados (`hover`/`active`/`disabled`/`focus`).
- **Human Interface Guidelines** (iOS): navegación, gestos, jerarquía. Relevante porque corremos en Capacitor.
- Implicación: todo control interactivo necesita los 4 estados visibles + `focus-visible` accesible.

### 3. Psicología y leyes de UX
- **Ley de Hick**: el tiempo de decisión crece con la cantidad/complejidad de opciones. → mostrar **categorías y curaduría** antes que listas de 10.000. (Rappi muestra categorías, no todos los restaurantes.)
- **Ley de Fitts**: el tiempo para alcanzar un target depende de distancia y **tamaño**. → CTA primario **grande y abajo** (zona del pulgar). Targets táctiles ≥ 44×44px.
- **Jerarquía visual**: tamaño + peso de fuente (bold vs regular) + contraste de color guían el ojo al clic deseado.

### 4. Dónde educar el ojo (tendencias reales, no slop)
- **Mobbin** (mobbin.com): biblioteca de capturas de apps reales (Uber, Rappi, Spotify) mapeando flujos completos (login, checkout). **Lookbook obligatorio antes de diseñar un flujo nuevo.**
- **PageFlows**: igual que Mobbin pero en video de los flujos.
- **Dribbble / Behance**: solo inspiración visual pura (color, sombra, ilustración). ⚠️ Mucho es conceptual / inusable — no copiar UX de ahí.

---

## Auditoría del portal vs. estos principios (2026-06-04)

> 🗄️ **HISTÓRICO.** Auditoría de origen; la capa de botón «Confite» y varios targets 44px ya se aplicaron (ver estado del sprint Atomic abajo). Referencia, no checklist operativo.

🔴 alto · 🟡 medio · 🟢 pulido

1. 🔴 **Falta capa Atómica (el gap #1).** Tenemos átomos (tokens) pero NO moléculas/organismos compartidos. Hay **~4 variantes de card** (`cat-card`, `cat-bestseller-card`, `pp-offer`, `po-card`) y **~5 definiciones de botón primario** (`portal-btn-primary`, `ph-btn-primary`, `cat-ai-btn`, `cat-sheet-btn-primary`, `pl-submit`), cada una re-estilada a mano. Eso es exactamente lo que Atomic Design evita. **Fix:** extraer componentes Angular standalone reutilizables: `PortalButton` (variants: primary/ghost/ai-ember), `ProductCard`, `Pill/Badge`, `Stepper`, `EmptyState`, `SearchBar`. Una fuente → coherencia + pantallas más rápidas de construir.
2. 🟡 **Targets táctiles < 44px (Fitts).** `cat-add` 38px, `cat-stepper-btn` 32-36px, varios icon-btn. **Fix:** mínimo 44×44px en mobile para todo lo clickeable.
3. 🟡 **Acción primaria ambigua (Fitts + jerarquía).** Conviven CTA negro (`ph-btn-primary`), naranja-acción (`portal-btn-primary` futuro) y ember-IA sin una regla única. **Fix:** UNA jerarquía: primaria=sunset, secundaria=ghost, IA=ember, marca/hero=negro+amarillo. Documentarla en el átomo `PortalButton`.
4. 🟡 **Hick en el catálogo.** El catálogo abre a "todos los productos" (grid largo). Ya hay buenas reducciones (panel de filtros vs 438 chips, bestsellers, reorder, sugeridos) pero el default sigue siendo la lista completa. **Fix:** abrir con curaduría (categorías + reorder + sugeridos) y empujar el grid completo abajo / detrás de una categoría.
5. 🟢 **Estados nativos inconsistentes.** `disabled/hover/focus` varían entre los botones bespoke. Se resuelve solo al centralizar en `PortalButton`.
6. 🟢 **Workflow de referencia.** Adoptar Mobbin + Base Web como lookbook antes de diseñar flujos nuevos (checkout, alta de pedido, etc.).

**Lo que YA cumple bien (conservar):** tokens como átomos · ley de Hick en bento top-3 de promos · ley de Fitts en el cart FAB (grande, abajo, zona pulgar) · jerarquía con Fraunces + pesos + `tabular-nums` · `prefers-reduced-motion` + safe-area + haptics (alineado a Material/HIG).

**Próximo paso recomendado:** sprint "Atomic layer" — extraer los 6 componentes del punto 1; al hacerlo se resuelven de paso los puntos 2, 3 y 5.

### Estado del sprint Atomic layer (2026-06-04)

✅ **Aplicado — capa de botón compartida.** En `styles.css` se estableció el átomo canónico de botón con jerarquía única (ver "ÁTOMO: Botón del portal"):
- `.portal-btn-primary` → **sunset** (acción principal) · `.portal-btn-ghost` → secundaria · `.portal-btn-ember` → IA (gradiente ámbar→sunset) · `.portal-btn-hero` → CTA de marca storefront (negro+amarillo). Modificadores `--lg` / `--block` / `--pill`.
- Todos ≥ **44px** (Fitts), con `hover/active/disabled/focus-visible` unificados.
- Adoptado en: catálogo (botón IA → `portal-btn-ember`), home (hero → `portal-btn-hero`, ghost → `portal-btn-ghost`), y propagado automáticamente a todos los `.portal-btn-primary` existentes (orders, promociones, order-detail, empty states) que ahora son sunset.
- **Resuelve:** #3 (acción única = sunset), #5 (estados nativos), y la mitad de #2 (botones a 44px).

✅ **Aplicado — touch targets de steppers/add (Fitts, #2).** `cat-add`, `cat-stepper`/`cat-stepper-btn` y `pp-offer-stepper`/`pp-offer-step` subidos a **44px**.

⬜ **Pendiente (próximas fases):**
- #1 (resto): extraer **`ProductCard`** (unifica `cat-card`/`cat-bestseller-card`/`pp-offer`/`po-card`) + **`SearchBar`** + **`Pill/Badge`** + **`Stepper`** + **`EmptyState`** como componentes Angular. El budget CSS del catálogo (31.9 kB) confirma que extraer `ProductCard` aliviana mucho.
- #4 (Hick): abrir el catálogo con curaduría (categorías + reorder + sugeridos) antes del grid completo.

### Revisión paso-a-paso del portal (2026-06-04) — outcomes

Auditoría módulo por módulo (tipografía al detalle + densidad + bordes + a11y + código). Aplicado:
- **Login**: títulos → Fraunces; submit → átomo sunset (se eliminó un p-button con 8 `!important`); focus → `--action-ring`; campo "Empresa" colapsado; radios a escala; show-pass 44px.
- **Shell**: 🔴 bug dark-mode del tab bar flotante (estaba `rgba(255,255,255,.85)` hardcodeado) → tokens; nav móvil **6→5 tabs + FAB IA eliminado** (duplicaba el tab); tamaños/borders a escala.
- **Home**: tracking display -0.035/-0.025 → -0.02 + `font-optical-sizing`; eyebrows → 0.08em; **fast-path subido** (Atajos arriba de Promos).
- **Catálogo**: tracking/eyebrow; drawer del carrito con **nombres de producto**; flag: extraer ProductCard + declutter de cabecera (hero-mini).
- **Carrito**: `--font-mono` (era JetBrains hardcoded); qty 44px; 🔴 **muestra nombre+marca real** (no UUID — el dato ya venía del backend `findById`, el front lo ignoraba).
- **Promociones**: bento hero → Fraunces.
- **Recomendaciones (IA)**: 🟡 **identidad ember aplicada** (iconos/avatares ámbar→sunset); acciones a sunset/ember; focus token; steppers a 40px.
- **Detalle de pedido**: nombres de producto + `--font-mono`.
- **Pedidos / Guard / Service / Notif-prefs**: revisados, sin deuda relevante.

Hallazgo transversal resuelto: **líneas de pedido mostraban UUID en vez del nombre** (carrito, detalle, drawer). Fix 100% frontend — el backend `commercial-orders.findById` ya hacía el join `p.nombre as product_name`.

Pendientes de esta revisión (no bloqueantes): radios de tarjeta a escala (tokenizar 16/20/24), `.portal-section-head h2` global → Fraunces en páginas storefront, declutter de cabecera del catálogo, y la extracción de `ProductCard`.
