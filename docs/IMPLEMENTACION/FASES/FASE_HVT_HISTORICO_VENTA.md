# Fase HVT — Histórico de Venta (consola multi-año + consulta inline al pedir)

> Estado: **🔨 EN CURSO** · v2 2026-08-05 · single dev (Edgar)
> Ejes decididos: **Producto/SKU + Cliente/tercero**. Profundidad: **historia profunda multi-año**.

---

## v2 (2026-08-05) — enfoque CALIBRACIÓN DE DEMANDA + UI-light (plan activo)

Reencuadre: el histórico nace como **insumo de la investigación de calibración de demanda**
(¿por qué /compras sugiere ~20-50× lo que el comprador pide en La Rosa?) y con la restricción
dura **no recargar la interfaz**.

**Principio rector: datos pesados, UI mínima.** Cero nav items nuevos, cero páginas top-level.
La historia se ve DENTRO del drill-down que ya existe (`SidePeek` + Customer360) como una
pestaña "Historia"; un solo `<sales-history-peek>` reutilizable. Entrada por el buscador global.

**Simplificación clave:** para calibrar demanda basta la ventana viva (2024-05 → hoy, ~22 meses,
ya en `sales_daily`). → **se DIFIERE toda la costura `ventas_legacy` FDW / SEAM_DATE** (Fase 0.3
del plan v1). Menos riesgo, menos datos, menos UI. La historia pre-sistema queda para una v3.

### Capa de datos
- **`analytics.sales_monthly`** ✅ — rollup mensual durable (producto×almacén×canal×mes) desde
  `sales_daily`. **151 MB vs 2.7 GB** del diario (18×). Guard de fechas `>= 2024-01-01 AND <= hoy`
  (mata basura 2000/2014/2020 y futuros 2026-12-06 de wincaja_ruta, sin borrar `sales_daily`).
- **`analytics.v_sales_demand_truth`** (HVT.2) — demanda por SKU SIN doble-conteo de hub (excluye
  filas `is_hub`/CEDIS que agregan hijos), unidad canónica, sin traspasos/promo/pseudo-SKU. Patrón
  de oro contra el que se mide `reorder_policy` y `eff_daily`.
- `analytics.customer_sales_daily` (eje cliente, diferible).

### Sprints v2
| # | Entrega | UI | Estado |
|---|---|---|---|
| **HVT.1** | `sales_monthly` rollup + guard fechas + wire nightly | no | ✅ 2026-08-05 (prod, 603k filas) |
| **HVT.2** | `v_sales_demand_truth` (demanda money-anchored) | no | ✅ 2026-08-05 (prod, 37.5k filas) |
| **HVT.3** | **Investigación La Rosa**: units infladas 3.9×; money-anchored 299 cajas vs 36.9k | no | ✅ 2026-08-05 |
| **HVT.4** | `<sales-history-peek>` en el drill-down existente | mínima | ⬜ |
| HVT.5 | (difer.) eje cliente + peek inline en pedido | mínima | ⬜ |

### Hallazgo HVT.1 + cuantificación HVT.3 (2026-08-05)
**Las `units` de `sales_daily` NO son consistentes en el tiempo.** 70056 (MAZAPAN GIGANTE):
ene-2025 = 4,884 u / $416K ($85/u) → jul-2026 = 25,125 u / $314K ($12.5/u). El precio implícito
por unidad se desploma ~7× con quiebre ~oct-2025 (onboarding Wincaja): las units se inflan
mientras el **revenue se mantiene/baja**.

**Cuantificado (HVT.3, La Rosa 2026-Q2, 215 SKUs con ref estable 2025-Q1):**
units reportadas **1,466,367** vs implícitas-por-revenue **375,516** → **inflación 3.90×**
(por SKU 2.0–5.7×). Como `reorder_policy`/`eff_daily`/IAD se computan de units, quedaron
inflados ~4×. Descomposición del sobre-pedido 20-50×: ~4× units + ~2-3× metodología
(workbook=1 ciclo JIT vs nuestro=déficit-a-máx) + hub double-count + stock actual.

