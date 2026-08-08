# Fase VG — "Ventas Generales" (tablero generativo de ventas)

> **Estado:** 🔨 DISEÑADO (planeación) — 2026-08-08
> **ADR:** ADR-042 (propuesto) — *Tableros generativos: el agente compone, el motor calcula.*
> Hereda ADR-016 (motor decide / agente comunica / **LLM fuera del camino del dinero**) y ADR-018 (Thot).
> **Ruta:** `/comercial/ventas-generales` · **Permiso página:** `COMMERCIAL_ANALYTICS_VER` · **Métrica margen:** gateada por `COMMERCIAL_MARGIN_VER` (restrictivo, anti-leak).

---

## 1. Tesis

Una sola página donde el usuario **pregunta en lenguaje natural** cualquier cosa del área de ventas ("dame las ventas por canal", "márgenes de cada proveedor", "histórico de ventas", "top 20 productos de la marca X este trimestre vs el pasado") y recibe un **tablero** de KPIs + tablas + gráficas **rellenado con datos deterministas**.

**La regla que lo define (ADR-016):** el LLM **NO calcula ni inventa números**. El agente traduce la pregunta a un **`spec` JSON validado contra un catálogo cerrado**; cada bloque del tablero se **rellena** llamando a una query determinista (o a los endpoints analytics que ya existen). Si la pregunta cae fuera del catálogo, el schema la rechaza y el agente re-parametriza o pide precisión — nunca alucina una columna o un total.

**Tres objetivos del usuario, explícitos:**
1. **Cubrir toda pregunta del área de ventas** → §3 catálogo exhaustivo + §4 cobertura.
2. **Sin inventar números** → §2 contrato anti-invención.
3. **Interfaz increíble, con animación y datos rápidos** → §7 UX, §8 animación, §9 performance.

---

## 2. Contrato anti-invención (BINDING)

1. **El LLM solo enruta.** Su única salida estructurada es el `spec` (§6): qué bloques, qué métrica/dimensión/rango/filtros. **Cero SQL, cero aritmética, cero cifras del modelo.**
2. **Los datos salen del motor determinista** (`analytics.sales_daily` + rollups + endpoints `network/*`, `sell-out`, `salidas`, `sales-by-route`, `historical/*`). El renderer hace el fetch; el número que se ve es el de la DB.
3. **Catálogo cerrado.** Métricas y dimensiones son un enum finito (§3). El `spec` se **valida server-side**; métrica/dimensión desconocida → 422 → el agente reintenta.
4. **Revenue-first.** La métrica "ventas" por default es **monto ($)**. `unidades` se ofrece pero **etiquetada** ("ruido conocido desde oct-2025", ver [[project_units_inflation_oct2025]]); nunca es el default.
5. **Cobertura de costo visible.** Todo bloque con margen muestra `cost_coverage_pct` (% del revenue con costo capturado) — si es bajo, se advierte; el margen nunca se presenta como exacto sin ese contexto.
6. **Margen gateado.** Métrica `margen` requiere `COMMERCIAL_MARGIN_VER`. Si el usuario no lo tiene, el agente **omite** ese bloque (no lo pinta vacío) — anti-leak (patrón GATE de take-order, [[project_take_order_margin_rotation]]).
7. **Cada número no trivial trae su definición** (answer-first, DESIGN §15): "ventas = venta real fulfilled/POS, 30d" al lado del KPI.
8. **Se persiste el `spec`, no la llamada al LLM** (§9) → refrescar = re-fetch determinista, sin re-invocar IA → reproducible y barato.

---

## 3. Catálogo semántico de ventas (el corazón)

Toda pregunta del área debe caer en `métrica × dimensión × rango × viz`. Fuente real y estado:

### 3.1 Métricas

| Métrica | Fuente real | Estado |
|---|---|---|
| **`ventas` (monto $)** | `analytics.sales_daily.revenue` (+ rollups mensuales) | ✅ sólido — **default** |
| **`unidades`** | `sales_daily.units` | ⚠️ ruido oct-25 → etiquetada, no default |
| **`tickets`** | `sales_daily.tickets` | ✅ |
| **`ticket_promedio`** | `revenue / tickets` (`networkOverview.avg_ticket`) | ✅ |
| **`margen` ($ y %)** | `sales_daily.cost` + `margin` (generated) → `network/*`; por categoría `historical/margin-by-category` | ✅ (gateado `COMMERCIAL_MARGIN_VER`) + mostrar `cost_coverage_pct` |
| **`costo`** | `sales_daily.cost` / `catalog.products.cost_base` | ✅ (gateado como margen) |
| **`participación %` (share)** | derivada (celda / total dimensión) | ✅ (ya en sales-by-brand/route) |
| **`cobertura` (días)** | `analytics.inventory_health` | ✅ (contexto de venta vs stock) |
| **`pedidos` (pipeline B2B)** | `commercial.orders` (overview) | ✅ — **distinto de venta real**, se rotula "pedidos B2B" |

