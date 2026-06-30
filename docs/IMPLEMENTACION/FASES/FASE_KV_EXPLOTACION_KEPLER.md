# Fase KV — Explotación de datos Kepler (ventas, márgenes, demanda, clientes)

> **Objetivo:** convertir la data transaccional de Kepler (ventas reales, costos, promos, clientes)
> en inteligencia comercial dentro de la plataforma, **sin tocar Trade Marketing ni auditoría de ruta**.
> Fuente decodificada en [`../KEPLER_CATALOGO_TABLAS.md`](../KEPLER_CATALOGO_TABLAS.md).
> Estado: 📝 **PLAN** (2026-06-30). Sin código.

---

## 0. Principios de arquitectura (aplican a TODOS los sprints)

| # | Principio | Por qué |
|---|---|---|
| A1 | **Railway NO alcanza la red Mega Dulces.** Todo feed corre **on-prem** y empuja a prod por el proxy público. | Memoria `reference_kepler_prod_deploy`. El módulo `kepler-consolidado` queda inerte en Railway (null-safe). |
| A2 | **Latencia a prod ≈ 1.2 s/query.** TODO write a prod es **bulk** (staging temp + merge server-side). | Per-fila = horas; bulk = <2 min. Patrón ya probado en `import-catalog-bulk.js`, `import-prices-bulk.js`, `import-branch-stock-live.js`. |
| A3 | **Solo aditivo.** Tablas nuevas en `analytics.*` + columnas nuevas en `catalog.products` / `commercial.customers`. **Nunca** DROP, nunca tocar `daily_captures`, `stores`, `zones`, `visits*`, `exhibiciones`, etc. | Restricción explícita del usuario. |
| A4 | Migraciones **idempotentes** (`hasTable`/`hasColumn`), con `tenant_id` + audit. snake_case inglés. TZ `America/Mexico_City`. | CLAUDE.md. |
| A5 | `analytics.*` usa **filtro `tenant_id` explícito** (RLS no aplica a MVs/feeds cross-tenant). El runner usa `KNEX_NEW_DB_ADMIN` (postgres) on-prem. | Memoria `feedback_tenant_knex_rls` + patrón Fase C. |
| A6 | El **importer es la única fuente de verdad** (single source of truth). El cron lo ejecuta como subprocess (patrón `mega_dulces_sync`). | Consistencia con `KeplerConsolidadoService`. |

**Fuente de datos:** `kepler_consolidado` (Docker `localhost:5433`) con `mart.ventas` (~2.1M filas, 6 sucursales). Las dimensiones (clientes/proveedores/promos) se leen directo de las sucursales (`md.kdud`, `md.kdpv_*`) vía el runner on-prem.

**Mapeo de claves:** `kdii.c1 == catalog.products.sku` (dentro del tenant `mega_dulces` = `00000000-0000-0000-0000-00000000d01c`). Warehouses prod: `01`=PH, `02`=La Piedad, `03`=8ESQ, `04`=Yurécuaro, `05`=Zamora, `00`=Cedis.

---

## 0bis. Deuda operacional previa (desbloquear antes de KV) — ✅ CERRADO 2026-06-30

Heredada de la sesión de sync de catálogo. **Prerrequisito de KV.1+.**

1. ✅ **Deploy de migración + código** `top_sellers_live` (`20260629120000`) + endpoint `listTopSellers` + módulo `kepler-consolidado` + exclusión MD-10 en `mega_dulces_sync`. Aplicado en prod (migración registrada, tabla creada).
2. ✅ **Bulk-ificar rotación** (`import-rotation-from-consolidado.js`: per-fila ~1.7 h → staging temp + `UPDATE FROM`).
3. ✅ **Bulk-ificar top-sellers** (`import-top-sellers-from-consolidado.js`: `INSERT` per-fila → multi-fila batches de 500).
4. ✅ **Runner on-prem** (`run-prod-feeds.js` orquestador: modos `stock`/`nightly`/`catalog`/`all`, guarda que exige prod en `--apply`) + runbook actualizado con `schtasks`.

**Poblado de prod (2026-06-30):** rotación 5028 SKUs (alta=1105/media=1556/baja=1698/dead=669) + top_sellers_live 975 best-sellers (top-1 ALTOS CAM CHICA $962k). 235/25 sin match catálogo respectivamente.

