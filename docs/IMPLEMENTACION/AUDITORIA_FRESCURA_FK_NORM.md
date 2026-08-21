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

---

## ESTADO DE EJECUCIÓN (2026-08-21) — remediación completada

| Item | Estado | Detalle |
|---|---|---|
| **10 sensores de frescura** (P0×4 + P1×6) | ✅ código | `db-health.service.ts` (`b2cee2ff`+`bac92dd4`). Verificados vs prod. **Falta redeploy api.** |
| **abc_classification congelada** | ✅ arreglado | Ningún `@Cron` la escribía → `recomputeAbcAll` @3:30AM MX en CycleCountScheduler (`b2636447`). La data actual sigue en 2026-06-20 hasta el 1er run (o disparar el endpoint manual). |
| **sales_by_vendor_monthly huérfano** | ✅ agendado | al nightly de run-prod-feeds (`bac92dd4`). |
| **DROP 11 `*_snapshot_bak`** | ✅ migración | `20260821130000_drop_dead_snapshot_baks.js` (`bd8b0e3c`). Verificado: cero refs en código. Se aplica en el próximo deploy. |
| **FK `route_push_lines`** | ❌ N/A | El esquema real tiene `sku` (texto) + `route_no`, NO `product_id`/`warehouse_id` → import crudo por clave natural = **legit-no-FK**. |
| **FK `route_tickets`** | ❌ N/A | No tiene `customer_id`/`store_id` (es ticket de vendedor: `vendor_user_id`+`route_code`+OCR, 1 fila) → **legit-no-FK**. |
| **top_sellers_live doble escritor** | ⏸️ decisión Edgar | cron in-process 04:15 (`kepler-consolidado.service.ts:131`) + importer nightly. Ambos escriben y el dato está fresco → redundancia benigna, no bug. Retirar uno = elegir cuál manda; bajo riesgo pero es tu call. |
| **Re-seed `movement_categories`(0)+`knowledge`(0)** | ⏸️ Edgar (dato prod) | Escritura a prod (bloqueada para Claude). `movement_categories` debería sembrarla la mig `20260722140000`; investigar por qué quedó en 0. `classify()` de bancos cae a fallback silencioso mientras. |
| **Fase CA (CEDIS Access→ODS)** | ⏸️ fase aparte | Cura de fondo del gap estructural 00. No es parte de esta remediación. |

**Cerrados por investigación (2026-08-21, solo lectura):**
- **stock CEDIS '00' (131 SKUs)** — el sensor queda VERDE (fresco, updated hoy); no era frescura sino **cobertura**: el CEDIS real vive en Access (`md_00@9.95` es parcial) → traza a **Fase CA**, no a un feed roto. El sensor lo destapó correctamente.
- **`warehouses.source_warehouse_id`** — poblado y correcto (01/03/06/MD-30→00, MD-32→MD-30, 02/04→01, 05→06). El CEDIS '00' = raíz (null correcto: se planea por demanda de red, RA-PRO.6). Sin acción.
- **`trade.stores_route_audit`** (946 filas) — sin escritor vivo (solo la mig FK `20260820190000` lo tocó) = snapshot congelado a propósito (audit trail backfilleado). No es feed roto; sin pérdida de dato.

**Correcciones al plan del audit** (verificado contra el esquema real): las 2 FK "needs-fk" NO aplican (columnas inexistentes). El resto del plan se sostuvo.
**Pendiente de Edgar:** (1) redeploy api → activa los 10 sensores + arregla el freeze de abc going-forward; (2) deploy corre la migración de drops; (3) decidir escritor de top_sellers_live; (4) re-seed finance; (5) opcional: disparar el endpoint de ABC para refrescar la data ya (sino se arregla sola esta noche).