### 3.2 Dimensiones

| Dimensión | Fuente | Árbol/catálogo |
|---|---|---|
| **canal** | `sales_daily.channel` | ✅ árbol CANAL (`sell-out/canales`) |
| **marca / empresa** | `catalog.brands` | ✅ (`sell-out/brands`) |
| **sucursal / almacén** | `commercial.warehouses` | ✅ (`sell-out/warehouses`) |
| **ruta** | `analytics.sales_by_route_monthly` | ✅ (`sales-by-route/routes`) |
| **cliente** | `analytics.customer_product_sales` / `commercial.customers` | ✅ (`erp-customers`, `top-customers`) |
| **vendedor** | `analytics.sales_by_vendor_monthly` (solo Wincaja) | ✅ árbol VENDEDOR (`sell-out/vendors`) — rotular "Wincaja" |
| **proveedor** | `catalog.products.supplier` ⋈ `sales_daily` | 🔨 roll-up a construir (existe el join) |
| **categoría** | `catalog.categories` | ✅ (`salidas/categories`, `margin-by-category`) |
| **producto / SKU** | `catalog.products` | ✅ (`top-products`, `salidas`) |
| **tiempo** | día (`sale_date`), semana ISO, mes (`*_monthly`), año | ✅ |

### 3.3 Rango temporal (ciudadanos de primera clase)

- Presets: hoy, 7d, 30d, mes actual, trimestre, año, YTD, **rango custom**.
- **Comparativos MoM / YoY / período-vs-período** como modo del bloque (Δ y Δ% multimodal, no solo color). *(Requisito confirmado por el usuario.)*
- Granularidad: día / semana / mes / año (auto según rango; histórico largo → mensual).

### 3.4 Vistas (viz) del catálogo

`kpi-strip` · `table` (densa, sort, drill) · `bar` · `line/area` (serie/histórico) · `donut` (composición) · `bullet` (vs meta) · `ranking` (top-N) · `matrix` (producto × tiempo/dimensión, estilo sell-out) · `comparison` (período vs período).

---

## 4. Cobertura — "toda pregunta de ventas"

Prueba de cobertura (pregunta → resolución determinista):

| Pregunta del usuario | metric | dimension | rango/viz | Fuente |
|---|---|---|---|---|
| "ventas y desglose por canales" | ventas | canal | 30d · kpi+table+bar | `network/overview.by_channel` |
| "histórico de ventas" | ventas | tiempo | 24m · line | `sales_daily`/`daily-series` |
| "márgenes de cada proveedor" | margen | proveedor | 30d · table+bar (gateado) | `sales_daily`⋈`products.supplier` |
| "top 20 productos por venta" | ventas | producto | 30d · ranking | `top-products`/`network/top-products` |
| "ventas por sucursal este mes vs anterior" | ventas | sucursal | MoM · comparison | `sales_daily` mensual |
| "mix por marca" | ventas | marca | 30d · donut+table | `network/sales-by-brand` |
| "ventas por ruta del año" | ventas | ruta | año · matrix | `sales-by-route` |
| "quién vende más (vendedor)" | ventas | vendedor | 30d · ranking | `sell-out/by-vendor` (Wincaja) |
| "margen por categoría" | margen | categoría | 30d · table | `historical/margin-by-category` |
| "mis mejores clientes" | ventas | cliente | 30d · ranking | `top-customers` |
| "productos sin rotación / stock muerto" | costo | producto | — · table | `dead-stock` |
| "ticket promedio por canal" | ticket_promedio | canal | 30d · bar | `network/overview` |

**Regla de completitud:** si aparece una pregunta que no mapea a una celda del catálogo, **se agrega la celda al catálogo** (no se resuelve con SQL libre del LLM). El catálogo es el límite explícito y auditable de lo que el tablero puede responder con verdad.

---

## 5. Arquitectura (3 capas)

```
Pregunta NL
   │
   ▼  (Thot ReAct — SOLO enruta)
compose_sales_view  ──►  spec JSON (validado vs catálogo §3)
   │
   ▼  (DashboardRenderer)
por cada bloque: fetch determinista ──►  /commercial/analytics/query  ó  endpoint existente
   │
   ▼
widget del registry (MetricStrip / p-table / sparkline / Chart.js) con datos reales
```