---

## Mapa de la fase

```
KV.0  Consolidación enriquecida (mart.ventas con canal + costo + cliente)   ← precondición de TODO
  │
KV.1  Fact de ventas real        → analytics.sales_daily
  ├─ KV.2  Participación / ABC    → analytics.product_sales_stats
  ├─ KV.4  Margen                 → catalog.products.margin_pct + en sales_daily
  └─ KV.5  Demanda / reabasto     → analytics.inventory_health
KV.3  Customer 360 real (3 sub)   → commercial.customers.erp_code + analytics.customer_product_sales
KV.6  Promos del ERP             → analytics.erp_promotions (señal Thot)
KV.7  Historial de precios (opt) → analytics.price_history
KV.8  Embarques (opt, logística) → analytics.erp_shipments
```

**Orden recomendado:** 0bis → KV.0 → KV.1 → KV.2 → KV.4 → KV.5 → KV.3.0 → KV.3.1 → KV.3.2 → KV.6 → KV.7/8.

---

## KV.0 — Consolidación enriquecida (precondición) — ✅ CERRADO 2026-06-30

Entregado como **vista `mart.ventas_enriched`** (aditiva, en el Docker `kepler_consolidado`, no toca tabla base ni `refresh_ventas`): añade `channel` (tienda/mayoreo/ruta/credito desde `forma_pago=kdm1.c10`) + `erp_customer_ref` (forma_pago ≠ CONTADO) + filtro de pseudo-productos (DEVOLUCIONES/TIEMPO AIRE). SQL en `database/importers/kepler/sql/mart_ventas_enriched.sql`. Validado 90d: tienda $49M (mostrador anónimo) / mayoreo $13.7M / crédito $6.4M. Costo NO incluido (se difiere a KV.4). Hallazgo: el canal "ruta" cae en "credito" (código numérico de cliente) — se afina en KV.3.

---

### Detalle de diseño (KV.0)

**Objetivo:** que `mart.ventas` (o una vista `mart.ventas_enriched`) tenga todas las dimensiones que KV.1+ necesitan. Hoy es probable que tenga fecha/sucursal/sku/cantidad/importe pero **falten canal, costo y cliente**.

### Tareas
1. **Verificar** el schema actual de `mart.ventas` (Docker arriba): ¿tiene `forma_pago`, `costo`, `cliente`?
2. **Canal** (`channel`): derivar de `kdm1.c10` (forma_pago):
   - `CONTADO` → `tienda` (mostrador).
   - `TI00x` → `mayoreo` / `cedis`.
   - código de ruta (`R1`…`R30`, vía `md.kdm_rutas`) → `ruta`.
3. **Costo**: traer de `md.kdij` (`c22`=costo por línea de movimiento) o `md.kdik` (costo unitario `c9/c6`). Preferir `kdij` (costo al momento de la venta, no el actual).
4. **Cliente**: traer el código de cliente del encabezado (`kdm1`/`kdue.c2`) → `erp_customer_code`.
5. **Devoluciones**: las ventas tienen `naturaleza='D'` (cargo). Las devoluciones (`Rtrn1`, `naturaleza='C'`) deben restar → unidades/importe **negativos** en el fact, no filas separadas perdidas.

### Salida
`mart.ventas` con columnas: `sucursal, sku, fecha, channel, qty, revenue, cost, erp_customer_code`. Si extender la tabla es caro, una **vista** `mart.ventas_enriched` que una `kdm1⋈kdm2⋈kdij` con estas derivaciones.

### Riesgos
- `forma_pago` con valores no mapeados → canal `otro` (loguear distintos para no perder ventas).
- Costo nulo en líneas viejas → margen nulo (no romper, dejar `NULL`).

### Verificación
`SELECT channel, sum(revenue) FROM mart.ventas GROUP BY 1` cuadra con totales por canal conocidos. Devoluciones restan.

---

## KV.1 — Fact de ventas real → `analytics.sales_daily` — ✅ CERRADO (datos) 2026-06-30