**System-wide:** el quiebre afecta a TODA métrica por units (no solo La Rosa); el revenue
quedó intacto. Corrección de fondo (HVT.2): demanda anclada a **revenue** (`v_sales_demand_truth`),
no a units. Verificar el alcance del quiebre en otras marcas antes de recalibrar reorder_policy.

---

## (v1 — plan original 2026-08-04, contexto; costura legacy DIFERIDA en v2)

---

## Objetivo

Una **fuente única de verdad de venta histórica**, consultable en dos modos:

- **A) Consola analítica** `/comercial/historico-venta` — análisis profundo, serie continua multi-año, drill.
- **B) Widget inline en toma de pedido** — al armar el pedido (televenta / vendedor / portal), ver *rápido* la historia del cliente y de cada producto para decidir qué empujar ("de forma óptima").

## Por qué (gap)

Ya existe superficie de venta histórica pero **dispersa y con topes distintos**:

| Superficie | Ruta | Grano / alcance |
|---|---|---|
| Sell-out | `/comercial/sell-out` | producto × sucursal × canal × día · margen · rolling **13 meses** (`analytics.sales_daily`) |
| Salidas | `/comercial/salidas` | unidades por producto, mes/rango (`product_sales_monthly` sin tope, `_daily` ~180d) |
| Ventas por ruta | `/comercial/ventas-por-ruta` | sucursal × ruta + drill a línea de ticket |
| Histórico legacy | `/comercial/historical` | historia profunda pre-sistema (FDW `ventas_legacy`, 2.1M líneas: zona/vendedor/cliente/folio) |
| Customers-360 / Wincaja / Vendor-sales / Command Center | varias | vistas específicas |

No hay **una sola consola** donde elijas eje (producto / cliente), rango de fechas y veas serie continua + drill, con la **costura** entre la ventana viva (13m) y la historia profunda resuelta. Y no hay consulta de histórico **dentro de la toma de pedido**.

---

## Arquitectura de datos (la costura)

```
                          SEAM_DATE
  ventas_legacy (FDW/mat.) ───┤──── analytics.sales_daily (13m vivo)   ← eje PRODUCTO
  ventas_legacy (tercero_id) ─┤──── analytics.customer_sales_daily      ← eje CLIENTE (feed NUEVO)
                              └── analytics.v_sales_history (vista UNION normalizada)
```

Tres puentes obligatorios:

1. **`SEAM_DATE`** — corte limpio: leer legacy `< SEAM_DATE`, `sales_daily >= SEAM_DATE`. Evita doble conteo en el traslape.
2. **Crosswalk de producto** — `producto_id` VARCHAR (legacy) ↔ `catalog.products.id` UUID (nuevo), reusando `catalog_aliases`.
3. **Eje cliente en la ventana viva** — `sales_daily` **no tiene cliente**. Hoy solo `analytics.customer_product_sales` (agregado rolling 90/180d). → **feed nuevo `analytics.customer_sales_daily`** (decidido).

Diferencias de forma a normalizar:

| | `analytics.sales_daily` (vivo) | `analytics_external.ventas_legacy` (FDW) |
|---|---|---|
| Ventana | rolling 13 meses | años previos (pre-sistema), 2.1M líneas |
| Grano | producto × almacén × **canal** × día (agregado) | **línea de ticket** (folio × producto) |
| Producto | `product_id` UUID | `producto_id` VARCHAR (código ERP) |
| Cliente | ❌ no existe | ✅ `tercero_id` + nombre |
| Extras | margin, tickets | zona, vendedor, folio, hora |

> **Todo `analytics.*` = SIN RLS** → filtro `tenant_id` explícito en cada query. `commercial.*` y `wincaja.*` son RLS-forzado.

---

## Fases

