# Fase HVT — Histórico de Venta (consola multi-año + consulta inline al pedir)

> Estado: **🔨 DISEÑADO (planeación)** · 2026-08-04 · single dev (Edgar)
> Ejes decididos: **Producto/SKU + Cliente/tercero**. Profundidad: **historia profunda multi-año**.

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