**En prod:** migración `20260630120000_analytics_sales_daily` + fix `20260630130000_sales_daily_cost_nullable`. Importer `import-sales-fact.js` (bulk, ventana 13m, DELETE+INSERT agrupado). Cron `salesFactFeed` @04:45. **422,489 filas** de revenue/units/tickets reales (tienda $113M / crédito $14.9M / mayoreo $13.5M). `cost`/`margin` = **NULL** (cost_base tiene unidad inconsistente pieza/caja → margen se computa en KV.4 con `kdpv_prod_util`). Anomalía menor: data arranca oct-2025 (no may-2025) — sku-match limita la ventana; revisar si se quiere histórico más largo.

**CONSUMO ✅ (parcial) 2026-06-30:** `commercial-analytics` re-apuntado a venta real:
- `historical/daily`, `historical/top-products`, `historical/by-zona` → ahora leen `analytics.sales_daily` (antes FDW `analytics_external` MUERTO en Railway → devolvían `[]`). revenue/units **exactos**; `tickets`/`lines` = proxy (grano-producto no aditivo), `cost/margin=0` y `unique_customers=0` hasta KV.4/KV.3. Build verde. Solo código (sin migración).
- **Pendiente:** `historical/ranking` (→ `product_sales_stats`, shape cajas/piezas difiere) + `historical/margin-by-category` (→ KV.4, necesita costo) siguen en el FDW muerto.

### Detalle de diseño (KV.1)

**Objetivo:** el hecho de venta real (no nuestros pedidos) como base de todo el reporting. Hoy las MVs de Fase C leen `commercial.orders` (casi vacío en beta) → migrarlas a venta real.

### Grano y volumen
- **Grano:** `product × warehouse × channel × día`.
- **Ventana en prod:** rolling **13 meses** (charts + comparativo YoY). El detalle completo histórico vive on-prem en `kepler_consolidado`; a Railway solo la ventana.
- **Volumen estimado:** ≤ nº de líneas distintas agregadas; ~2.1M líneas totales → rollup diario acotado ~0.5–1M filas. Aceptable con índices.

### DDL (migración aditiva idempotente)
```sql
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE TABLE IF NOT EXISTS analytics.sales_daily (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  product_id   uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  channel      text NOT NULL,            -- tienda | mayoreo | ruta | cedis | otro
  sale_date    date NOT NULL,
  units        numeric NOT NULL DEFAULT 0,
  revenue      numeric NOT NULL DEFAULT 0,
  cost         numeric NOT NULL DEFAULT 0,
  margin       numeric GENERATED ALWAYS AS (revenue - cost) STORED,
  tickets      integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- idempotente: CREATE UNIQUE INDEX IF NOT EXISTS
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_daily
  ON analytics.sales_daily (tenant_id, product_id, warehouse_id, channel, sale_date);
CREATE INDEX IF NOT EXISTS ix_sales_daily_date  ON analytics.sales_daily (tenant_id, sale_date);
CREATE INDEX IF NOT EXISTS ix_sales_daily_prod  ON analytics.sales_daily (tenant_id, product_id);
```
> `margin` GENERATED → no se escribe (memoria `feedback_activo_generated_pattern`).

### Importer bulk `database/importers/kepler/import-sales-fact.js`
1. Lee `mart.ventas_enriched` agregado: `GROUP BY sucursal, sku, channel, día → sum(qty), sum(revenue), sum(cost), count(distinct folio)`, limitado a `fecha >= now()-13 months`.
2. Resuelve `sku→product_id` y `código sucursal→warehouse_id` en memoria (lookups, como `import-branch-stock-live.js`).
3. Carga staging temp en batches de 1000.
4. Merge server-side: **borra la ventana** (`DELETE WHERE sale_date >= X`) + `INSERT` desde staging (refresco full de la ventana = idempotente y simple). Alternativa upsert si la ventana es muy grande.
5. Dry-run default / `--apply`.

### Cron
`KeplerConsolidadoService.salesFactFeed()` `@Cron('0 30 4 * * *')` (04:30, tras rotación/top-sellers). Subprocess del importer.

### Endpoints / consumo
- Extender `commercial-analytics` (Fase C) para leer de `analytics.sales_daily` como **fuente por default** (param `?source=orders` para volver a pedidos propios).
- Command Center: revenue/AOV/top-products/sales-by-brand pasan a **venta real**.

### Riesgos / gotchas
- **SKUs sin match** (`product_id` no resuelto) → contar y loguear; no perder silenciosamente.
- **Doble conteo** si una venta está en `mart.ventas` y también en otra fuente → usar SOLO `mart.ventas`.
- **Canal `otro`** si `forma_pago` no mapea → revisar distintos.
- TZ: agrupar por día en `America/Mexico_City`.

