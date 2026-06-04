# Design System — Portal B2B Mega Dulces ("Mercado")

> Fuente de verdad para el módulo **`/portal`** (Portal Web B2B en `apps/view/src/app/modules/portal`).
> Dirección **"Mercado" — Warm Editorial Utilitarian**, creada por `/design-consultation` (2026-06-04).
> Los tokens viven en [`apps/view/src/styles/tokens.css`](apps/view/src/styles/tokens.css). Este archivo manda sobre cualquier valor hardcodeado.

---

## Tesis de diseño

Una herramienta de pedido mayorista que se siente como una **marca CPG mexicana premium**, no como un dashboard SaaS genérico. Resuelve el hueco que casi nadie ocupa: los gigantes B2B que la gente ama (McMaster-Carr, Uline) son utilitarios y rapidísimos pero feos; la nueva ola (Faire) es editorial y cálida pero lenta. **Mercado hace las dos cosas**, porque el comprador no es un agente de compras — es un dueño de dulcería (prosumer) que quiere sentir que por fin tiene una herramienta seria.

**Lo memorable, ordenado por jerarquía** (no los tres con el mismo peso — eso sería memorable por nada):
1. **Velocidad = la columna.** Pantallas transaccionales densas, instantáneas, teclado-first (la lección McMaster).
2. **Premium = la textura.** Tipografía y calidez hacen ver pro a un changarro. Momentos editoriales solo en home/promos (la lección Faire).
3. **IA = el acento.** El diferenciador real, con identidad visual propia (**ember ámbar**) — nunca el morado genérico de la industria.

### Regla de dos modos (define todo)
- **Tool mode** (catálogo, carrito, pedidos): denso, escaneable, compacto. Body bold, cifras tabulares, naranja-acción.
- **Storefront mode** (home, promos, login): editorial, con aire, Fraunces display, ilustración.

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

Cargadas desde Google Fonts en [`apps/view/src/index.html`](apps/view/src/index.html).

- **Display/Hero:** **Fraunces** (serif óptico cálido) — opsz auto. Solo en **storefront mode**: hero h1, section heads editoriales, empty states, títulos de promo. **Nunca** en tablas/UI densa.
- **Body/UI:** **Hanken Grotesk** (reemplaza a Inter) — grotesca redonda, cálida, amigable, muy legible. Pesos 400/500/600/700/800.
- **Data/Tablas/Code:** **Geist Mono** (reemplaza a JetBrains Mono) — SKUs, códigos de pedido, precios en columna, atajo `⌘K`. **Obligatorio `font-variant-numeric: tabular-nums`** en todo lo que sea dinero o cantidad.
- **Por qué este cambio:** Inter es el default de "me rendí con la tipografía" (toda app converge ahí). Hanken Grotesk da calidez sin perder neutralidad de herramienta; pares con Fraunces sin pelear.
- **Escala display** (clamp responsive, ya en tokens):
  - `--text-display-xl: clamp(2.5rem, 7vw, 3.5rem)` — hero h1
  - `--text-display-lg: clamp(1.875rem, 4.5vw, 2.5rem)` — section feature
  - `--text-display-md: clamp(1.375rem, 3vw, 1.625rem)` — card title
- **Escala UI:** 0.7 / 0.75 / 0.8125 / 0.875 / 0.9375 / 1 / 1.125rem. Tool mode tira hacia abajo; storefront hacia arriba.

```html
<!-- index.html -->
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700;9..144,800;9..144,900&family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```
```css
--font-display: 'Fraunces', Georgia, 'Times New Roman', serif;
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
- **Border radius:** sm 8px · md 12px · lg 16px · xl 22px · pill 999px.

## Motion
- **Enfoque:** intencional, rápido. No decorativo.
- **Easing:** `--ease-standard: cubic-bezier(0.2, 0, 0, 1)`.
- **Duración:** micro 50-120ms · short 150-250ms · medium 250-400ms.
- **Mobile:** usar `HapticService` en acciones (add to cart, confirmar).
- **Siempre** respetar `@media (prefers-reduced-motion: reduce)` (ya hecho en el portal).

---

## Hallazgos del portal actual (auditoría 2026-06-04)

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

## Decisions Log
| Fecha | Decisión | Razón |
|------|----------|-------|
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
