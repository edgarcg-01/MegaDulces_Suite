# Fase J16 — Repertorio de cards (catálogo de patrones)

> **Evolución →** [`FASE_J17_CARD_SYSTEM_2.0.md`](FASE_J17_CARD_SYSTEM_2.0.md): dinamismo sobre dato vivo (odómetro/flash), nuevos micro-viz (bullet, heat-strip, dot-grid) y progressive disclosure. J16 es el catálogo; J17 lo hace vivo.

> **Qué:** biblioteca de **arquetipos de card** dinámicas/interactivas para reemplazar sistemáticamente las cards básicas (`p-card` planas, stat-cards sueltas) de **todo el proyecto**. Extiende el sistema `MetricCard` (J14/J15) a todos los tipos de card, no solo KPIs.
> **Galería visual interactiva:** artifact "Repertorio de Cards" (hover/spotlight/sparkline/count-up vivos).
> **Norma:** DS Mercado — Stone + sunset, Geist mono en cifras, hairline 1px, spotlight al hover, count-up, `prefers-reduced-motion`, techos de motion ≤350ms.

## Inventario de deuda (dónde hay cards básicas)
~107 usos de card en 17 archivos. Focos de `p-card`/stat-card obsoletas:
- `televenta-dashboard` (14) · `supervisor-ai` (19) · `comercial-order-detail` (9) · `dashboard/reports/graphics` (12+11) · `comercial-route-tickets` (5) · `comercial-vendor-sales` (4) · `logistica-checklist/photos` (10) · `televenta-lead/take-order` (5).

---

## Los 14 arquetipos

### A · Métricas KPI — `MetricCard` (✅ ya existe)
1. **Stat + sparkline** — valor + delta + mini-línea con área + tooltip al hover. `variant="sparkline"`.
2. **Gauge / anillo** — % al centro (on-time, readiness). `variant="gauge"`.
3. **Mini bar-chart** — barras por día, hover→valor. `variant="bars"`.
4. **Progreso a meta** — barra `N/meta` + %. `variant="progress"`.
5. **Delta gigante / hero** — número grande + tendencia. `[large]` + `variant`.
6. **Ember (IA)** — gradiente ámbar→sunset para ROI/insight. `variant="ember"`.

### B · Entidad e interacción (nuevos — extienden el repertorio)
7. **Entity card** — avatar/código + nombre + meta + status pill + **acciones que aparecen al hover** (editar/abrir). Reemplaza: listados de clientes/productos/unidades en `p-card`, `comercial-vendor-sales`, tarjetas de lead en `televenta-lead`.
8. **Alert / signal card** — stripe de severidad + título + detalle + folio + acción + timestamp. Reemplaza: feed de alertas de Command Center, `supervisor-ai`, alertas de flota.
9. **Readiness / checklist card** — barra de % + grilla de checks ✓/✗. Reemplaza: `logistica-checklist`, semáforos sueltos.
10. **AI recommendation card** — chip "✦ Sugerido" + score + razón + CTA. Reemplaza: tarjetas de Thot/Horus, sugeridos del vendedor/portal.

### C · Datos compuestos
11. **Breakdown donut** — dona con leyenda compacta (costos por categoría, mix de marcas). Reemplaza: charts sueltos en `reports/graphics`.
12. **Mini-table / Top-N** — ranking embebido con `rank` + valor mono. Reemplaza: top-customers/products del Command Center hoy en tablas planas.
13. **Leaderboard / rank bars** — filas con barra de proporción (cobertura por ruta, ranking vendedores). Reemplaza: listados de `comercial-vendor-sales`.

### D · Actividad, geo, acción
14. **Timeline / activity card** — eventos verticales con dot semántico. Reemplaza: historial de pedido/embarque en `comercial-order-detail`.
- **Geo / map mini card** — mini-mapa con marcador + ruta (unidad en vivo, cliente). Reemplaza: previews de mapa sueltos.
- **Action / empty card** — estado vacío accionable como card (icono + texto + CTA). Reemplaza: empty states tipo "No hay datos".
- **Media / photo card** — thumbnail grid. Reemplaza: `logistica-photos`.

---