### Verificación
- `sum(revenue)` de un día en `analytics.sales_daily` == total Kepler de ese día (±redondeo).
- Aislamiento: tenant 2 ve 0.
- Smoke en `database/` (patrón `http-e2e`).

---

## KV.2 — Participación / ABC → `analytics.product_sales_stats` — ✅ CERRADO 2026-06-30

**En prod:** migración `20260630140000` + importer `import-sales-stats.js` (server-side desde sales_daily, sin ship de filas) + cron `statsFeed` @04:50 + en runner nightly. **4993 productos**, ABC Pareto exacto: **A 944 / B 1302 / C 2747** = share 80/15/5. Top: ALTOS CAM CHICA 1.1%.

### Detalle de diseño (KV.2)

**Objetivo:** share % por marca/categoría/SKU y clasificación ABC sobre **venta real** (barato, se computa de KV.1).

### DDL
```sql
CREATE TABLE IF NOT EXISTS analytics.product_sales_stats (
  tenant_id     uuid NOT NULL,
  product_id    uuid NOT NULL,
  units_30d     numeric DEFAULT 0, revenue_30d numeric DEFAULT 0, margin_30d numeric DEFAULT 0,
  units_90d     numeric DEFAULT 0, revenue_90d numeric DEFAULT 0,
  units_365d    numeric DEFAULT 0, revenue_365d numeric DEFAULT 0,
  abc_class     char(1),             -- A/B/C por revenue acumulado (Pareto)
  revenue_share_pct numeric,         -- % del total del tenant
  computed_at   timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id)
);
```
### Importer
`import-sales-stats.js`: computa todo **server-side** desde `analytics.sales_daily` (un solo `INSERT ... SELECT ... ON CONFLICT DO UPDATE`). ABC = Pareto por `revenue_365d` (acumulado ≤80% A, ≤95% B, resto C). Cero round-trips por fila.

### Consumo
- Command Center `sales-by-brand` (ya existe, hoy sobre pedidos) → join a `product_sales_stats` + `catalog.brands`.
- Endpoint nuevo `GET /commercial/analytics/abc`.
- **Thot**: señal de rotación deja de depender solo de `sales_units_30d` → usa share + ABC real.

### Verificación
`sum(revenue_share_pct)` ≈ 100. Top-A coincide con top-sellers.

---

## KV.4 — Margen → `catalog.products.margin_pct` + en `sales_daily`

**Objetivo:** margen real como señal (Thot multi-señal margen) y en analítica.

### Tareas
1. Migración aditiva: `ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS margin_pct numeric` (+ opcional `cost_updated_at`).
2. Importer bulk `import-margin.js`:
   - Fuente A: `md.kdpv_prod_util` (`c1`=sku, `c6`=margen% por nivel de precio) → margen configurado.
   - Fuente B (cross-check): `(precio_lista - costo) / precio_lista` desde `commercial.product_prices` + `catalog.products.cost_base`.
   - Staging + `UPDATE catalog.products SET margin_pct=... FROM stg`.
3. KV.1 ya trae `cost` → `margin` por venta en `sales_daily`.

### Consumo
- Thot: peso de margen (heurístico existente acepta señales nuevas).
- Command Center: mix de margen por marca (margin_30d de KV.2).

### Riesgos
- `kdpv_prod_util` tiene varios niveles por SKU → elegir el nivel canónico (P1 público) o promediar. Decidir explícito.
- `tax_rate=0.16` ¿el costo incluye IVA? (pendiente histórico) → validar contra 2-3 anclas.

---

## KV.5 — Demanda / reabasto → `analytics.inventory_health`

**Objetivo:** cruzar stock vivo (ya en prod) × velocidad de venta (KV.1) = días de cobertura, punto de reorden, dead-stock **real** (no umbral fijo).

