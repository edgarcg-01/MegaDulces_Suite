# Fase J14 — Rediseño de tarjetas KPI (data-viz + animación)

> **Qué:** reemplazar las tarjetas planas (`metric-tile` = label + número + stripe) por un **sistema de tarjetas ricas** con micro-gráficas (sparkline, anillo, barras, donut), tendencia y **animación**. Mismo stack (Angular + tokens), elevando a nivel dashboards clase mundial (Linear/Attio/Stripe).
> **Por qué:** las cards actuales se ven "básicas". Una tarjeta KPI debe contar la historia de un vistazo: valor + dirección + forma de la tendencia.
> **Surface:** Operations. Aplica a dashboard, reports, guides, costs, staff, shipments (KPI strip) y command-center.

## Objetivo visual (aprobado vía Stitch)
Mockup con DS "Commercial Operations" (Stone + sunset, Hanken + Geist) — 6 variantes:
1. **Sparkline** — número grande + delta + mini línea con área degradada.
2. **Gauge / anillo** — donut de % al centro.
3. **Mini bar-chart** — N barras (días) + total, barra de hoy resaltada.
4. **Delta gigante** — número enorme + chip de tendencia (▲/▼) + comparativo "vs período anterior".
5. **Progreso a meta** — barra horizontal + `N / meta` + %.
6. **Ember (IA)** — gradiente ámbar→sunset + insight + sparkline (para ROI / km ahorrados).

---

## Principios
1. **Data-viz liviana inline (SVG), no dependencia pesada por tarjeta.** Sparkline/anillo/barras = SVG propio, 100% tokenizable (`--action`, `--ok-fg`…), animable (stroke-dashoffset, scaleY), 0 KB extra. `chart.js`/PrimeNG se reserva a los charts grandes (donut breakdown, series largas).
2. **Animación con techo (Linear):** entrada ≤350ms ease-out, micro 150ms; solo `transform`/`opacity`/`stroke-dashoffset`. **`prefers-reduced-motion` → sin draw-in, sin count-up** (valor final directo).
3. **Un organismo compartido, muchas variantes** — no re-implementar por pantalla. `shared/components/ui/`.
4. **Tokens o nada** — colores de gráfica = `--action`/`--chart-*`/semánticos; números Geist Mono tabular; bordes hairline 1px sin sombra (overlay-only sombra).
5. **Degradación sin datos** — si no hay serie, la tarjeta cae a número + label (nunca rota).

---

## Arquitectura propuesta

### Átomos SVG (nuevos, en `shared/components/ui/charts/`)
- `SparklineComponent` — `[data]:number[]`, `[area]:bool`, `[color]`; path + área; draw-in por `stroke-dashoffset`.
- `RingGaugeComponent` — `[value]`, `[max]`, `[label]`; arco SVG (reusa lógica de `.rk-gauge` que ya existe en styles.css); anima dasharray.
- `MiniBarsComponent` — `[data]:number[]`, `[highlightLast]`; barras con `transform: scaleY` escalonado.
- `CountUpDirective` — `[appCountUp]:number` anima 0→valor (rAF, ~600ms), respeta reduced-motion + tabular-nums.

### Organismo `MetricCardComponent` (nuevo)
Un componente con `variant` y slots:
```
<app-metric-card
   label="Ingreso flete" [value]="..." [delta]="+12" deltaDir="up"
   variant="sparkline" [series]="series" sub="vs período anterior"
   tone="default|ok|warn|bad|brand|ember">
```
- Variants: `plain` (la actual, fallback) · `sparkline` · `gauge` · `bars` · `progress` (con `[goal]`) · `ember`.
- Reusa `metric-label`/`metric-value` ya tokenizados; agrega el slot de viz según variant.
- Hover lift sutil (`translateY(-2px)` + shadow overlay) — opcional por `[interactive]`.