### Fase 0 — Verificación contra prod (BLOQUEANTE, read-only)
1. Rangos de fecha de `ventas_legacy` y `sales_daily` → fijar `SEAM_DATE` y medir traslape.
2. Cobertura del crosswalk `producto_id` legacy ↔ catálogo, y `tercero_id` ↔ `erp_customers.erp_code`.
3. **¿Railway prod alcanza el FDW `.245`?** La migración `20260601220000` era dev/staging. Si prod NO ve `.245` → **materializar** legacy a `analytics.sales_legacy_daily` vía feed on-prem (cambia Fase 1). **Este es el fork del plan.**

### Fase 1 — Capa de datos
- Migración `analytics.customer_sales_daily` (erp_customer × producto × día; sin RLS, GRANT `app_runtime`, tenant_id explícito).
- Importer `import-customer-sales-daily.js` desde `mart.ventas_enriched` (tiene `erp_customer_ref`). **UPSERT insert-only** (regla Railway egress). Ventana inicial acotada (p.ej. 24m) y crecer.
- Vista `analytics.v_legacy_product_map` (crosswalk legacy→UUID vía `catalog_aliases`).
- Vista `analytics.v_sales_history` (UNION legacy `< SEAM_DATE` + `sales_daily >= SEAM_DATE`, grano común).
- Wire en `run-prod-feeds.js` (nightly).

### Fase 2 — Backend (`libs/commercial/commercial-analytics`, patrón existente)
- `GET commercial/analytics/history/product/:id?from&to&granularity=day|month` — serie + drill almacén/canal.
- `GET .../history/customer/:code?from&to` — serie + top productos del cliente.
- `GET .../history/customer/:code/summary` — **endpoint ligero optimizado** para el widget inline (últimos N meses + top SKUs + última compra + tendencia; payload chico + cacheable).
- `GET .../history/search?q=` (autocompletar producto/cliente) + export `.xlsx` (reusar `sell-out-export.service.ts`).

### Fase 3 — Frontend
- **Consola** `/comercial/historico-venta`: selector eje Producto/Cliente + buscador + rango con presets (12m/24m/todo), gráfica serie + tabla maestro-detalle (Operations, `DESIGN.md`), banda visual que marca el `SEAM_DATE`. Gateada por `Permission.COMMERCIAL_*_VER`.
- **Widget inline compartido** `<sales-history-peek>` (standalone): consume `customer/:code/summary`, embebido en `televenta-take-order.component`, la app vendedor (Nx) y el carrito del portal — abre en side-peek sin salir del pedido.

### Fase 4 — Docs/tracker
- ADR de la costura (SEAM_DATE + crosswalk) + entry en `01_TRACKER_PROGRESO.md` / `03_LOG_REVISIONES.md`.

---

## Decisiones tomadas
- **Eje cliente**: feed nuevo `analytics.customer_sales_daily` (no solo agregado 90/180d).
- **UI**: **ambas** — consola nueva + consulta inline óptima en toma de pedido.

## Riesgos / notas
- **Fase 0.3 es el fork**: FDW-en-vivo vs materializar legacy. No escribir Fase 1 hasta resolverlo.
- Doble conteo en el traslape → `SEAM_DATE` debe ser corte limpio, no rango.
- El feed cliente es de grano fino → puede ser pesado; arrancar acotado.

---

## Superficies existentes a reusar (mapa)
- Fact canónico venta real: `analytics.sales_daily` (13m, con margen). Mensual sin tope: `analytics.product_sales_monthly`. Diario ~180d: `analytics.product_sales_daily`.
- Historia profunda pre-sistema: `analytics_external.ventas_legacy` (FDW `.245`), ya expuesta en `/comercial/historical`.
- Fuente de detalle por cliente (feed): `mart.ventas_enriched` on-prem (`erp_customer_ref`).
- Read-side a copiar: `commercial-analytics.service.ts` + `.controller.ts` (`@Controller('commercial/analytics')`).
- Toma de pedido: `televenta-take-order.component.ts` (vía `VendorService.catalogForCustomer`), portal (carrito), app vendedor (Nx, reusa `VendorService`).
