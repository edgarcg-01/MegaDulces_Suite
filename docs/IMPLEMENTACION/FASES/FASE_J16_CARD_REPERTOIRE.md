# Fase J16 — Repertorio de cards (catálogo de patrones)

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
- ⬜ Diseñado (este doc + galería interactiva). `MetricCard` (A) ya en uso en logística. Arranque sugerido: extraer la **card-surface compartida** + construir **Entity / Alert / Mini-table / Timeline** (los de mayor reuso) y aplicar al **Command Center** como piloto.