## Anatomía común (todos heredan)
- **Base:** `bg card · borde 1px hairline · radius 14 · stripe de color (3px) · spotlight ::after que sigue el cursor`.
- **Color por card:** `[accent]` (token de paleta chart) tiñe stripe + gráfica + fondo 5% + spotlight.
- **Jerarquía:** ancho con `panel-col-*` + `[large]` para el hero. Bento, no todas iguales.
- **Cifras:** Geist mono tabular + **count-up**.
- **Interacción:** hover lift + spotlight; gráficas con tooltip; acciones ghost que aparecen al hover.
- **A11y/motion:** `prefers-reduced-motion`, transform/opacity only, focus visible.

## Plan de extensión del organismo
- **MetricCard ya cubre** A (1–6).
- **Nuevos componentes** en `shared/components/cards/` reusando la base (stripe + spotlight + tokens):
  - `EntityCardComponent` (7) · `AlertCardComponent` (8) · `ReadinessCardComponent` (9) · `InsightCardComponent` (10, ember) · `BreakdownCardComponent` (11, donut SVG) · `RankListCardComponent` (12/13) · `TimelineCardComponent` (14).
  - Atomos reusables ya hechos: `Sparkline`, `RingGauge`, `MiniBars`. Agregar `DonutComponent` (SVG) para 11.
- **Base compartida:** extraer la "card shell" (stripe + spotlight + hover + tokens) a una clase/directiva `card-surface` o mixin CSS global para que todos los tipos la hereden sin duplicar.

## Orden de aplicación (por impacto)
1. **Command Center** (dashboard) — top-N → Mini-table card; alertas → Alert card; KPIs ya migrables a MetricCard.
2. **comercial-order-detail** — historial → Timeline card; stat cards → MetricCard.
3. **supervisor-ai / Thot** — insights → AI recommendation card; alertas → Alert card.
4. **televenta-dashboard** — KPIs + entidades.
5. **reports/graphics** — Breakdown donut + Mini-table.
6. **logistica checklist/photos** — Readiness + Media cards.

## Criterios de "done" por card migrada
0 hex (tokens) · base compartida (stripe+spotlight) · count-up donde hay cifra · interacción (hover/tooltip/acciones) · responsive + a11y + reduced-motion · build verde · QA visual.

## Estado

### Piloto /comercial/orders ✅ código 2026-06-22
- KPI strip migrado de `sheet/cell` + barra ratio custom → **`MetricCard`**: hero "Ventas" (col-6 large + **sparkline** de monto diario) + status como **`variant="progress"`** (share sobre el libro) con **color por estado** (warn/gris/azul/verde/rojo). Jerarquía bento + spotlight + count-up heredados.
- Backend nuevo `GET /commercial/orders/kpi-series` (`dailySeries`, mismo scope que `/counts`, default 30d, sin N+1) → alimenta el sparkline.
- **Count-up consolidado:** `MetricCard` ahora usa `CountUpDirective` (única impl; on-view, no re-anima en refresh). Removido el count-up interno duplicado + input `animate`.
- Limpieza: borrados `fmtMoney`/`fmtMoneyShort` muertos. Builds api+view verdes.

