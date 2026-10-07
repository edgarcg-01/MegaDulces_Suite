# Fase J15 — Sistema de movimiento: GSAP + anime.js + Design Spells

> **Qué:** catálogo accionable de animaciones/micro-interacciones útiles para nuestro panel (Operations), con la decisión de **qué técnica usar para cada una** (CSS/rAF propio · anime.js · GSAP) y un plan de adopción.
> **Fuentes:** [gsap.com](https://gsap.com) (GSAP, **gratis** desde 2025 vía Webflow — incluye plugins) · [animejs.com](https://animejs.com) (anime.js v4, modular ~24.5 KB, tree-shakeable) · [designspells.com](https://designspells.com/?tag=desktop) (micro-interacciones de apps top).
> **Tesis:** Operations = herramienta seria 8h. El movimiento es **funcional** (feedback, continuidad, foco), nunca decoración. Techos de Linear, `transform`/`opacity` only, honrar `prefers-reduced-motion`.

---

## TL;DR — la decisión

1. **Default = lo que ya tenemos (CSS + rAF, 0 KB).** Sparkline draw-in, count-up, bar stagger, progress, hover lift, focus rings ya están hechos en J14 sin dependencias y tokenizados/dark-aware. **No los reescribimos en una lib.**
2. **anime.js (modular, lazy-loaded)** = nuestra **librería de orquestación** cuando CSS se vuelve doloroso: secuencias sincronizadas multi-elemento, timelines, number-tickers reactivos, stagger complejo. Importar solo los módulos necesarios (`Timer`/`Animation` ≈ 11 KB). Carga diferida (`await import('animejs')`) → 0 KB en el bundle inicial.
3. **GSAP solo para `Flip`** = lo único que CSS **no** puede: transiciones de layout (card→detalle, reflow de tabla al filtrar, abrir side-peek conservando continuidad). Lazy-load. Gratis ahora.
4. **NO adoptar** (no encajan en tool denso): ScrollSmoother, MorphSVG, físicas de arrastre, scroll-narrative pesado, SplitText decorativo. ScrollTrigger solo si algún día hay reveal-on-scroll de paneles below-fold (opcional).

**Por qué no "todo GSAP":** GSAP es excelente pero para un panel denso el 90% del movimiento es micro-feedback que CSS/rAF ya cubre sin костo. Pagamos peso de lib solo por lo que CSS no hace (Flip) o lo que sería frágil a mano (timelines sincronizados).

---

## Matriz: técnica por caso

| Caso | Mejor técnica | Por qué |
|---|---|---|
| Count-up de número | **rAF propio (ya hecho)** o `anime` (Timer) | trivial, sin lib; anime si querés easing/format avanzado |
| Draw-in de sparkline | **CSS `stroke-dashoffset` (ya hecho)** | 1 keyframe, 0 KB |
| Stagger de barras | **CSS (ya hecho)** | `animation-delay` por índice |
| Entrada sincronizada de N cards (cascada con overlap) | **anime.js timeline** | orquestar offsets relativos es frágil en CSS |
| Number ticker tipo odómetro (dígitos ruedan) | **anime.js** | interpolación + formato, limpio |
| **Layout transition** card→detalle / reflow tabla / side-peek | **GSAP Flip** | CSS no puede animar entre dos layouts distintos |
| Hover lift / glow / focus ring | **CSS (ya hecho / trivial)** | estado puro |
| Spotlight que sigue el cursor | **CSS vars + JS pointermove** (sin lib) | `--mx/--my` + radial-gradient |
| Sparkline/barras interactivas (tooltip al hover) | **Angular + SVG nativo** (sin lib) | hit-areas + signal de punto activo |
| Reveal-on-scroll de paneles | **CSS `animation-timeline: view()`** o GSAP ScrollTrigger | preferir CSS nativo si el browser target lo soporta |

---

## Catálogo de animaciones útiles (priorizado)

### 🟢 Ya hecho (J14) — mantener
- **Count-up** del valor (easeOutCubic ~700ms, rAF) · **sparkline draw-in** · **bar stagger** · **ring gauge** arco · **progress fill** · **hover lift** en cards interactivas. Todo con `prefers-reduced-motion`.

### 🔴 Alto valor / próximas
1. **Sparkline & barras interactivas** *(Design Spell: Miles bar chart, YouTube count)* — hover sobre la mini-gráfica → punto/tooltip con `día + valor`. Convierte adorno en dato consultable. **Técnica:** SVG + Angular signal (`activeIndex`), sin lib. Tooltip = `p-tooltip` o div posicionado.
2. **Number ticker on-change** *(Design Spell: Dub.co)* — al cambiar rango/Actualizar, el número **re-anima** desde el valor previo (no desde 0) + flash sutil del delta. **Técnica:** ya tenemos rAF; extender el `effect` para animar `from→to` en cambios (ya lo hace) + micro-flash CSS.
3. **Micro-hover en iconos** *(Stripe/Supabase/Discord)* — botón Actualizar **gira** al hover; iconos de nav con micro-reacción. **Técnica:** CSS `transition: transform`. Casi gratis.

### 🟡 Premium / opcional
4. **Spotlight que sigue el cursor en cards** *(Luma)* — glow radial tenue que sigue el puntero al hover del card. **Técnica:** `@HostListener('pointermove')` → set `--mx/--my` → `radial-gradient` en `::after` a baja opacidad. Sin lib. Sutil (Operations).
5. **Entrada en cascada de la fila de KPIs** — al cargar el dashboard, las cards entran con stagger + leve `translateY/opacity`. **Técnica:** CSS stagger (simple) o **anime.js timeline** (si querés overlap fino). Solo en carga, nunca en cada CD.
6. **Layout morph card → detalle / side-peek** *(GSAP Flip)* — al expandir una card o abrir el side-peek desde una fila, los elementos "vuelan" a su nueva posición. **Técnica:** **GSAP Flip** (lazy). El caso que justifica GSAP.
7. **Hover progressive disclosure** *(sneak-peek upgrade)* — la card revela una métrica secundaria (promedio diario, mejor/peor día) al hover. **Técnica:** CSS height/opacity o anime para suavidad.

### ⛔ No traer (rompe la tesis Operations)
Confeti, easter eggs estacionales, ilustraciones isométricas, cursores skeuomórficos, flip 3D de tarjetas, rubber-banding de arrastre, ScrollSmoother. Deliciosos para consumo, ruido en finanzas/logística.

---

## Reglas de oro (todas las animaciones)
- **Techos (Linear):** 100ms quick · 150ms exit · 250ms standard · **350ms máx**. KPIs count-up puede llegar a ~700ms (excepción consciente, una sola vez por carga).
- **Solo `transform` + `opacity`** (+ `stroke-dashoffset` para SVG). **Nunca** `width/height/margin/top` en listas/tablas densas (reflow).
- **`prefers-reduced-motion`** siempre: sin draw-in, sin count-up, sin spotlight → estado final directo. (Ya respetado en J14.)
- **No animar al re-render** de data en tablas; animar **estados y overlays** (entrada, hover, transición, refresh puntual).
- **Lazy-load de libs:** `const { animate } = await import('animejs')` / GSAP Flip dinámico → 0 KB en el bundle inicial; solo paga quien usa la pantalla.
- **Tokens:** colores/duraciones desde `--action`/`--chart-*`/`--ease-*`. Nada de hex/durations mágicas.

---

## Plan de adopción (incremental, sin romper lo hecho)

- **F0 · Sin lib (CSS/JS propio)** — implementar #1 (sparkline interactiva), #3 (micro-hover iconos), #4 (spotlight cursor), #2 (ticker on-change). Cubre el 80% del "wow" sin dependencias. *(Recomendado primero.)*
- **F1 · anime.js (lazy, modular)** — agregar solo si queremos #5 (cascada orquestada) o tickers tipo odómetro. `npm i animejs`; importar dinámico `Timer`/`Animation`. Wrapper `motion.service.ts` que respeta reduced-motion globalmente.
- **F2 · GSAP Flip (lazy)** — solo cuando ataquemos #6 (card→detalle / side-peek con continuidad de layout). `npm i gsap`; `await import('gsap/Flip')` puntual.
- **F3 · QA** — perf (sin jank, INP < 200ms), reduced-motion, dark mode, techos de duración.

## Criterios de "done"
0 hex/durations mágicas (tokens) · `prefers-reduced-motion` · transform/opacity only · lazy-load de libs · build verde · sin jank en panel denso.

## Riesgos
- **Peso de lib:** mitigado con lazy-load + import modular. Si solo necesitamos Flip, no metemos todo GSAP en el bundle inicial.
- **Sobre-animar:** el panel es herramienta; cada animación debe justificar su existencia (feedback/continuidad/foco). Ante la duda, no animar.
- **Doble fuente de verdad de motion:** mantener `--ease-*` y los techos como norma única; las libs usan esos valores, no inventan los suyos.

## Estado

### F0 — sin dependencias ✅ código 2026-06-22
- **Sparkline interactiva** (`SparklineComponent`): hover → guía + punto + tooltip con valor (`format` moneda/número + `labels` opcional). 
- **Barras interactivas** (`MiniBarsComponent`): hover resalta barra + atenúa el resto + tooltip.
- **Spotlight cursor** en `MetricCardComponent`: glow radial (13% del accent) que sigue `--mx/--my` (sin CD); off en ember.
- **Micro-hover icono**: botón Actualizar gira 180° (Stripe/Supabase spell).
- Todo con `prefers-reduced-motion`, `transform`/`opacity`, tokens. Aplica a todas las cards (organismo). Build verde.

### Pendiente
- F1 anime.js (cascada/odómetro) y F2 GSAP Flip (card→detalle / side-peek) — **solo si un caso lo pide**. Hoy no hay necesidad.
- QA visual de las interacciones con API arriba.