### Migración de uso
- `surf-grid` + `metric-tile` → `surf-grid` + `<app-metric-card>` en: dashboard (4), reports (overview+roi), guides (5), costs (5), staff (4). El KPI strip de shipments (`sheet/cell`) se evalúa aparte (puede quedar o migrar).

---

## Datos (backend)
Las micro-gráficas necesitan **series cortas**. Plan:
- **Reusar lo que ya existe** donde se pueda (reports ya trae series para charts).
- **Nuevo endpoint** `GET /logistics/analytics/kpi-cards?from&to` → devuelve por KPI: `{ value, delta_pct, series:number[], goal? }` (revenue 14d, shipments/día 7d, on-time %, km vs meta, etc.). 1 request alimenta toda la fila — sin N+1. Patrón del `/shipments/counts` ya hecho.
- Degradación: si `series` viene vacío, la card renderiza `plain`.

---

## Fases
- **F0 · Átomos SVG + organismo** — Sparkline, RingGauge, MiniBars, CountUp, `MetricCard` con 6 variants. Storybook-less: una ruta/preview interna o validación en dashboard. Build verde.
- **F1 · Backend KPI series** — endpoint `kpi-cards` (service `kpiCards()` + controller, sin N+1) + tipos en `logistica.service.ts`.
- **F2 · Migración por pantalla** — dashboard (piloto) → reports → guides/costs/staff. Cada una: reemplazar metric-tile por `<app-metric-card variant=…>`, cablear series.
- **F3 · Animación + a11y QA** — count-up + draw-in con `prefers-reduced-motion`; focus/contraste; verificación visual.

## Orden sugerido
**F0 (átomos + organismo) + dashboard piloto** → ver una pantalla real con las cards nuevas → resto.

## Criterios de "done" por tarjeta
0 hex (tokens) · SVG inline animado · count-up + reduced-motion · número Geist mono tabular · delta semántico · degradación sin datos · build verde · QA visual.

## Riesgos
- **Series de datos** — si el backend no tiene la serie, la card cae a `plain`; no bloquea.
- **Animación en listas densas** — NO animar dentro de tablas; las cards sí (son pocos elementos). Techo de motion estricto.
- **Reuso real** — el organismo debe cubrir las 6 variantes sin forks por pantalla (riesgo de divergencia si se apura).

## Estado

### F0 — átomos SVG + organismo ✅ código 2026-06-22
- `shared/components/charts/`: **SparklineComponent** (línea+área, draw-in por stroke-dashoffset), **RingGaugeComponent** (arco animado), **MiniBarsComponent** (barras scaleY escalonado). Todos tokenizados + `prefers-reduced-motion`.
- `shared/components/metric-card/`: **MetricCardComponent** — 6 variantes (plain/sparkline/gauge/bars/progress/ember) + **count-up** interno (easeOutCubic ~700ms, rAF, respeta reduced-motion) + delta chip semántico + degradación a `plain` sin datos. Inputs señal (`input()`), OnPush.

### F1 — backend KPI series ✅ código 2026-06-22
- `GET /logistics/analytics/kpi-cards?from&to` → `{ shipments, revenue, cost, margin }` cada uno con `value` + `delta_pct` (vs período previo de igual largo) + `series` (diaria alineada al rango). Reusa `overview` ×2 + 2 queries diarias (ships/expenses), sin N+1. Frontend: `analyticsKpiCards()` + interfaces `KpiCard`/`KpiCards`.

### F2 — dashboard piloto ✅ código 2026-06-22
- Las 4 metric-tiles → `<app-metric-card>`: Volumen=**bars** (últimos 14 días), Ingreso=**sparkline** (tone brand), Costo=**sparkline**, Margen=**sparkline** (tone ok/bad por signo). `forkJoin` ahora trae `kpi-cards`. Skeleton 132px. Builds api+view verdes.

### Pendiente
- F2 resto: reports (gauge on-time + ember km-ahorrados + progress), guides/costs/staff.
- F3: QA visual (count-up + draw-in + dark mode) con API arriba + smoke `/kpi-cards`.