### Sección /comercial/inventory ✅ código 2026-06-23
Migrada toda la familia de KPIs obsoletos a `MetricCard` (bento + data-viz + color por card + count-up):
- **Existencias** — `sheet/cell` → bento: hero **Valor disponible** (col-6 large, `bars` de valor por almacén con tooltip) + Unidades on-hand (`bars` por almacén) + Líneas + triada de salud (saludable/crítico/sin-stock como `progress` sobre el total). Borrado `fmtUnits` muerto + `CardModule` no usado.
- **Por vencer** — `ex-kpi` custom (con hex `#fff/#e7e5e4/#dc2626`) → bento: hero **Valor en riesgo** (`bars` por urgencia: Vencido/≤7/≤15/≤30/>30) + Lotes + Ya vencidos (`progress`). Hex de tabla → tokens (`--bad-soft-bg`, `--c-text-2`).
- **Cíclico (ABC)** — `abc-kpi` custom → bento: Por contar ahora (`bars` por clase A/B/C) + Valor clasificado + Distribución ABC (breakdown segmentado bespoke con shell consistente; mantiene color semántico por clase). Hex `--stone-400` → `--chart-8`.
- **Mejora del organismo:** `MetricCard` ahora reenvía `seriesLabels` a sparkline/mini-bars (tooltip contextual, ej. nombre de almacén) + input `highlightLast` (apagar cuando las barras son ranking, no serie temporal).
- **Exactitud (IRA)** — 4 `ira-kpi` custom (hex `#78716c/#16a34a/#dc2626/#e7e5e4/#fff`) → bento: **IRA piezas** y **Exactitud por valor** como `gauge` de anillo (color por umbral: ≥97 ok / ≥90 warn / <90 bad) + Variación neta (currency, accent por signo) + Folios (number). Hex de tabla → tokens.
- `sessions` (folios) y `aisles` (editor 2D) no tenían KPIs obsoletos. Builds api+view verdes, 0 hex.
- **Deuda restante en la sección** (no KPIs, pero hex sin tokenizar): `count` (38 hex), `teams` (20 hex), `session-detail` (38 hex + 12 bloques tipo card). Candidatos a barrido de hex + repertorio (Timeline/Entity).

### /comercial/products ✅ código 2026-06-23
- **Bug de fondo corregido:** el KPI strip calculaba activos/con-costo/con-ubicación **solo sobre la página visible** (`this.rows()`, ~50 de 11k SKUs → cifras sin sentido). Ahora son **catálogo-wide**.
- **Backend nuevo** `GET /commercial/products/stats` (`CommercialProductsService.stats`, gated `CATALOGO_GESTIONAR`, ruta **antes** de `:id`): agregación en una pasada con `COUNT(*) FILTER (...)` (total/activos/inactivos/con-costo/con-ubicación + DISTINCT marcas/categorías) + top 8 marcas por # SKU. Honra `search` (los KPIs describen el universo filtrado por texto, no los segmentos de la tabla). Validado contra DB: 11.398 SKUs · 6.621 activos · 425 marcas.
- **Frontend** `sheet/cell` → bento `MetricCard`: **SKUs** (`bars` de SKU por top-marca con tooltip) + Activos/Con-costo/Con-ubicación como `progress` sobre el total (color por card: ok/azul/teal). `stats` signal recargado solo al cambiar `search` (no en paginado/segmentos) + tras editar. Borrado el `kpis` por-página. Skeleton 132px.
- Builds api+view verdes, 0 hex. **HTTP pendiente de redeploy** del contenedor API (la imagen corriendo es la previa al endpoint).

### /comercial/route-tickets ✅ código 2026-06-23
- Page-head bespoke `.rt-head` → canónico `surf-page-head` + `surf-page-sub` (consistencia con la sección).
- 4 KPIs en `p-card` plano → bento `MetricCard`: Ventas (ok) · Combustible (bad) · **Rentabilidad** (accent por signo: verde gana / rojo pierde / neutro) · Tickets (azul). Count-up + spotlight + color por card heredados. Sin serie fabricada (la lista de tickets es muestra capada a 100 → un sparkline diario sería engañoso; KPIs honestos sobre `routeResumen`).
- Borrados estilos `.kpi/.k*`. Build view verde, 0 hex.

### /comercial/vendor-sales ✅ código 2026-06-23
- Page-head bespoke `.vs-head` → canónico. 3 KPIs `p-card` → bento `MetricCard`: **Tickets** (col-6 large, **sparkline real de tickets/día** — `captures()` es el dataset completo del rango, no muestra) + Líneas (azul) + Unidades (teal).
- Fix DESIGN.md: letterbox de la foto del ticket `background:#000` (negro puro prohibido) → `var(--neutral-900)` (espresso). Borrados estilos `.kpi/.k*`. Build verde, 0 hex.

### Pendiente
- Resto del repertorio (Entity, Alert, Mini-table, Timeline, Breakdown donut, RankList) como componentes en `shared/components/cards/` + base `card-surface` compartida.
- Aplicar a: order-detail (timeline) · supervisor-ai/Thot (insight/alert) · televenta · reports/graphics (donut) · checklist/photos.
- QA visual con API arriba.