### DDL
```sql
CREATE TABLE IF NOT EXISTS analytics.inventory_health (
  tenant_id      uuid NOT NULL,
  product_id     uuid NOT NULL,
  warehouse_id   uuid NOT NULL,
  on_hand        numeric DEFAULT 0,
  avg_daily_units numeric DEFAULT 0,   -- venta 90d / 90
  days_cover     numeric,              -- on_hand / avg_daily_units
  status         text,                 -- agotado | critico | sano | sobrestock | muerto
  computed_at    timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id, warehouse_id)
);
```
### Importer
`import-inventory-health.js`: server-side join `commercial.stock` × `analytics.sales_daily` (90d por warehouse). `status`:
- `agotado` on_hand=0; `critico` days_cover<7; `sano` 7..60; `sobrestock` >60 con venta; `muerto` venta_90d=0 y on_hand>0.

### Consumo
- `/comercial/inventory`: columna días de cobertura + filtro por status.
- **Alertas low-stock** (`AlertsScannerService`) pasan de umbral fijo → demanda real (días de cobertura).
- Reporte dead-stock (memoria: 503 SKUs / $567k parados en una sucursal).

### Riesgos
- Productos nuevos sin historial → `avg_daily_units=0` → no marcar `muerto` si `created_at` reciente.

---

## KV.3 — Customer 360 real (el track más delicado)

**Realidad verificada (2026-06-30):**
- **Prod** tiene **85 clientes** con código `V-XXXX` (capturados por la app del vendedor), **sin RFC ni link a Kepler**. `mega_dulces_sync` **no** sincroniza clientes.
- **Kepler** tiene el maestro de clientes en **`md.kdud`** (`c2`=código, `c3`=nombre, `c4`=dirección, `c5`=colonia, `c6`=ciudad, `c10`=RFC, `c27`=CP). ~818 por sucursal (dedup entre sucursales pendiente).
- Las ventas de `mart.ventas` referencian el **código de cliente Kepler**, no el `V-XXXX`.

→ El reto = **reconciliación**: atar la venta Kepler a un cliente, y opcionalmente a los `V-XXXX` del vendedor.

### KV.3.0 — Maestro de clientes Kepler + reconciliación
1. Migración aditiva: `ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS erp_code varchar` + índice parcial único `(tenant_id, erp_code) WHERE erp_code IS NOT NULL`.
2. Importer `import-erp-customers.js`:
   - Lee `md.kdud` de las 6 sucursales, **dedup por RFC/código** (un cliente compra en varias sucursales).
   - **Estrategia de match contra `commercial.customers`:**
     - a) por RFC exacto (cuando ambos lo tengan);
     - b) por nombre normalizado (upper+trim, fuzzy) → marcar `erp_code` en el `V-XXXX` existente;
     - c) sin match → **INSERT** cliente nuevo con `erp_code`, `code` derivado, `source='kepler'`.
   - Bulk staging + merge. Dry-run reporta a/b/c counts antes de aplicar.
3. **Decisión a tomar:** ¿clientes Kepler como registros canónicos nuevos, o solo enriquecer los `V-XXXX`? Recomendado: importar Kepler como base canónica (es el universo real de compradores) y reconciliar los `V-XXXX` por nombre.

### KV.3.1 — Historial de compra por cliente → `analytics.customer_product_sales`
```sql
CREATE TABLE IF NOT EXISTS analytics.customer_product_sales (
  tenant_id     uuid NOT NULL,
  customer_id   uuid NOT NULL,
  product_id    uuid NOT NULL,
  units_90d     numeric DEFAULT 0, revenue_90d numeric DEFAULT 0,
  units_180d    numeric DEFAULT 0,
  last_purchase_date date,
  computed_at   timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, customer_id, product_id)
);
```
- Importer: `mart.ventas_enriched` por `(erp_customer_code→customer_id, sku→product_id)`. **CONTADO anónimo se excluye** (no hay cliente). Bulk.

### KV.3.2 — Consumo
- **Vendedor** (`/vendor`): "qué compró antes este cliente" → sugerido (reemplaza/mejora heurística actual).
- **Televenta** (`/televenta`): snapshot de compras al abrir el lead.
- **Portal B2B** (`/portal`): historial real del cliente (hoy solo ve sus pedidos en la plataforma).
- **Thot**: señal de afinidad cliente-producto.

### Riesgos
- Match por nombre ambiguo ("Abarrotes Mary" x N) → umbral conservador + revisión manual de los dudosos; dejar sin atar antes que atar mal.
- PII (nombre/RFC/dirección) → tenant-scoped, no exponer cross-tenant.
- CONTADO = ~mayoría de tickets de tienda sin cliente → el 360 cubre ruta/mayoreo, no mostrador. Documentar el alcance.

