# Esquema de la Base de Datos de PRODUCCIÓN — snapshot

> **Generado**: 2026-09-11 · introspección **read-only** (catálogos `pg_catalog`) contra prod.
> No editar a mano para "corregir el esquema": es una FOTO. Para cambiar el esquema, migración en `database/migrations-newdb/`.
> Companion machine-readable: [`esquema-bd-prod-columnas.csv`](esquema-bd-prod-columnas.csv) (todas las columnas de todos los schemas).

## 0. Identidad del servidor

| | |
|---|---|
| Host | `trolley.proxy.rlwy.net:39023/railway` (Railway, prod) — vía `FLEET_DB_URL` |
| Motor | PostgreSQL 18.6 (Debian 18.6-1.pgdg13+2) |
| Tamaño total | **30 GB** (32,459,855,551 bytes) |
| Migraciones | **`public.knex_migrations` = 692 filas / batch 393** (última: 2026-09-11). `identity.knex_migrations` existe pero VACÍA (no usar). |
| Tenants con dato | **1**: `mega_dulces` (UUID `…d01c`). Los 3 tenants de prueba de la auditoría anterior ya NO están. |
| Roles login | `app_runtime` (no super, no bypassrls) · `postgres` (**super + bypassrls** — el pool legacy corre como éste → RLS no aplica). Sólo 2. |
| Extensiones | `cube`, `earthdistance`, `pg_trgm`, `pgcrypto`, `plpgsql`, `postgres_fdw`, `unaccent`, `vector` |
| FDW | `postgres_fdw` instalado pero **0 servidores / 0 foreign tables** — no hay FDW activo. |

**Totales**: 20 schemas con objetos · 623 tablas · 313 vistas · 12 matviews · 15936 columnas · 1632 índices · 534 FKs · 277 funciones · 90 triggers.

## 1. Mapa de schemas (por tamaño)

| Schema | Tablas | Vistas | MV | Tamaño | RLS forzado | `tenant_id` | FKs | Índices |
|---|--:|--:|--:|--:|:--|:--|--:|--:|
| `analytics` | 66 | 48 | 11 | 14 GB | 1/66 | 66/66 | 54 | 237 |
| `kepler_ods` | 236 | 0 | 0 | 9219 MB | 0/236 | 0/236 | 0 | 247 |
| `wincaja` | 29 | 10 | 1 | 4321 MB | 29/29 | 29/29 | 0 | 51 |
| `commercial` | 117 | 0 | 0 | 918 MB | 115/117 | 117/117 | 214 | 449 |
| `fiscal` | 16 | 0 | 0 | 512 MB | 13/16 | 13/16 | 2 | 47 |
| `finance` | 39 | 3 | 0 | 290 MB | 39/39 | 39/39 | 21 | 130 |
| `logistics` | 33 | 0 | 0 | 235 MB | 32/33 | 33/33 | 81 | 156 |
| `catalog` | 7 | 1 | 0 | 69 MB | 5/7 | 7/7 | 21 | 40 |
| `intelligence` | 4 | 0 | 0 | 41 MB | 4/4 | 4/4 | 0 | 12 |
| `public` | 5 | 23 | 0 | 29 MB | 0/5 | 3/5 | 0 | 12 |
| `trade` | 18 | 0 | 0 | 12 MB | 17/18 | 17/18 | 85 | 83 |
| `reconciliation` | 5 | 0 | 0 | 11 MB | 5/5 | 5/5 | 4 | 20 |
| `inventory` | 4 | 0 | 0 | 9144 kB | 2/4 | 2/4 | 4 | 15 |
| `identity` | 18 | 2 | 0 | 3808 kB | 11/18 | 13/18 | 35 | 57 |
| `whatsapp` | 9 | 0 | 0 | 488 kB | 8/9 | 9/9 | 2 | 26 |
| `pgboss` | 10 | 0 | 0 | 448 kB | 0/10 | 0/10 | 5 | 26 |
| `hr` | 5 | 1 | 0 | 208 kB | 5/5 | 5/5 | 4 | 21 |
| `erp` | 1 | 0 | 0 | 56 kB | 1/1 | 1/1 | 2 | 3 |
| `md` | 0 | 225 | 0 | 0 bytes | 0/0 | 0/0 | 0 | 0 |
| `analytics_external` | 0 | 0 | 0 | 0 bytes | 0/0 | 0/0 | 0 | 0 |

### Lecturas transversales

- **Dos linajes del mismo hecho de venta conviven en `analytics`** (imperativo por importer vs declarativo por matview/vista). Es el hallazgo central de la auditoría de datos; ver `docs/ARQUITECTURA_DATOS.md` y ADR-059/VERDAD_ABSOLUTA.
- **RLS es fuerte en los dominios de negocio nuevos** (`commercial` 115/117, `finance` 39/39, `logistics` 32/33, `wincaja` 29/29) y **ausente en `analytics`** (1/66) — donde justamente viven los números de dinero. El aislamiento de `analytics` depende del `WHERE tenant_id` manual de cada query, sobre un pool que además corre como superuser (`postgres`, bypassrls).
- **`kepler_ods` (236 tablas, 9.2 GB) y `md` (225 vistas) son el ERP**: sin tenant, sin RLS, un solo negocio. `md.*` = shim de sólo lectura sobre `kepler_ods.*`.
- **`public` es el producto legacy v1** todavía en pie, y además hospeda el ledger real de migraciones.

## 2. Top 30 relaciones por tamaño

| Relación | Tipo | Filas (est.) | Tamaño |
|---|---|--:|--:|
| `analytics.sales_daily` | table | 4,525,667 | 3760 MB |
| `analytics.mv_wincaja_sales_daily` | matview | 4,041,568 | 2743 MB |
| `wincaja.detalles_mov_almacen` | table | 9,994,628 | 2249 MB |
| `kepler_ods.kdm2` | table | 3,943,245 | 2199 MB |
| `analytics.stock_movements` | table | 3,706,283 | 1954 MB |
| `kepler_ods.kdmx_26` | table | 1,474,929 | 1661 MB |
| `kepler_ods.kdpv_bitacora_precios` | table | 5,274,885 | 1529 MB |
| `analytics.mv_sales_blended` | matview | 4,487,369 | 1473 MB |
| `analytics.product_sales_daily` | table | 2,572,785 | 1296 MB |
| `kepler_ods.kdmx_25` | table | 753,546 | 918 MB |
| `analytics.sales_boxes_monthly` | table | 1,082,018 | 689 MB |
| `wincaja.precios` | table | 2,234,773 | 639 MB |
| `kepler_ods.orglogtbl_26` | table | 2,839,030 | 637 MB |
| `kepler_ods.kdij` | table | 1,648,899 | 546 MB |
| `kepler_ods.kdm1` | table | 603,362 | 516 MB |
| `commercial.stock` | table | 155,041 | 478 MB |
| `wincaja.maestro_mov_almacen` | table | 1,499,801 | 457 MB |
| `analytics.mv_sellout_monthly` | matview | 808,865 | 395 MB |
| `fiscal.cfdis` | table | 173,191 | 325 MB |
| `analytics.sales_by_vendor_monthly` | table | 659,316 | 297 MB |
| `analytics.gl_poliza_lines` | table | 496,941 | 296 MB |
| `wincaja.movimiento_clientes` | table | 663,053 | 283 MB |
| `wincaja.pagos_dia` | table | 794,218 | 261 MB |
| `analytics.mv_kepler_sales_daily` | matview | 716,732 | 248 MB |
| `analytics.sales_monthly` | table | 660,177 | 242 MB |
| `commercial.stock_lots` | table | 89,988 | 242 MB |
| `analytics.store_live_tickets` | table | 203,825 | 229 MB |
| `logistics.vehicle_positions` | table | 404,092 | 215 MB |
| `fiscal.sat_list_rfcs` | table | 536,066 | 186 MB |
| `kepler_ods.orglogtbl_25` | table | 819,309 | 183 MB |

## 3. Detalle por schema

### `analytics`