- **Capa 1 — Catálogo + resolvedor determinista.** Endpoint semántico único `POST /commercial/analytics/query { metric, dimension, filters, range, granularity, compare }` que resuelve sobre `sales_daily`/rollups, **o** un adaptador que despacha a los endpoints ya existentes (`network/*`, `sell-out`, `sales-by-route`, `historical/*`). Reusa la lógica de `thot_flexible_aggregate` (ya hace metric×group_by).
- **Capa 2 — `spec` (§6).** Contrato JSON entre agente y UI.
- **Capa 3 — Renderer + registry.** `DashboardRenderer` (Angular) mapea `block.type` → componente; cada widget hace su fetch. Reusa `MetricStrip`, `sparkline`, `ring-gauge`, `mini-bars`, `p-table`, Chart.js + tokens/dark.

---

## 6. Schema del `spec` (contrato)

```jsonc
{
  "title": "string",
  "period": { "range": "30d|mtd|qtd|ytd|year|custom", "from?": "YYYY-MM-DD", "to?": "YYYY-MM-DD",
              "compare?": "none|mom|yoy|prev" },
  "scope":  { "warehouses?": ["id"], "channels?": ["k"], "brand_id?": "uuid", "supplier_id?": "uuid" },
  "blocks": [
    { "type": "kpi-strip|table|bar|line|donut|bullet|ranking|matrix|comparison",
      "title": "string",
      "source": { "metric": "ventas|unidades|tickets|ticket_promedio|margen|costo|share",
                  "dimension?": "canal|marca|sucursal|ruta|cliente|vendedor|proveedor|categoria|producto|tiempo",
                  "granularity?": "day|week|month|year",
                  "limit?": 20, "sort?": "desc" },
      "layout": { "w": 12 },          // grid 12-col
      "drilldownTo?": "/comercial/sell-out?..."  // deep-link al reporte especializado
    }
  ]
}
```

- **Validación server-side**: `metric`/`dimension`/`type` contra enums; `margen`/`costo` exige permiso; `warehouses`/`brand_id` deben existir.
- El `spec` es **serializable y guardable** (§9, tableros guardados).

---

## 7. Interfaz (UX "increíble", DESIGN Operations)

- **Layout:** caja de pregunta sticky arriba (con chips de ejemplos + follow-ups) → **grid 12-col** responsivo de bloques → footer de frescura/fuente.
- **Answer-first (DESIGN §15):** primer bloque siempre un `kpi-strip` con el veredicto; el detalle (tablas/matrices) debajo.
- **Navegable a su arreglo:** cada bloque con `drilldownTo` → deep-link al reporte especializado ya existente (Sell-Out / Salidas / Ventas por ruta / Costo neto) con el filtro puesto — **no se reinventa** el drill.
- **Estado en URL:** el `spec` (o su id guardado) va en la URL → F5/compartir reproduce el tablero.
- **Comprensión:** cada métrica con su lectura en llano + `<app-context-help topic="ventas-generales">` (jerga: venta real vs pipeline, canal, cobertura de costo, MoM/YoY, unidades con ruido).
- **Export** XLSX/PDF del tablero (reusa `SellOutExportService`). *(Requisito confirmado.)*
- **Empty/error** operacionales (icono + microcopy + reintento) — nunca vacío mudo.

---

## 8. Animación (con techo, DESIGN §8 / motion de KPI)

- **Count-up** de cifras on-view (IntersectionObserver, una vez, ~900ms, `CountUpDirective` ya existe). `prefers-reduced-motion` → instantáneo.
- **Entrada stagger** de bloques en el primer paint (`translateY(8–12px)+opacity`, 150–250ms, stagger 30–60ms). Nunca en refresh.
- **Sparklines draw-in** (`sparkline.component` ya anima el trazo) para series.
- **Transiciones** solo `transform`+`opacity`, **≤350ms** ease-out. Nada de gradientes latiendo ni glow.
- **Skeleton dimensionado (CLS 0)** + crossfade ~180ms a data. El movimiento **codifica dato** (count-up, delta ▲/▼), no decora.

---

## 9. Datos rápidos (performance)

- **Rollups primero:** rango largo → `*_monthly`/`sales_boxes_monthly`/`product_sales_stats`/MVs; live (`sales_daily`) solo para rangos cortos o `?live`.
- **Spec cacheado, no la IA:** una vez compuesto el tablero, refrescar solo re-fetchea datos (sin re-invocar a Thot) → instantáneo y sin costo de tokens.
- **Fetch por bloque en paralelo** + caché HTTP corta por (source+params). Skeleton por bloque (no bloquea el tablero).
- **Frescura visible** por fuente (Kepler / Wincaja), con nota honesta del consolidado multi-fuente.

---

