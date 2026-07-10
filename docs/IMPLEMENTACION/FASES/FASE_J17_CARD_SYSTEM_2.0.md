# Fase J17 — Card System 2.0 (dinamismo + variedad)

> **Qué:** evolución del repertorio de cards ([J16](FASE_J16_CARD_REPERTOIRE.md)) y del organismo `MetricCard` ([J14](FASE_J14_CARDS_DATAVIZ.md)) hacia cards **vivas** (dato en tiempo real), con más **variedad de micro-viz** y **profundidad de interacción** (glance → drill).
> **Estado:** 🔨 DISEÑADO (investigación 2026-07-10, sin código). Base teórica + benchmark abajo.
> **Norma:** DS Mercado (surface Operations). **Dinamismo = dato, no decoración.** transform/opacity/dashoffset only, ≤350ms, `prefers-reduced-motion`, 0 hex, número final en el DOM para lectores de pantalla.

## Por qué (diagnóstico vs. estado del arte)

`MetricCard` ya está a la altura de Stripe/Linear en **KPIs estáticos** (6 variants + count-up + spotlight + delta semántico). Tres huecos reales, confirmados por benchmark de productos líderes (2025–26):

1. **Cero dinamismo sobre dato vivo.** El count-up corre **una sola vez al montar** y nunca más. Tenemos data en tiempo real (tienda WS, command center, alertas) que hoy *snap*ea sin transición. El estándar actual es **rolling number / odometer** (NumberFlow) + **pulse suave en el valor que cambió**, con la disciplina de "no animar cada tick, solo lo que importa" (batch/umbral).
2. **Variedad de arquetipos incompleta.** J16 especifica 14; solo el grupo A (KPI) está construido. Entity/Alert/Readiness/Insight/Donut/RankList/Timeline no existen aún, y falta la base `card-surface` compartida.
3. **Interacción plana.** Hay spotlight + hover-lift, pero no **progressive disclosure** (la card muestra la señal; el click abre el detalle) — el patrón que usan Datadog/Linear/Attio en entornos data-densos.

## Propuesta — 3 capas

### Capa 1 · Dinamismo (hacer que las cards vivan)
- **`NumberFlowDirective`** — evoluciona `CountUpDirective`: roll de dígitos estilo odómetro **al cambiar el valor** (no solo al montar), dirección automática, formato `Intl` es-MX (currency/number/percent). `prefers-reduced-motion` → snap directo. Solo se activa en cards con dato vivo (opt-in por input).
- **Flash-on-change** — pulse sutil de fondo (≤300ms, `opacity`/`color-mix` sobre token) cuando el valor se actualiza desde dato vivo. Generaliza el patrón `.tk.flash` de `tienda-shared.css` al `card-surface`. **Regla dura:** no en cada tick — batch/umbral, si no es ruido (fuente: Smashing, real-time UX).
- **`aria-live="polite"`** en el nodo del valor que cambia (a11y de dato vivo, hoy ausente).
- **Indicador "live"** reutilizable (dot con pulse ya existente) para cards alimentadas por WS.

### Capa 2 · Variedad (nuevos micro-viz + arquetipos)
Nuevos átomos SVG en `shared/components/charts/` (0 KB, tokenizados, animan transform/dashoffset):
- **Bullet chart** (actual vs meta vs rango) — mejor semántica ops que la barra `progress` (Stephen Few).
- **Heat-strip** (intensidad por hora/día) — a la medida de `/tienda/pace` (venta por hora) y sell-through.
- **Stacked/segmented bar** (composición en una barra) · **dot/waffle grid** (N de M, ej. tiendas visitadas) · **diverging delta bars** (ganó/perdió).

Y **construir** los arquetipos B/C/D de [J16](FASE_J16_CARD_REPERTOIRE.md) sobre la base común: `EntityCard`, `AlertCard`, `ReadinessCard`, `InsightCard` (ember), `BreakdownCard` (donut), `RankListCard`, `TimelineCard`.

### Capa 3 · Interacción + estructura
- **`card-surface` base compartida** (stripe + spotlight + hover + tokens) — refactor habilitante que J16 marca pendiente; sin esto cada arquetipo diverge. Clase/directiva o mixin CSS global.
- **Progressive disclosure** — card clickeable → `SidePeekComponent` (ya existe, ver [[project_shared_drilldown_organisms]]) con el detalle completo. Glance arriba, ruido en el drill.
- **Bento real por default** — hero span-2 + clúster 2×2, no 4 cards iguales (la tendencia actual). Reusar `panel-col-*` + `[large]`.

## Barandales (no negociable)
Dinamismo = **dato, no decoración** (nada de gradientes latiendo ni íconos girando); solo `transform`/`opacity`/`stroke-dashoffset`; techos de motion ≤350ms; `prefers-reduced-motion`; 0 hex (tokens); el valor final siempre en el DOM. Ver [`DESIGN.md` §Motion de KPI cards (BINDING)](../../../DESIGN.md) y checklist pre-vuelo §7b.

## Plan de fases
- **J17.0 · Substrato** — 🟡 EN CÓDIGO 2026-07-10 (parcial). ✅ `CountUpDirective` con modo `live` (re-anima de valor anterior → nuevo, "rueda" en vez de snap; ease-out 600ms; respeta reduced-motion) · ✅ `MetricCard` inputs `live` → dot "en vivo" + **flash-on-change** (pulse de fondo tokenizado, `effect` sobre `value()`) + `aria-live="polite"` · ✅ piloto: "Venta del día" en `/tienda/pace` (`[live]="s.connected()"`, alimentado por el WS de tickets). Backward-compatible (`live` default false). Build verde. **Diferido:** odómetro de rueda de dígitos (el preview lo muestra; el código usa re-tween count-up como primer incremento) y la extracción de la base `card-surface` compartida (va con J17.2).
- **J17.1 · Micro-viz nuevos** — bullet, heat-strip, stacked-bar, dot-grid, diverging-bars como átomos SVG + integrarlos como variants de `MetricCard`.
- **J17.2 · Arquetipos B/C/D** — construir los 7 de J16 sobre `card-surface`.
- **J17.3 · Interacción** — progressive disclosure (side-peek) + pase de bento asimétrico en los strips existentes.

## Criterios de "done" por entrega
0 hex · base `card-surface` compartida · dinamismo solo sobre dato real (nunca fabricado) · reduced-motion + `aria-live` · Geist mono tabular · build prod verde (`--skip-nx-cache`) · QA visual light/dark/móvil.

## Preview
Recomendado: artifact interactivo (odómetro + flash + bullet + heat-strip + bento vivo) antes de escribir componentes — mismo enfoque que la galería que J16 referencia.

## Fuentes (benchmark 2026)
- [How Stripe, Linear, and Vercel Ship Premium UI — Mantlr](https://mantlr.com/blog/stripe-linear-vercel-premium-ui)
- [NumberFlow — animated number component](https://number-flow.barvian.me/)
- [UX Strategies for Real-Time Dashboards — Smashing Magazine](https://www.smashingmagazine.com/2025/09/ux-strategies-real-time-dashboards/)
- [Bento Grid Dashboard Design: Complete Guide 2026 — Orbix](https://www.orbix.studio/blogs/bento-grid-dashboard-design-aesthetics)
- [Spotlight Bento Grid — Expanding Feature Cards (Framer)](https://www.framer.com/marketplace/components/spotlight-bento-grid/)