Feature store + espejo "cocido" del ERP y agregados. Vive el linaje IMPERATIVO (tablas por importer, `run-prod-feeds`) Y el DECLARATIVO (matviews + vistas `v_*`/`erp_*` derive-no-copy sobre `kepler_ods`). Aquí viven los números de dinero. **59/66 tablas SIN RLS** — aislamiento por filtro manual, no por motor.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `sales_daily` | 4,525,667 | 3760 MB | — | ✅ | 17 |  |
| `stock_movements` | 3,706,283 | 1954 MB | — | ✅ | 25 |  |
| `product_sales_daily` | 2,572,785 | 1296 MB | — | ✅ | 7 |  |
| `sales_boxes_monthly` | 1,082,018 | 689 MB | — | ✅ | 14 |  |
| `sales_by_vendor_monthly` | 659,316 | 297 MB | — | ✅ | 13 |  |
| `gl_poliza_lines` | 496,941 | 296 MB | — | ✅ | 22 |  |
| `sales_monthly` | 660,177 | 242 MB | — | ✅ | 11 |  |
| `store_live_tickets` | 203,825 | 229 MB | — | ✅ | 14 |  |
| `product_sales_monthly` | 250,244 | 92 MB | — | ✅ | 7 |  |
| `contpaqi_bank_movements` | 205,877 | 91 MB | — | ✅ | 18 |  |
| `master_data_history` | 136,807 | 87 MB | — | ✅ | 9 | VP.3.1 (ADR-056) — log de cambios de datos maestros (precio, costo, reorden, eti |
| `contpaqi_ledger_monthly` | 91,481 | 74 MB | — | ✅ | 15 |  |
| `replenishment_plan` | 50,415 | 60 MB | — | ✅ | 35 |  |
| `route_push_lines` | 172,581 | 58 MB | — | ✅ | 12 |  |
| `caja_depositos` | 217,845 | 54 MB | — | ✅ | 20 |  |
| `gl_polizas` | 111,717 | 53 MB | — | ✅ | 19 |  |
| `erp_goods_receipt_dedup` | 4,565 | 50 MB | — | ✅ | 18 | Pares de la MISMA recepción capturada dos veces (RE.12 + RE.14): copia de oficin |
| `expense_document_lines` | 87,312 | 40 MB | — | ✅ | 14 |  |
| `bank_postings_snapshot_bak` | 45,339 | 31 MB | — | ✅ | 14 |  |
| `expense_entries` | 31,580 | 26 MB | — | ✅ | 24 |  |
| `inventory_health` | 70,018 | 23 MB | — | ✅ | 11 |  |
| `kepler_bank_movements_snapshot_bak` | 56,454 | 23 MB | — | ✅ | 22 |  |
| `caja_arqueos` | 29,634 | 17 MB | — | ✅ | 22 |  |
| `customer_product_sales` | 86,850 | 17 MB | — | ✅ | 9 |  |
| `product_demand` | 23,139 | 17 MB | — | ✅ | 11 |  |
| `stock_ledger` | 25,939 | 15 MB | — | ✅ | 18 |  |
| `caja_ventas_diarias` | 38,628 | 13 MB | — | ✅ | 26 |  |
| `cron_run_log` | 29,636 | 11 MB | — | ✅ | 12 | VP.3.3 (ADR-056) — historia de corridas TERMINADAS de feeds/crons. La escribe el |
| `product_sales_stats` | 10,895 | 8856 kB | — | ✅ | 11 |  |
| `caja_general_movimientos` | 10,608 | 6952 kB | — | ✅ | 22 |  |
| `expense_doc_chain` | 12,875 | 6344 kB | — | ✅ | 17 |  |
| `pos_ticket_sales` | 7,043 | 5632 kB | — | ✅ | 11 |  |
| `purchase_velocity` | 7,562 | 4584 kB | — | ✅ | 9 |  |
| `expense_doc_accounting` | 18,377 | 3656 kB | — | ✅ | 7 | Agregado contable por documento (costo 511/6xx + IVA 122x, lado cargo) desde kep |
| `contpaqi_suppliers` | 4,464 | 3168 kB | — | ✅ | 8 |  |
| `expense_findings` | 5,591 | 2920 kB | — | ✅ | 13 |  |
| `cash_cuts` | 2,129 | 2832 kB | — | ✅ | 36 |  |
| `demand_acceleration` | 6,543 | 2656 kB | — | ✅ | 19 | RA-PRO.36 — IAD por SKU (−2..+2) para la matriz de compra. Welch-Z 30v30 + estac |
| `cash_sessions` | 1,651 | 2064 kB | — | ✅ | 16 |  |
| `sales_by_channel_monthly` | 2,045 | 1688 kB | — | ✅ | 11 |  |
| `product_box_price` | 7,903 | 1448 kB | — | ✅ | 5 |  |
| `ledger_monthly` | 2,734 | 1312 kB | — | ✅ | 14 |  |
| `route_cost_snapshot` | 2,446 | 1184 kB | — | ✅ | 12 | RD.3 — congela el costo de la venta en ruta, que hoy NO es estable: el importer  |
| `db_health_alerts` | 839 | 1096 kB | ✅ | ✅ | 18 |  |
| `erp_purchase_adjustments` | 1,354 | 1048 kB | — | ✅ | 18 |  |
| `purchase_in_transit` | 1,932 | 1008 kB | — | ✅ | 6 |  |
| `cron_runs` | 73 | 1000 kB | — | ✅ | 12 | Heartbeat de ejecución de crons/feeds (Salud BD grupo Crons). |
| `ods_branch_checks` | 24 | 720 kB | — | ✅ | 7 | OBS.3.2 — prueba de que el carril REVISO cada sucursal (distinto de haberle empu |
| `pos_cashiers` | 1,092 | 592 kB | — | ✅ | 9 |  |
| `ap_provider` | 850 | 584 kB | — | ✅ | 12 |  |
| `product_box_factor` | 2,058 | 408 kB | — | ✅ | 5 |  |
| `transfers_monthly` | 861 | 376 kB | — | ✅ | 10 |  |
| `period_close` | 28 | 344 kB | — | ✅ | 13 | VP.4.1 (ADR-056) — cifra OFICIAL congelada de un mes por superficie. Un mes cerr |
| `transfer_dest_map` | 423 | 264 kB | — | ✅ | 5 |  |
| `sales_by_route_monthly` | 306 | 224 kB | — | ✅ | 10 |  |
| `declared_gaps` | n/d | 80 kB | — | ✅ | 15 | R.0: los huecos declarados de VERDAD_ABSOLUTA 7, pero con condicion de caducidad |
| `vendor_identity` | n/d | 80 kB | — | ✅ | 9 |  |
| `route_monthly_provenance` | 32 | 72 kB | — | ✅ | 14 | VP/ADR-056: procedencia declarada del gold sales_by_route_monthly (push vs branc |
| `wincaja_product_box_factor` | 187 | 72 kB | — | ✅ | 4 |  |
| `caja_general_cuentas` | 122 | 64 kB | — | ✅ | 10 |  |
| `oc_survival_curve` | 8 | 64 kB | — | ✅ | 6 | RA-PRO.45 — P(la OC llega \| seguía abierta al día edad). La escribe import-repl |
| `cedis_supply_cadence` | n/d | 48 kB | — | ✅ | 13 |  |
| `customer_receivable_snapshots` | n/d | 48 kB | — | ✅ | 12 |  |
| `caja_bancos_catalog` | n/d | 32 kB | — | ✅ | 9 |  |
| `caja_sucursales_catalog` | 63 | 32 kB | — | ✅ | 8 |  |
| `feed_watermarks` | n/d | 32 kB | — | ✅ | 10 |  |

**Matviews**: `bank_postings` (47,075 filas, 11 MB) · `mv_kepler_sales_daily` (716,732 filas, 248 MB) · `mv_kepler_sold_rung` (20,851 filas, 2472 kB) · `mv_product_momentum` (5,933 filas, 1768 kB) · `mv_sales_blended` (4,487,369 filas, 1473 MB) · `mv_sales_current_month` (25,743 filas, 7304 kB) · `mv_sales_overview_30d` (1 filas, 56 kB) · `mv_sellout_monthly` (808,865 filas, 395 MB) · `mv_top_customers_30d` (1 filas, 40 kB) · `mv_top_products_30d` (1 filas, 24 kB) · `mv_wincaja_sales_daily` (4,041,568 filas, 2743 MB)

**Vistas**: `customer_receivables`, `erp_collections`, `erp_customers`, `erp_goods_receipt_lines`, `erp_goods_receipts`, `erp_promotions`, `erp_purchase_adjustment_lines`, `erp_purchase_doc_lines`, `erp_purchase_docs`, `erp_purchase_orders`, `erp_receivable_documents`, `erp_sales_invoice_lines`, `erp_sales_invoices`, `erp_shipment_billing`, `erp_shipments`, `erp_supplier_payments`, `expense_documents`, `expense_requests`, `kepler_bank_movements`, `product_units`, `product_volume_tiers`, `v_abc_class`, `v_erp_sales_line_units`, `v_erp_stock_on_hand`, `v_erp_stock_truth`, `v_erp_unit_cost`, `v_existencia_dictamen`, `v_feed_freshness`, `v_kepler_unit_cost`, `v_product_box_factor`, `v_product_box_factor_consensus`, `v_product_unit_ladder`, `v_rd_period_summary`, `v_rd_route_daily`, `v_route_cost_resolved`, `v_route_monthly_provenance`, `v_route_operation_period`, `v_route_plaza`, `v_route_sales_lines`, `v_sales_demand_truth`, `v_seller_sales_lines`, `v_sellout_daily`, `v_supplier_cost_ladder`, `v_unit_rung_audit`, `v_unit_truth`, `v_unit_truth_coverage`, `v_warehouse_box_factor`, `v_wincaja_unit_audit`

### `kepler_ods`

ODS crudo del ERP Kepler (fuente canónica, ADR-059). 236 tablas espejo por replicación lógica de las 6-7 sucursales. Sin `tenant_id`, sin RLS (dato de un solo negocio). Decode en `docs/ERP_KEPLER.md`.

_Tablas Kepler (crudas). Decode de cada `cN`/doctype en [`docs/ERP_KEPLER.md`](ERP_KEPLER.md). Se listan las 40 mayores; el resto en el CSV._

| Tabla | Filas (est.) | Tamaño |
|---|--:|--:|
| `kdm2` | 3,943,245 | 2199 MB |
| `kdmx_26` | 1,474,929 | 1661 MB |
| `kdpv_bitacora_precios` | 5,274,885 | 1529 MB |
| `kdmx_25` | 753,546 | 918 MB |
| `orglogtbl_26` | 2,839,030 | 637 MB |
| `kdij` | 1,648,899 | 546 MB |
| `kdm1` | 603,362 | 516 MB |
| `orglogtbl_25` | 819,309 | 183 MB |
| `kdue` | 487,592 | 160 MB |
| `kdfe33satcp` | 765,984 | 106 MB |
| `kdfe33cecolo` | 1,162,928 | 104 MB |
| `kdfe33satprd` | 420,104 | 65 MB |
| `kdfe33satcpproductos` | 390,056 | 54 MB |
| `orglogtbl_24` | 233,176 | 52 MB |
| `kdpv_prod_util` | 336,983 | 43 MB |
| `kdii` | 76,447 | 42 MB |
| `kdfe33satpedadu` | 409,384 | 39 MB |
| `kdpord` | 121,132 | 33 MB |
| `kdlogmov` | 140,720 | 32 MB |
| `kdik` | 33,906 | 27 MB |
| `kdfe33m1` | 17,206 | 26 MB |
| `kdm_m2` | 87,041 | 25 MB |
| `kdpv_prov_prod` | 76,625 | 12 MB |
| `kdfe4imp` | 65,455 | 12 MB |
| `kdm5` | 50,830 | 12 MB |
| `kdm6` | 44,023 | 11 MB |
| `kdxe` | 40,921 | 11 MB |
| `kdc22608` | 37,426 | 11 MB |
| `kdc22607` | 41,715 | 11 MB |
| `kdpv_descuxq` | 62,738 | 10 MB |
| `kdc22604` | 35,085 | 8864 kB |
| `kdc22605` | 32,227 | 8288 kB |
| `kdil` | 33,906 | 8144 kB |
| `kdfe33relprd` | 78,251 | 8080 kB |
| `kdc22606` | 31,375 | 8024 kB |
| `kdc22601` | 27,250 | 7328 kB |
| `kdc22603` | 28,589 | 7296 kB |
| `kduf` | 26,806 | 7176 kB |
| `kdxf` | 23,942 | 6440 kB |
| `kdc22602` | 23,709 | 6168 kB |
| … | +196 tablas más | (ver CSV) |

### `wincaja`

Réplica cruda de Wincaja (POS Access→Postgres, Fase WR) + vistas de conveniencia. RLS forzado en las 29 tablas.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `detalles_mov_almacen` | 9,994,628 | 2249 MB | ✅ | ✅ | 19 |  |
| `precios` | 2,234,773 | 639 MB | ✅ | ✅ | 12 |  |
| `maestro_mov_almacen` | 1,499,801 | 457 MB | ✅ | ✅ | 20 |  |
| `movimiento_clientes` | 663,053 | 283 MB | ✅ | ✅ | 28 |  |
| `pagos_dia` | 794,218 | 261 MB | ✅ | ✅ | 16 |  |
| `articulos` | 383,329 | 157 MB | ✅ | ✅ | 22 |  |
| `existencias` | 383,284 | 118 MB | ✅ | ✅ | 19 |  |
| `cotizacion_lineas` | 244,514 | 48 MB | ✅ | ✅ | 14 |  |
| `clientes` | 48,090 | 18 MB | ✅ | ✅ | 26 |  |
| `retiros` | 60,889 | 14 MB | ✅ | ✅ | 15 |  |
| `ofertas` | 35,840 | 10 MB | ✅ | ✅ | 15 |  |
| `arqueos` | 26,000 | 10120 kB | ✅ | ✅ | 9 |  |
| `faltantes_cotizacion` | 31,785 | 8968 kB | ✅ | ✅ | 17 |  |
| `categorias` | 34,478 | 8024 kB | ✅ | ✅ | 9 |  |
| `proveedores` | 27,259 | 7664 kB | ✅ | ✅ | 17 |  |
| `subfamilias` | 26,784 | 6904 kB | ✅ | ✅ | 9 |  |
| `familias` | 26,804 | 6736 kB | ✅ | ✅ | 8 |  |
| `cotizaciones` | 19,621 | 6600 kB | ✅ | ✅ | 20 |  |
| `autorizaciones` | 21,924 | 4896 kB | ✅ | ✅ | 11 |  |
| `movimiento_proveedores` | 7,305 | 2496 kB | ✅ | ✅ | 19 |  |
| `articulo_proveedor` | 9,183 | 2368 kB | ✅ | ✅ | 10 |  |
| `cortes` | 6,398 | 2224 kB | ✅ | ✅ | 18 |  |
| `cajeros` | 306 | 136 kB | ✅ | ✅ | 8 |  |
| `formas_pago` | 142 | 96 kB | ✅ | ✅ | 10 |  |
| `vendedores` | 140 | 80 kB | ✅ | ✅ | 7 |  |
| `ordenes_compra` | 70 | 72 kB | ✅ | ✅ | 16 |  |
| `almacenes` | 35 | 64 kB | ✅ | ✅ | 7 |  |
| `branches` | 27 | 32 kB | ✅ | ✅ | 12 |  |
| `caja_channels` | 7 | 32 kB | ✅ | ✅ | 8 |  |

**Matviews**: `mv_branch_kpis` (27 filas, 64 kB)

**Vistas**: `v_ap_supplier`, `v_ar_customer`, `v_ar_open_docs`, `v_cash_authorizations`, `v_cash_denomination`, `v_lost_demand`, `v_prices`, `v_sales_daily`, `v_sales_lines`, `v_stock`

### `commercial`

Núcleo comercial construido desde cero (`commercial.*`, Fase B+). Clientes, almacenes, precios, stock, órdenes, política de reorden, requisiciones. **RLS forzado 115/117**, `tenant_id` 117/117, FK composite `(tenant_id,id)`.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `stock` | 155,041 | 478 MB | ✅ | ✅ | 10 |  |
| `stock_lots` | 89,988 | 242 MB | ✅ | ✅ | 12 | Sub-ledger de lotes (FEFO/caducidad, ADR-022). Descompone commercial.stock por ( |
| `replenishment_findings` | 31,634 | 35 MB | ✅ | ✅ | 19 | RA.8 — hallazgos de reabastecimiento (scanner nocturno). UPSERT por (tenant, ded |
| `abc_classification` | 55,396 | 31 MB | ✅ | ✅ | 12 | Clasificación ABC por (almacén, producto) por valor de consumo anualizado (Paret |
| `product_prices` | 10,143 | 28 MB | ✅ | ✅ | 13 |  |
| `reorder_policy` | 44,494 | 27 MB | ✅ | ✅ | 19 | RA/ADR-030 — política de reorden por producto×almacén. source: kepler (kdii.c33/ |
| `execution_360_snapshots` | 41,181 | 16 MB | ✅ | ✅ | 16 | Horus: snapshot diario append-only de execution_360 (feature store es UPSERT in- |
| `prospect_stores` | 1,650 | 13 MB | ✅ | ✅ | 33 | Fase DENUE: PdV descubiertos en INEGI DENUE (1 row por unidad económica, CLEE en |
| `product_label_prices` | 8,995 | 8032 kB | ✅ | ✅ | 21 | Etiquetera Tienda — datos de la etiqueta de anaquel por producto (gramaje, barco |
| `recommended_baskets` | 3,357 | 6968 kB | ✅ | ✅ | 9 | Canasta estratégica por customer. 1 row UPSERT por customer. Items JSONB con cat |
| `inventory_count_items` | 18,844 | 6544 kB | ✅ | ✅ | 28 |  |
| `execution_360` | 2,946 | 4160 kB | ✅ | ✅ | 30 | Horus feature store de ejecución en campo (Trade). 1 row UPSERT por (subject_typ |
| `execution_baselines` | 7,690 | 3944 kB | ✅ | ✅ | 14 | Horus Aprendizaje L1: lo "normal" por sujeto (media/desviación rodante desde exe |
| `customers` | 3,110 | 2632 kB | ✅ | ✅ | 33 |  |
| `replenishment_channel` | 2,125 | 2080 kB | ✅ | ✅ | 20 | RA-PRO.8 — canal (compra/traspaso) + cadencia por almacén×proveedor. Derivado de |
| `supervisor_findings` | 1,593 | 2072 kB | ✅ | ✅ | 18 | Horus: hallazgos del motor de supervisión (Trade). UPSERT idempotente por (tenan |
| `capture_vision` | 462 | 1176 kB | ✅ | ✅ | 26 | Horus H2.2: veredicto estructurado de Claude vision sobre cada foto de exhibició |
| `supervisor_actions` | 923 | 1168 kB | ✅ | ✅ | 30 | Horus co-piloto (Trade): acciones SUGERIDAS por el motor desde findings. pending |
| `vendor_sale_lines` | 1,150 | 1152 kB | ✅ | ✅ | 24 | Líneas de venta de la captura del vendedor (1 fila por producto OCR del ticket). |
| `commercial_actions` | 584 | 648 kB | ✅ | ✅ | 26 | Thot T.R2: cola de acciones del co-piloto comercial. Motor propone (confidence/i |
| `commercial_findings` | 581 | 568 kB | ✅ | ✅ | 17 | Thot T.R0: hallazgos del motor de inteligencia comercial (portafolio/distribució |
| `purchase_requisition_lines` | 2,036 | 552 kB | ✅ | ✅ | 19 |  |
| `portal_telemetry_events` | 534 | 512 kB | — | ✅ | 16 |  |
| `home_deliveries` | n/d | 328 kB | ✅ | ✅ | 43 |  |
| `customer_360` | 435 | 304 kB | ✅ | ✅ | 16 | Feature store por customer (Fase M). 1 row UPSERT por customer. RFM + cadencia + |
| `purchase_requisitions` | 183 | 296 kB | ✅ | ✅ | 22 |  |
| `orders` | 34 | 240 kB | ✅ | ✅ | 41 |  |
| `thot_chat_log` | 51 | 232 kB | ✅ | ✅ | 12 | TC.2/ADR-026 bitacora de Thot Chat (analitica conversacional). Append-only, audi |
| `briefing_history` | n/d | 184 kB | ✅ | ✅ | 10 | HIQ.1 historial del parte diario de Horus (memoria narrativa, 1 fila por dia). |
| `coaching_notes` | 205 | 176 kB | ✅ | ✅ | 14 | Horus H2.6: nota de coaching creada al aprobar una acción del co-piloto. Efecto  |
| `stock_movement_audits` | 94 | 176 kB | ✅ | ✅ | 10 | DM.4 — marca humana "documento auditado" del Diario de movimientos. Fila present |
| `vendor_visits` | 106 | 176 kB | ✅ | ✅ | 13 |  |
| `product_unit_overrides` | 293 | 160 kB | ✅ | ✅ | 11 | RA-PRO.28 — override manual de unidad de venta (SUF/BF) por producto para no inf |
| `warehouses` | 27 | 160 kB | ✅ | ✅ | 27 |  |
| `order_lines` | 46 | 144 kB | ✅ | ✅ | 18 |  |
| `route_tickets` | 1 | 144 kB | ✅ | ✅ | 24 | Cierre de ruta: tickets diarios del vendedor (venta/carga/combustible) para cont |
| `inventory_counts` | n/d | 128 kB | ✅ | ✅ | 22 |  |
| `payments` | n/d | 128 kB | ✅ | ✅ | 24 |  |
| `receiving_lot_captures` | n/d | 128 kB | ✅ | ✅ | 25 | Auditor de recepción por caducidad (ADR-044). Captura lote+caducidad con foto+OC |
| `commercial_diagnoses` | n/d | 120 kB | ✅ | ✅ | 18 | Thot T.R1: diagnóstico de causa raíz comercial. Correlaciona >=2 commercial_find |
| `inventory_investigations` | n/d | 120 kB | ✅ | ✅ | 22 | Expediente de investigación de diferencias (Fase PREV.1, Apéndice B): por qué fa |
| `expiry_review_lines` | n/d | 112 kB | ✅ | ✅ | 21 | P2.6 — renglones del Control de Caducidades: producto + estado físico + observac |
| `purchase_orders` | n/d | 112 kB | ✅ | ✅ | 21 | RA.15/ADR-031 — Orden de Compra (espejo Kepler X-A-35). Documento que se manda a |
| `rider_liquidations` | n/d | 112 kB | ✅ | ✅ | 27 |  |
| `execution_rule_stats` | 21 | 104 kB | ✅ | ✅ | 19 | Horus Aprendizaje L2: precisión por regla (finding_type×source) desde supervisor |
| `order_status_history` | n/d | 104 kB | ✅ | ✅ | 10 | Audit trail append-only de cambios de status de orders. 1 row por transición. ch |
| `receiving_lines` | 102 | 104 kB | ✅ | ✅ | 13 | Líneas del Vale vivo (ADR-044, Pieza 1): expected_qty (snapshot esperado) vs rec |
| `inventory_monitoring` | n/d | 96 kB | ✅ | ✅ | 13 | Monitoreo intensivo de un SKU tras pérdida no identificada (Fase PREV.2). 1 acti |
| `price_lists` | n/d | 96 kB | ✅ | ✅ | 16 |  |
| `push_subscriptions` | n/d | 96 kB | — | ✅ | 10 |  |
| `receiving_sessions` | n/d | 96 kB | ✅ | ✅ | 14 | Vale de Entrada vivo (ADR-044, Pieza 1): recepción por escaneo, expected vs físi |
| `stock_movements` | n/d | 96 kB | ✅ | ✅ | 14 |  |
| `stock_reservations` | n/d | 96 kB | ✅ | ✅ | 15 | FIQ.6 (ADR-038): apartado de pedidos con TTL. Reserva stock (reserved_quantity)  |
| `goods_receipts` | n/d | 88 kB | ✅ | ✅ | 14 | RA.15/ADR-031 — Orden de Entrada (espejo Kepler X-A-40). Recepción (permite parc |
| `supplier_discount_policy` | 147 | 88 kB | ✅ | ✅ | 13 | RE.10 — tasa de descuento esperada por proveedor (pronto pago/comercial). Base d |
| `carga_load_items` | n/d | 80 kB | ✅ | ✅ | 13 | Checklist de carga del vendedor: líneas (order_id,product_id) cargadas (loaded)  |
| `contact_trust_features` | n/d | 80 kB | ✅ | ✅ | 23 | FIQ.7 (ADR-037): feature store del trust-score por contacto (E.164). Salida del  |
| `lead_reservations` | n/d | 80 kB | ✅ | ✅ | 8 | Fase E: qué operador (reserved_by_user_id) tomó qué cliente del pool de televent |
| `supervisor_diagnoses` | n/d | 80 kB | ✅ | ✅ | 18 | Horus R1: diagnóstico de causa raíz. Correlaciona >=2 findings co-ocurrentes del |
| `supervisor_tasks` | n/d | 80 kB | ✅ | ✅ | 16 | Horus H2.6: tarea de campo creada al aprobar una acción del co-piloto (visita/re |
| `inventory_count_assignments` | 8 | 72 kB | ✅ | ✅ | 8 |  |
| `stock_lot_movements` | n/d | 72 kB | ✅ | ✅ | 12 | Ledger de movimientos por lote (FEFO/trazabilidad, ADR-022 P2.3). Registra qué l |
| `expiry_reviews` | n/d | 64 kB | ✅ | ✅ | 14 | P2.6 — encabezado del Control de Caducidades (inspección de anaquel). ADR-022. |
| `horus_chat_log` | n/d | 64 kB | ✅ | ✅ | 11 | HIQ.0 bitacora de Pregúntale a Horus (chat del supervisor, ADR-026 sobre Trade). |
| `inventory_monitoring_counts` | n/d | 64 kB | ✅ | ✅ | 11 | Conteos rápidos del monitoreo intensivo (Fase PREV.2): expected vs físico + vent |
| `product_aliases` | n/d | 64 kB | ✅ | ✅ | 8 |  |
| `receiving_claims` | n/d | 64 kB | ✅ | ✅ | 39 | WMS-REC.8 (ADR-053) — reclamo POR RENGLÓN de un vale cerrado con faltante/dañado |
| `commission_bonuses` | n/d | 56 kB | ✅ | ✅ | 17 | RD.6 — bonos. Chofer por VENTA del periodo; supervisor por MARGEN, con umbral po |
| `commission_periods` | n/d | 56 kB | ✅ | ✅ | 13 | RD.6 — quincenas de 14 dias. El Excel arranca en 2026-01-14 (fin del periodo 1)  |
| `commission_route_config` | n/d | 56 kB | ✅ | ✅ | 17 | RD.6 — config por ruta: escala, nomina de banco, chofer y supervisor. La nomina  |
| `commission_scale_tiers` | n/d | 56 kB | ✅ | ✅ | 12 | RD.6 — escalones. min_amount inclusivo, max_amount exclusivo y NULL = SIN TECHO: |
| `goods_receipt_lines` | n/d | 56 kB | ✅ | ✅ | 9 |  |
| `inventory_count_interruptions` | n/d | 56 kB | ✅ | ✅ | 10 |  |
| `inventory_count_sessions` | n/d | 56 kB | ✅ | ✅ | 10 |  |
| `purchase_order_lines` | n/d | 56 kB | ✅ | ✅ | 10 |  |
| `requisition_sequences` | 1 | 56 kB | ✅ | ✅ | 3 |  |
| `stock_reservation_lines` | n/d | 56 kB | ✅ | ✅ | 9 | FIQ.6: líneas del apartado (piezas + snapshot de precio). El cron libera reserve |
| `warehouse_aisles` | n/d | 56 kB | ✅ | ✅ | 13 | Pasillos 2D del almacén (layout permanente, grilla). FASE_PASILLOS_EQUIPOS / ADR |
| `commission_scales` | n/d | 48 kB | ✅ | ✅ | 16 | RD.6 — tabulador de comision de Ruta Directa, con ventana de vigencia. Las regla |
| `expiry_receiving_policy` | n/d | 48 kB | ✅ | ✅ | 12 | Reglas de caducidad en recepción (ADR-044). Motor del semáforo 🟢🟡🔴: vida útil |
| `promotions` | n/d | 48 kB | ✅ | ✅ | 21 | Catálogo de promociones configurables. rules JSONB lleva config específica por p |
| `prospect_sources` | n/d | 48 kB | ✅ | ✅ | 14 | Fase DENUE: config por tenant de la cosecha de prospectos (SCIAN objetivo, área  |
| `route_rebalance_log` | n/d | 48 kB | ✅ | ✅ | 12 | Horus ACT.5: rebalanceo de carga aplicado (co-piloto). moves + previous_state (u |
| `call_logs` | n/d | 40 kB | ✅ | ✅ | 11 | Fase E: log de cada llamada de televenta con outcome + notes. Opcionalmente link |
| `commercial_rule_stats` | n/d | 40 kB | ✅ | ✅ | 17 | Thot T.L2: calibración aprendida por finding_type (precisión desde confirm/dismi |
| `erp_sucursal_warehouse` | n/d | 40 kB | ✅ | ✅ | 5 | Crosswalk Sucursal ERP → almacén destino (WMS-REC.1): autollena el almacén del V |
| `execution_thresholds` | n/d | 40 kB | ✅ | ✅ | 13 | Horus: umbrales por tenant para el motor de findings (cobertura, score-drop, idl |
| `inventory_count_scan_log` | n/d | 40 kB | ✅ | ✅ | 7 | OFF.0 idempotency store del conteo offline: scan_uuid del cliente -> resultado a |
| `inventory_risk_index` | n/d | 40 kB | ✅ | ✅ | 12 | Índice de riesgo por (almacén,producto) (Fase PREV.3): score+nivel desde expedie |
| `route_warehouses` | n/d | 40 kB | ✅ | ✅ | 7 |  |
| `stock_lot_locations` | n/d | 40 kB | ✅ | ✅ | 11 | Auxiliar de ubicaciones (ADR-044, Pieza 3): cantidad de (producto,lote,caducidad |
| `warehouse_bins` | n/d | 40 kB | ✅ | ✅ | 10 | Posiciones físicas finas (rack-nivel-posición) por almacén (ADR-044, Pieza 3). |
| `commerce_signals` | n/d | 32 kB | ✅ | ✅ | 8 | Feedback loop (Fase M). Log append-only de ofertas/impresiones; conversión se de |
| `commission_run_lines` | n/d | 32 kB | ✅ | ✅ | 24 | RD.6 — el renglon del recibo, CONGELADO con la base que lo produjo (subtotal, ve |
| `commission_runs` | n/d | 32 kB | ✅ | ✅ | 22 | RD.6 — corrida por periodo. Motor decide / humano aprueba (ADR-016): nace borrad |
| `field_routes` | n/d | 32 kB | ✅ | ✅ | 11 |  |
| `replenishment_settings` | n/d | 32 kB | ✅ | ✅ | 7 | RA-PRO.27 — parámetros globales del pedido sugerido (fill rate + cobertura) por  |
| `supplier_item_aliases` | n/d | 32 kB | ✅ | ✅ | 18 | RE.11.1 — alias de item por proveedor (descripcion del proveedor -> SKU interno) |
| `thot_notes` | n/d | 32 kB | ✅ | ✅ | 8 | Memoria persistente de Thot (admin): hechos que el usuario le ensena en el chat, |
| `vendor_sales_routes` | n/d | 32 kB | ✅ | ✅ | 6 |  |
| `erp_transfer_origin` | n/d | 24 kB | ✅ | ✅ | 6 | WMS-REC.8 (ADR-053) — crosswalk CAPTURADO A MANO TI### → almacén que embarcó. El |
| `expiry_folio_sequences` | n/d | 24 kB | ✅ | ✅ | 6 | Consecutivo de folio de hoja de caducidad por sucursal y año (CAD-<suc>-<año>-<N |
| `home_delivery_sequences` | n/d | 24 kB | ✅ | ✅ | 5 |  |
| `inventory_count_sequences` | n/d | 24 kB | ✅ | ✅ | 5 |  |
| `inventory_investigation_sequences` | n/d | 24 kB | ✅ | ✅ | 3 |  |
| `order_sequences` | n/d | 24 kB | ✅ | ✅ | 5 | Counter atómico por (tenant, year) para generar orders.code. UPSERT atómico via  |
| `promoter_brands` | n/d | 24 kB | ✅ | ✅ | 6 | P2.6 — mapa promotor(usuario)↔marca: el promotor solo ve sus SKUs en Control de  |
| `purchase_doc_sequences` | n/d | 24 kB | ✅ | ✅ | 4 |  |
| `receiving_session_sequences` | n/d | 24 kB | ✅ | ✅ | 3 |  |
| `reservation_sequences` | n/d | 24 kB | ✅ | ✅ | 5 | FIQ.6: counter atómico por (tenant, year) para folio de apartado AP-YYYY-NNNNN.  |
| `rider_liquidation_sequences` | n/d | 24 kB | ✅ | ✅ | 5 |  |
| `sales_targets` | n/d | 24 kB | ✅ | ✅ | 10 | BI.9 — metas de venta por (scope, mes) capturadas a mano. Unico origen de vs-obj |
| `thot_chat_examples` | n/d | 24 kB | ✅ | ✅ | 10 | TC.4a/ADR-026 ejemplos verificados (few-shot) de Thot Chat. Pregunta->tools->res |
| `trust_thresholds` | n/d | 24 kB | ✅ | ✅ | 9 | FIQ.7 (ADR-037): umbrales del gate de confianza por tenant (sin hardcode). requi |
| `autonomy_policies` | n/d | 16 kB | ✅ | ✅ | 10 | Thot ADR-023: dial de autonomía por action_type (off/dry_run/auto + min_confiden |
| `field_track_points` | n/d | 16 kB | ✅ | ✅ | 8 |  |
| `field_live_position` | n/d | 8192 bytes | ✅ | ✅ | 7 |  |

### `fiscal`

CFDIs, listas SAT (EFOS/69B), config del emisor. RLS 13/16.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `cfdis` | 173,191 | 325 MB | ✅ | ✅ | 50 |  |
| `sat_list_rfcs` | 536,066 | 186 MB | — | — | 8 |  |
| `cfdi_payment_links` | 466 | 368 kB | ✅ | ✅ | 12 |  |
| `jobs` | 12 | 104 kB | ✅ | ✅ | 15 |  |
| `emission_errors` | n/d | 96 kB | ✅ | ✅ | 25 | FD.0 — errores de emisión CFDI (timbrado/NC/REP/cancelación). UPSERT por (tenant |
| `sat_credentials` | n/d | 80 kB | ✅ | ✅ | 22 |  |
| `download_requests` | n/d | 64 kB | ✅ | ✅ | 18 |  |
| `rfc_issues` | 24 | 64 kB | ✅ | ✅ | 12 |  |
| `sat_list_matches` | n/d | 64 kB | ✅ | ✅ | 16 |  |
| `download_packages` | n/d | 48 kB | ✅ | ✅ | 12 |  |
| `issuer_config` | n/d | 48 kB | ✅ | ✅ | 12 |  |
| `sat_list_versions` | n/d | 48 kB | — | — | 7 |  |
| `cfdi_assignments` | n/d | 40 kB | ✅ | ✅ | 19 |  |
| `cod_agrupador_map` | n/d | 32 kB | ✅ | ✅ | 6 |  |
| `sat_list_staging` | 0 | 24 kB | — | — | 6 |  |
| `invoice_sequences` | n/d | 16 kB | ✅ | ✅ | 6 |  |

### `finance`

Dominio financiero (Maat, CB conciliación bancaria, CC cobranza, pagos, hallazgos). **RLS forzado 39/39**.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `findings` | 82,450 | 171 MB | ✅ | ✅ | 21 |  |
| `finding_features` | 82,450 | 78 MB | ✅ | ✅ | 10 |  |
| `bank_movements` | 38,175 | 24 MB | ✅ | ✅ | 21 |  |
| `purchase_book_history` | 15,121 | 5896 kB | ✅ | ✅ | 16 |  |
| `supplier_payment_proofs` | 1,202 | 3080 kB | ✅ | ✅ | 34 |  |
| `bank_recon_matches` | 4,854 | 2368 kB | ✅ | ✅ | 12 |  |
| `payment_program` | 2,716 | 2280 kB | ✅ | ✅ | 24 |  |
| `goods_receipt_proofs` | 161 | 728 kB | ✅ | ✅ | 37 |  |
| `gl_supplier_accounts` | 929 | 720 kB | ✅ | ✅ | 23 |  |
| `detector_hypotheses` | 190 | 328 kB | ✅ | ✅ | 16 |  |
| `expense_areas` | 555 | 240 kB | ✅ | ✅ | 9 |  |
| `proposed_actions` | 197 | 208 kB | ✅ | ✅ | 18 |  |
| `purchase_book_runs` | 1 | 176 kB | ✅ | ✅ | 35 |  |
| `rule_registry` | 72 | 176 kB | ✅ | ✅ | 14 |  |
| `chat_messages` | n/d | 160 kB | ✅ | ✅ | 10 |  |
| `expense_comprobaciones` | 1 | 144 kB | ✅ | ✅ | 26 |  |
| `recon_tasks` | n/d | 136 kB | ✅ | ✅ | 24 |  |
| `bank_concentrado_ref` | 260 | 128 kB | ✅ | ✅ | 9 |  |
| `bank_statements` | 126 | 128 kB | ✅ | ✅ | 14 |  |
| `bank_capture_inbox` | n/d | 112 kB | ✅ | ✅ | 34 |  |
| `bank_capture_senders` | 106 | 104 kB | ✅ | ✅ | 12 |  |
| `baselines` | 53 | 96 kB | ✅ | ✅ | 6 |  |
| `expense_proofs` | 4 | 96 kB | ✅ | ✅ | 25 |  |
| `knowledge` | n/d | 96 kB | ✅ | ✅ | 10 |  |
| `bank_accounts` | 20 | 80 kB | ✅ | ✅ | 12 |  |
| `collection_deposits` | n/d | 80 kB | ✅ | ✅ | 29 |  |
| `bank_classify_rules` | n/d | 64 kB | ✅ | ✅ | 11 |  |
| `chat_sessions` | n/d | 64 kB | ✅ | ✅ | 7 |  |
| `goods_receipt_proof_history` | n/d | 64 kB | ✅ | ✅ | 11 | RE.13.2 — cadena de decisiones de la evidencia de recepción (quién subió, quién  |
| `movement_categories` | n/d | 64 kB | ✅ | ✅ | 12 |  |
| `purchase_book_run_items` | n/d | 48 kB | ✅ | ✅ | 8 |  |
| `recon_task_messages` | n/d | 48 kB | ✅ | ✅ | 9 |  |
| `sheet_sync_config` | n/d | 48 kB | ✅ | ✅ | 12 |  |
| `collection_promises` | n/d | 32 kB | ✅ | ✅ | 15 |  |
| `goods_receipt_discards` | n/d | 32 kB | ✅ | ✅ | 8 | RE.20.3 — entradas de Kepler que NUNCA van a tener factura de proveedor (traspas |
| `receipt_settings` | n/d | 32 kB | ✅ | ✅ | 8 | RE.13.0 — parámetros del proceso de recepción documental por tenant (arranque, t |
| `caja_bank_crosswalk` | n/d | 24 kB | ✅ | ✅ | 12 |  |
| `finding_feedback` | n/d | 24 kB | ✅ | ✅ | 7 |  |
| `finding_model` | n/d | 16 kB | ✅ | ✅ | 10 |  |

**Vistas**: `kepler_accounts`, `v_purchase_book_uuid_prueba`, `v_purchase_book_uuids`

### `logistics`

Logística (embarques, flota, GPS, guías, costos, POD). **RLS forzado 32/33**.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `vehicle_positions` | 404,092 | 215 MB | — | ✅ | 14 |  |
| `vehicle_stops` | 10,370 | 9832 kB | ✅ | ✅ | 13 |  |
| `trackers` | 50 | 4512 kB | ✅ | ✅ | 31 |  |
| `fleet_alerts` | 9,437 | 3528 kB | ✅ | ✅ | 15 |  |
| `vehicle_day_summary` | 1,412 | 776 kB | ✅ | ✅ | 14 |  |
| `route_expenses` | 782 | 376 kB | ✅ | ✅ | 21 | RD.4 — gasto de flota de Ruta Directa, factura por factura, con litros. Dato PRO |
| `vehicles` | 97 | 160 kB | ✅ | ✅ | 27 |  |
| `route_odometer` | 187 | 152 kB | ✅ | ✅ | 17 | RD.5 — KM INICIAL/FINAL por quincena y ruta, de la hoja OPERACION DE LAS RUTAS.  |
| `shipments` | n/d | 144 kB | ✅ | ✅ | 26 |  |
| `routes` | 97 | 136 kB | ✅ | ✅ | 16 |  |
| `config_finance` | 46 | 128 kB | ✅ | ✅ | 12 |  |
| `delivery_guides` | n/d | 128 kB | ✅ | ✅ | 24 |  |
| `drivers` | n/d | 128 kB | ✅ | ✅ | 25 |  |
| `payroll_periods` | 26 | 96 kB | ✅ | ✅ | 13 |  |
| `shipment_expenses` | n/d | 80 kB | ✅ | ✅ | 22 |  |
| `guide_recipients` | n/d | 64 kB | ✅ | ✅ | 33 |  |
| `liquidations` | n/d | 64 kB | ✅ | ✅ | 18 |  |
| `home_delivery_warehouses` | 3 | 56 kB | ✅ | ✅ | 10 |  |
| `shipment_checklists` | n/d | 56 kB | ✅ | ✅ | 15 |  |
| `shipment_photos` | n/d | 56 kB | ✅ | ✅ | 16 |  |
| `vehicle_assignments` | n/d | 56 kB | ✅ | ✅ | 23 |  |
| `vehicle_usage_logs` | n/d | 56 kB | ✅ | ✅ | 17 |  |
| `cartaporte_documents` | n/d | 48 kB | ✅ | ✅ | 23 |  |
| `load_details` | n/d | 48 kB | ✅ | ✅ | 9 |  |
| `unload_details` | n/d | 48 kB | ✅ | ✅ | 10 |  |
| `vehicle_entitlements` | n/d | 48 kB | ✅ | ✅ | 15 |  |
| `vehicle_maintenance` | n/d | 48 kB | ✅ | ✅ | 17 |  |
| `carrier_fiscal_profile` | n/d | 32 kB | ✅ | ✅ | 14 |  |
| `fuel_transactions` | n/d | 32 kB | ✅ | ✅ | 13 |  |
| `payroll_adjustments` | n/d | 32 kB | ✅ | ✅ | 12 |  |
| `route_expense_types` | n/d | 32 kB | ✅ | ✅ | 10 | RD.4 — las 6 categorias de gasto de la hoja, mas 0 SIN CLASIFICAR para las filas |
| `route_optimizations` | n/d | 24 kB | ✅ | ✅ | 9 |  |
| `sequences` | n/d | 24 kB | ✅ | ✅ | 6 | Counter atómico por (tenant, prefix, year). UPSERT genera folios EMB-YYYY-NNNNN  |

### `catalog`

Catálogo de productos normalizado (SoR de producto). RLS 5/7.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `products` | 14,829 | 56 MB | ✅ | ✅ | 52 | SKUs del portafolio. Pertenecen a una brand del mismo tenant (composite FK enfor |
| `product_barcodes` | 14,723 | 10 MB | ✅ | ✅ | 14 | Códigos de barras por SKU y UNIDAD (1→N). Un SKU trae un EAN por pieza (Kepler c |
| `suppliers` | 1,305 | 768 kB | ✅ | ✅ | 22 |  |
| `top_sellers_live` | 1,000 | 648 kB | — | ✅ | 14 |  |
| `brands` | 637 | 520 kB | ✅ | ✅ | 14 | Marcas del portafolio del tenant. Padre de products. RLS activo. |
| `products_top_sellers` | 550 | 488 kB | — | ✅ | 14 | HOTFIX 2026-06-03: convertida de MV a TABLE porque la MV original dependía del F |
| `categories` | 386 | 320 kB | ✅ | ✅ | 12 |  |

**Vistas**: `products_active`

### `intelligence`

Motor de inteligencia comercial (Thot/Horus feature store). RLS 4/4.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `product_affinity` | 28,787 | 27 MB | ✅ | ✅ | 9 |  |
| `zone_demand` | 18,683 | 13 MB | ✅ | ✅ | 9 |  |
| `pdv_presence` | 2,496 | 1264 kB | ✅ | ✅ | 8 |  |
| `push_directives` | n/d | 16 kB | ✅ | ✅ | 15 |  |

### `public`

Schema LEGACY del producto original (trade marketing v1): productos, stores, zones, visits, users, role_permissions. Convive con los schemas nuevos. **Aquí vive el ledger de migraciones `knex_migrations` (692 filas).**

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `route_location_pings` | 16,280 | 20 MB | — | ✅ | 13 |  |
| `products_normalize_backup_20260528` | 1,420 | 8152 kB | — | ✅ | 16 |  |
| `knex_migrations` | 659 | 128 kB | — | — | 4 |  |
| `route_snapped_tracks` | n/d | 80 kB | — | ✅ | 12 |  |
| `knex_migrations_lock` | 1 | 56 kB | — | — | 2 |  |

**Vistas**: `brands`, `catalogs`, `categories`, `daily_assignments`, `daily_captures`, `exhibition_photos`, `exhibitions`, `products`, `products_active`, `products_top_sellers`, `role_permissions`, `rubric_criteria`, `rubric_levels`, `scoring_config`, `scoring_config_versions`, `scoring_weights`, `stores`, `tenants`, `users`, `valid_exhibition_combinations`, `vendedores_erp`, `visits`, `zones`

### `trade`

Trade marketing / auditoría de ejecución en PdV (visitas, exhibiciones, rúbrica, scoring). Mayormente VACÍO en prod (producto original no arrancado). RLS 17/18.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `daily_captures` | 1,331 | 6392 kB | ✅ | ✅ | 30 | Capturas diarias de visitas (core del negocio). exhibiciones JSONB contiene arra |
| `stores_route_audit` | 2,167 | 4280 kB | — | — | 11 |  |
| `stores` | 1,590 | 808 kB | ✅ | ✅ | 16 |  |
| `planogram_skus` | 852 | 392 kB | ✅ | ✅ | 16 | Subset curado de catalog.products que conforma el planograma de auditoría PdV. 1 |
| `daily_assignments` | 52 | 144 kB | ✅ | ✅ | 14 |  |
| `catalogs` | 24 | 104 kB | ✅ | ✅ | 15 | Tabla genérica EAV: rutas, conceptos, niveles, etc. Cada fila tiene catalog_id q |
| `scoring_config_versions` | n/d | 96 kB | ✅ | ✅ | 15 | Versiones del config (v1.0, v2.0...). fecha_fin=null indica versión vigente. |
| `scoring_weights` | n/d | 88 kB | ✅ | ✅ | 13 |  |
| `zones` | n/d | 88 kB | ✅ | ✅ | 12 |  |
| `catalog_aliases` | n/d | 56 kB | ✅ | ✅ | 13 | Mapeo id de catálogo viejo (old_id) → id vigente (current_id en trade.catalogs). |
| `exhibitions` | n/d | 48 kB | ✅ | ✅ | 16 |  |
| `visits` | n/d | 48 kB | ✅ | ✅ | 17 |  |
| `exhibition_photos` | n/d | 32 kB | ✅ | ✅ | 13 |  |
| `rubric_criteria` | n/d | 32 kB | ✅ | ✅ | 13 |  |
| `rubric_levels` | n/d | 32 kB | ✅ | ✅ | 16 |  |
| `scoring_config` | n/d | 32 kB | ✅ | ✅ | 10 | Config single-row legacy del scoring v1 (JSONB). Coexiste con scoring_config_ver |
| `valid_exhibition_combinations` | n/d | 32 kB | ✅ | ✅ | 12 |  |
| `planogram_sku_aliases` | n/d | 24 kB | ✅ | ✅ | 14 | Mapeo código ERP (erp_sku) → producto del planograma (product_id catalog). Uno-a |

### `reconciliation`

Conciliación genérica (divergencias device↔server). RLS 5/5.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `discrepancies` | 2,371 | 10 MB | ✅ | ✅ | 23 |  |
| `blind_counts` | 5 | 160 kB | ✅ | ✅ | 25 |  |
| `rule_registry` | 26 | 120 kB | ✅ | ✅ | 14 |  |
| `actions` | n/d | 40 kB | ✅ | ✅ | 17 |  |
| `discrepancy_feedback` | n/d | 24 kB | ✅ | ✅ | 8 |  |

### `inventory`

Conteo cíclico de inventario. RLS 2/4.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `products` | 13,852 | 5016 kB | — | — | 30 | Catálogo MASTER del ERP MegaDulces (~13852 SKUs). Sync from erp.catalogo_complet |
| `warehouse_stock` | 7,742 | 2288 kB | ✅ | ✅ | 8 |  |
| `products_active` | 9,772 | 1800 kB | — | — | 13 | SKUs activos (vendibles hoy) del ERP MegaDulces (~6489). Sync from erp.productos |
| `warehouse_stock_movements` | n/d | 40 kB | ✅ | ✅ | 14 | Bitácora append-only del saldo inventory.warehouse_stock (por sku). Espejo de co |

### `identity`

Identidad y autorización: usuarios, roles, permisos, tenants, historial de puesto. RLS 11/18. **`public.knex_migrations` es el ledger real (no éste).**

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `products_dedup_backup_20260716` | 1,927 | 1720 kB | — | ✅ | 51 |  |
| `role_permissions` | 88 | 400 kB | ✅ | ✅ | 13 |  |
| `users` | 129 | 368 kB | ✅ | ✅ | 33 | Usuarios del tenant. RLS activo: solo visible/escribible con app.tenant_id setea |
| `role_scopes` | 240 | 264 kB | ✅ | ✅ | 12 |  |
| `user_events` | 203 | 216 kB | ✅ | ✅ | 8 | [ID.8] Bitácora de cambios de usuario: alta, baja, cambio de rol/alcance/contras |
| `user_roles` | 117 | 200 kB | ✅ | ✅ | 10 | [ID.13] Roles de un usuario. is_primary = perfil base (espejo de users.role_name |
| `user_scopes` | 46 | 128 kB | ✅ | ✅ | 12 |  |
| `positions` | 43 | 120 kB | ✅ | ✅ | 17 |  |
| `tenants` | n/d | 80 kB | — | — | 9 | Registro de organizaciones (tenants). Tabla GLOBAL — no tiene tenant_id porque E |
| `departments` | n/d | 72 kB | ✅ | ✅ | 12 | Departamentos del organigrama. Eje ORGANIZACIONAL del usuario — NO otorga permis |
| `user_responsibilities` | n/d | 64 kB | ✅ | ✅ | 14 | [OR.1] EXCEPCION por persona sobre lo que dice su puesto. nota NOT NULL y vigenc |
| `user_permissions` | n/d | 48 kB | ✅ | ✅ | 9 | [ID.21] Diferencia de permisos de una persona contra el estandar de su puesto. a |
| `position_responsibilities` | n/d | 32 kB | ✅ | ✅ | 11 | [OR.1] De que responde cada PUESTO. Es la fuente normal; identity.user_responsib |
| `responsibilities` | n/d | 32 kB | — | — | 6 | [OR.1] Catalogo de lo que se puede tener a cargo. A NIVEL PRODUCTO (sin tenant_i |
| `knex_migrations_lock` | n/d | 24 kB | — | — | 2 |  |
| `scope_dimensions` | n/d | 24 kB | — | — | 7 | ADR-050. Dimensiones de alcance de datos. supports_own = si mode=own tiene senti |
| `brands_dedup_backup_20260716` | 61 | 8192 bytes | — | ✅ | 14 |  |
| `knex_migrations` | n/d | 8192 bytes | — | — | 4 |  |

**Vistas**: `v_authz_coherencia`, `v_position_history`

### `whatsapp`

Integración WhatsApp (diferida). RLS 8/9.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `messages` | n/d | 120 kB | ✅ | ✅ | 9 |  |
| `conversation_threads` | n/d | 80 kB | ✅ | ✅ | 14 |  |
| `reorder_nudges` | n/d | 64 kB | ✅ | ✅ | 12 | FIQ.10: bitácora de nudges de reorden (idempotencia anti-spam + audit + seam de  |
| `bot_chat_log` | n/d | 48 kB | ✅ | ✅ | 13 | FIQ.1: auditoría por turno del bot (modelo/tools/latencia) + fuente del throttle |
| `contact_profile` | n/d | 48 kB | ✅ | ✅ | 11 |  |
| `campaign_recipients` | n/d | 40 kB | ✅ | ✅ | 9 |  |
| `marketing_optin` | n/d | 40 kB | ✅ | ✅ | 9 |  |
| `campaigns` | n/d | 24 kB | ✅ | ✅ | 16 |  |
| `phone_number_tenant_map` | n/d | 24 kB | — | ✅ | 4 |  |

### `pgboss`

Cola de trabajos pg-boss (infra). Sin tenant_id, sin RLS.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `queue` | 1 | 112 kB | — | — | 27 |  |
| `version` | 1 | 104 kB | — | — | 4 |  |
| `job_common` | n/d | 88 kB | — | — | 33 |  |
| `job_dependency` | n/d | 24 kB | — | — | 4 |  |
| `queue_stats_20260813` | n/d | 24 kB | — | — | 9 |  |
| `queue_stats_20260814` | n/d | 24 kB | — | — | 9 |  |
| `warning` | n/d | 24 kB | — | — | 5 |  |
| `bam` | n/d | 16 kB | — | — | 11 |  |
| `schedule` | n/d | 16 kB | — | — | 8 |  |
| `subscription` | n/d | 16 kB | — | — | 4 |  |

### `hr`

Recursos humanos / checadores. RLS 5/5.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `attendance_logs` | n/d | 48 kB | ✅ | ✅ | 13 |  |
| `device_enrollments` | n/d | 48 kB | ✅ | ✅ | 21 |  |
| `attendance_devices` | n/d | 40 kB | ✅ | ✅ | 25 |  |
| `employees` | n/d | 40 kB | ✅ | ✅ | 16 |  |
| `device_sync_runs` | n/d | 32 kB | ✅ | ✅ | 15 |  |

**Vistas**: `attendance_days`

### `erp`

1 tabla puente ERP.

| Tabla | Filas (est.) | Tamaño | RLS | `tenant_id` | Cols | Comentario |
|---|--:|--:|:-:|:-:|--:|---|
| `staff` | n/d | 56 kB | ✅ | ✅ | 8 |  |

### `md`

**225 VISTAS** (0 tablas) — shim 1:1 sobre `kepler_ods.*` para que el código viejo lea `md.kdm1` sin copiar. postgres_fdw está instalado pero SIN USO (0 servidores/foreign tables): el shim es SQL puro.

225 vistas espejo 1:1 sobre `kepler_ods.*` (una por tabla Kepler relevante). No se listan aquí; ver la lista de `kepler_ods`. Sólo lectura.

## 4. Cómo se regeneró

Introspección read-only con `pg` (Node) contra `FLEET_DB_URL`, consultando sólo `pg_catalog`/`information_schema`:
`pg_class`, `pg_namespace`, `pg_attribute`/`information_schema.columns`, `pg_indexes`, `pg_constraint`, `pg_policies`, `pg_proc`, `pg_trigger`, `pg_extension`.
Sin escrituras. Para refrescar este doc, re-correr la introspección y regenerar. Volúmenes son estimados de `reltuples` (planner), no `count(*)`.
