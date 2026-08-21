# Auditoría de tablas derivadas — Frescura · FK · Normalización (2026-08-20)

> Disparada por el desfase de la sucursal 00 (oficinas) que quedó congelada en el ODS sin aviso.
> Objetivo de Edgar: **"no quiero desfase de información nuevamente"**. 278 tablas auditadas (analytics/
> finance/commercial/catalog/intelligence/logistics/trade) por workflow multi-agente. 46 findings: **7 P0, 18 P1, 14 P2, 7 P3**.
> Lección transversal: un feed muere y el tablero sigue en verde porque el monitor mira un `max()` GLOBAL o no existe.

## 1. FRESCURA — "no desfase nunca más" (P0)

| # | Tabla | Por qué P0 | Fix |
|---|---|---|---|
| 1 | **commercial.stock** | monitor `stock` usa `max(updated_at)` **global** → 01-06 enmascaran freeze del '00' (Wincaja Irapuato guard "no borra si vacío" sirve existencia vieja). La lección de la 00, en money-path de inventario. | Monitor **per-warehouse** (foco `code='00'`), calca `kepler_ods_branch_stale`. |
| 2 | **logistics.vehicle_positions**+**trackers** | GPS vivo (186k), fuente única. `FleetPollerService @Cron 1min` NO late en `cron_runs` + sin FEED en db-health. Gateado por `MAGNI_USER/PASS`. | Heartbeat `fleet_poll` + FEED sobre `max(recorded_at)`. Verificar creds MAGNI en prod. |
| 3 | **finance.bank_movements**+**bank_statements** | SoR conciliación (15,733), carga 100% manual mensual CLI, sin heartbeat. Un mes olvidado congela en silencio. | Sensor `MAX(bank_statements.period)` → rojo si >35-40 días. |
| 4 | **analytics.erp_supplier_payments** (vista 00-only) | deriva de `kepler_ods.kdm1 suc='00'`; `kepler_ods_branch_stale` **excluye la 00**. (⚠️ 00 ya está en replicación lógica desde hoy — el monitor debe incluirla.) | Monitor por business-date de la vista + latido `kepler_ods` 00. |
| 5 | **analytics.erp_collections** (vista 00-only) | igual que #4. | igual. |
| 6 | **analytics.sales_by_vendor_monthly** | importer **HUÉRFANO** (648k filas): NO está en run-prod-feeds ni PM2, sin modo ni latido. | Agendar (nightly/PM2) + heartbeat + monitor business-date. |

**Regla de infra (P1):** todos los `@Cron` in-process de `libs/commercial`+`trade`+`finance`+flota que hoy NO escriben `analytics.cron_runs` → envolver con `cron-heartbeat` + registrar en `CRON_JOBS`. Solo `analytics-refresh` late hoy. Afectados: `execution_360`(+familia Horus), `customer_360` (cobertura parcial 282 vs ~3110 clientes), `recommended_baskets` (portal-facing), `replenishment_findings`, `abc_classification` (DELETE-all+INSERT → alarma `rows=0`), `finance.findings`(maat_scan @3AM), flota `vehicle_stops`/`vehicle_day_summary`, `bank_concentrado_ref` (falsos OK si stale), `payment_program` (2,716 Tesorería manual). Slices-00 de vistas: `erp_goods_receipts`, `expense_documents`, `expense_requests`.

## 2. FK

**needs-fk:** `analytics.route_push_lines` (product_id+warehouse_id — quedó fuera de las migs FK 2026-08-19) · `commercial.route_tickets` (customer_id/store_id — requiere limpiar huérfanos, OK Edgar).

**dead-backup a DROP (OK Edgar, ~217k filas muertas, trampa de lectura):** `erp_goods_receipt_lines_snapshot_bak`(89k) · `erp_shipments_snapshot_bak`(59k) · `erp_collections_snapshot_bak`(24k) · `expense_documents_snapshot_bak`(17k) · `erp_goods_receipts_snapshot_bak`(14k) · `expense_requests_snapshot_bak`(7.4k) · `erp_supplier_payments_snapshot_bak`(4.3k) · `erp_customers_snapshot_bak`(1.3k) · `erp_promotions_snapshot_bak`(794) · `erp_purchase_docs_snapshot_bak`(0) · `erp_purchase_doc_lines_snapshot_bak`(0). Empezar por las 2 vacías (no-riesgo).

**legit-no-fk (dejar):** supplier_discount_policy, bank_concentrado_ref, baselines, movement_categories, knowledge, product_barcodes, intelligence.* (feature stores).

## 3. Normalización

- 11 `*_snapshot_bak` → DROP (arriba). Las vistas vivas ya existen; la migración tabla→vista fue correcta, solo falta retirar los respaldos.
- `catalog.top_sellers_live` — **dos escritores** (cron in-process 04:15 + importer nightly). Consolidar a uno.
- `finance.movement_categories`(0) + `finance.knowledge`(0) — seeds ausentes (18 y 27 entradas); re-correr. Sin categorías, `classify()` de bancos cae a fallback silencioso.
- `trade.stores_route_audit` — 946 filas **sin escritor detectable**. Decidir: feed a re-agendar vs snapshot congelado a propósito.

## ACCIONES SEGURAS (aditivas/reversibles — sin OK)
1. Monitor per-warehouse `commercial.stock` (foco '00'). [P0-1]
2. Heartbeat+FEED poller flota + verificar creds MAGNI prod. [P0-2]
3. Sensor frescura bancaria `MAX(period)`. [P0-3]
4. Monitor business-date vistas 00-only + latido `kepler_ods` 00. [P0-4/5]
5. Agendar `import-sales-by-vendor-monthly` + heartbeat. [P0-6]
6. Envolver `@Cron` in-process con heartbeat + `CRON_JOBS`. [P1]
7. FK `route_push_lines` (idempotente). [P2]
8. Re-seed `movement_categories`+`knowledge`. [P2/P3]
9. Verificar `warehouses.source_warehouse_id` poblado (DRP CEDIS). [P2]

## REQUIERE OK DE EDGAR
1. DROP de las 11 `*_snapshot_bak` (empezar por las 2 vacías).
2. FK en `commercial.route_tickets` (limpiar huérfanos primero).
3. Consolidar escritor de `catalog.top_sellers_live`.
4. Acelerar Fase CA (CEDIS Access→ODS) — cura de fondo del gap estructural 00.