---

## KV.6 — Promos del ERP → `analytics.erp_promotions`

**Objetivo:** las reglas de promo reales de Kepler (`kdpv_descuxq`/`gratisxq`/`descuxm`/`gratisxm`) como señal.

- DDL `analytics.erp_promotions` (tenant, product_id, type `descuento_qty|gratis_qty|descuento_monto|gratis_monto`, min_qty/min_amount, benefit, free_product_id, valid_from, valid_to, warehouse).
- Importer bulk desde las 4 tablas `kdpv_*`. Solo vigentes (`valid_to >= today`).
- **Consumo:** Thot ya tiene "promo activa como señal de empuje" (sprint CV.5) — hoy mira `commercial.orders.service`; enriquecer con promos reales del ERP. Opcional: mostrar en portal/vendedor.

---

## KV.7 — Historial de precios (opcional) → `analytics.price_history`

- Fuente `md.kdpv_bitacora_precios` (1.4M: fecha/hora/sku/precio_ant/precio_nuevo/delta/usuario).
- Uso: inteligencia de precio, detección de cambios bruscos, auditoría. Bajo ROI inmediato → diferible.

## KV.8 — Embarques (opcional, logística) → `analytics.erp_shipments`

- Fuente `md.kdpord` (folio `PD-…`, sku, cantidad, ruta `c22`, estado `c35`=EMBARCADO).
- Uso: espejo read-only de embarques del ERP en Logística (aditivo, NO toca auditoría de ruta). Logística ya tiene su propio módulo → evaluar solapamiento antes.

---

## Resumen de entregables por sprint

| Sprint | Migración (aditiva) | Importer bulk | Cron | Consumo |
|---|---|---|---|---|
| KV.0 | — (vistas en `kepler_consolidado`) | — | — | precondición |
| KV.1 | `analytics.sales_daily` | `import-sales-fact.js` | `salesFactFeed` 04:30 | command-center, Thot |
| KV.2 | `analytics.product_sales_stats` | `import-sales-stats.js` | tras KV.1 | ABC, share, Thot |
| KV.4 | `catalog.products.margin_pct` | `import-margin.js` | nightly | Thot, mix margen |
| KV.5 | `analytics.inventory_health` | `import-inventory-health.js` | nightly | inventory, alertas |
| KV.3.0 | `commercial.customers.erp_code` | `import-erp-customers.js` | manual+nightly | base de KV.3.1 |
| KV.3.1 | `analytics.customer_product_sales` | `import-customer-sales.js` | nightly | vendor, televenta, portal, Thot |
| KV.6 | `analytics.erp_promotions` | `import-erp-promos.js` | nightly | Thot, portal |
| KV.7 | `analytics.price_history` | `import-price-history.js` | semanal | inteligencia precio |
| KV.8 | `analytics.erp_shipments` | `import-erp-shipments.js` | 30 min | logística |

## Esfuerzo estimado (orientativo)

| Sprint | Esfuerzo | Riesgo |
|---|---|---|
| 0bis (deuda) | Bajo | Bajo (deploy + bulk-ify) |
| KV.0 | Medio | Medio (decode canal/costo en consolidación) |
| KV.1 | Medio | Medio (grano, devoluciones, sku match) |
| KV.2 | Bajo | Bajo |
| KV.4 | Bajo | Medio (nivel de margen, IVA en costo) |
| KV.5 | Bajo-Medio | Bajo |
| KV.3.0 | **Alto** | **Alto** (reconciliación de clientes) |
| KV.3.1 | Medio | Medio |
| KV.6 | Bajo | Bajo |
| KV.7 / KV.8 | Bajo | Bajo (diferibles) |

## Decisiones pendientes (requieren confirmación)

1. **Ventana de prod** para `sales_daily`: 13 meses ¿suficiente? (vs todo el histórico).
2. **KV.3**: ¿importar clientes Kepler como canónicos o solo enriquecer los `V-XXXX`?
3. **Margen** (KV.4): ¿nivel de precio canónico para `margin_pct` (P1 público)?
4. **Costo + IVA**: confirmar si `cost_base`/`kdik` incluye IVA antes de calcular márgenes.
5. **KV.8 embarques**: ¿solapa con el módulo de Logística existente?