## 10. Thot compone (`compose_sales_view`)

- Se agrega la tool a `thot-tools.service.ts::definitions()` (input_schema = el `spec` §6) y se **intercepta como turno terminal** en `thot-chat.service.ts` — réplica exacta del patrón `render_response` de Maat (`maat-tools.service.ts` + `maat-chat.service.ts`).
- Las tools de datos ya existen (`thot_flexible_aggregate`, `thot_sales_timeseries`, `thot_margin_by_category`, …) → el agente puede **verificar** un total antes de componer, pero el tablero final se rellena por el renderer (determinista).
- Few-shot: `thot-examples.service.ts` con las preguntas de §4 → specs canónicos.

---

## 11. Permisos (auto-suficiencia, [[feedback_view_self_sufficient_permissions]])

- Página: `COMMERCIAL_ANALYTICS_VER`.
- El endpoint semántico `/analytics/query` acepta `COMMERCIAL_ANALYTICS_VER` (los lookups de dimensión que reusen `sell-out/*` deben aceptar también este permiso vía `@RequireAnyPermission` — mismo fix que Salidas).
- Métrica `margen`/`costo` → `COMMERCIAL_MARGIN_VER` (nuevo, restrictivo, sin seed → alta en `/admin/roles` + re-login; receta [[reference_add_permission_recipe]]).

---

## 12. Fases

| Fase | Alcance | IA |
|---|---|---|
| **VG.0** | Catálogo + `spec` schema + `DashboardRenderer` + registry (4 widgets: kpi-strip, table, bar, line) sobre endpoints **existentes**. Specs a mano. Ruta `/comercial/ventas-generales`. | ❌ (70% del valor, cero riesgo) |
| **VG.1** | Endpoint semántico `/analytics/query` (adaptador determinista) + comparativos MoM/YoY. | ❌ |
| **VG.2** | Tool `compose_sales_view` en Thot + caja de pregunta + follow-ups + few-shot. | ✅ |
| **VG.3** | Margen gateado (`COMMERCIAL_MARGIN_VER`) + roll-up proveedor + `cost_coverage`. | — |
| **VG.4** | Tableros guardados por usuario/tenant + export XLSX/PDF + estado en URL por id. | — |
| **VG.5** | Más viz (matrix/bullet/ranking/donut), drill cruzado, deep-links a reportes. | — |
| **VG.6 (gated)** | Text-to-SQL acotado sobre réplica read-only (solo si el catálogo se queda corto; con `LIMIT`/timeout/"ver el SQL"). | ✅ |

**Ruta crítica:** VG.0 → VG.1 → VG.2. MVP demostrable = VG.0 (sin IA).

---

## 13. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Números mal (lo más grave) | §2 contrato: datos deterministas; margen con `cost_coverage`; revenue-first. |
| Alucina métrica/dimensión | Enum + validación server-side → 422 + reintento. |
| Solapa con reportes existentes | Deep-link a Sell-Out/Salidas/Ruta, no los reemplaza. |
| Histórico lento | Rollups mensuales + caché + skeleton por bloque. |
| Costo/latencia IA | Spec cacheado; refresh sin re-invocar LLM. |
| Margen sensible | Gate `COMMERCIAL_MARGIN_VER` (anti-leak). |
| Ambigüedad de la pregunta | Defaults (ventas$, 30d, red completa) + follow-up para afinar. |
| Multi-fuente (Kepler+Wincaja) | Anclar al consolidado; frescura por fuente visible. |

---

## 14. Decisiones abiertas

- **ADR-042**: aceptar el patrón "tablero generativo" (propuesto).
- **Endpoint semántico nuevo `/analytics/query`** vs. adaptador sobre endpoints existentes (recomendado: adaptador primero).
- **`COMMERCIAL_MARGIN_VER`**: crear el permiso restrictivo para el margen.
- **Persistencia de tableros**: tabla `analytics.saved_dashboards` (tenant + user + spec JSONB) — VG.4.
- Nombre del nav: item "Ventas generales" en grupo **Reportes** de Comercial.

---

## Referencias
- ADR-016 (motor/agente/LLM), ADR-018 (Thot). Inventario de datos: `analytics.sales_daily` (cost+margin), `network/*`, sell-out (árbol canal/vendedor), `sales-by-route`, `historical/margin-by-category`, rollups `*_monthly`/MVs. Patrón render: Maat `render_response`. Widgets: `MetricStrip`/`sparkline`/`ring-gauge`/`mini-bars`.
- Verdades de datos: [[project_units_inflation_oct2025]] (revenue-first), [[feedback_view_self_sufficient_permissions]] (permisos), [[project_take_order_margin_rotation]] (anti-leak margen).
