/* eslint-disable no-console */
/**
 * Orquestador del RUNNER ON-PREM → prod (Railway). Punto de entrada único para el
 * Task Scheduler de Windows. Corre los importers bulk como subprocesos, en orden,
 * con el env ya cargado. NO contiene lógica de negocio (cada importer es la fuente
 * de verdad); solo secuencia + guardas.
 *
 * Modos:
 *   node database/importers/kepler/run-prod-feeds.js live      # venta viva → prod (cada 15-30 min; LIGERO, solo consolidado local)
 *   node database/importers/kepler/run-prod-feeds.js stock     # stock 6 sucursales (cada 30 min)
 *   node database/importers/kepler/run-prod-feeds.js nightly   # rotación + top-sellers + contables (nightly)
 *   node database/importers/kepler/run-prod-feeds.js finance   # solo feeds contables (balanza/cadena/solicitudes/canal/caja) — re-run manual
 *   node database/importers/kepler/run-prod-feeds.js catalog   # catálogo + precios (semanal)
 *   node database/importers/kepler/run-prod-feeds.js all       # todo (cutover / manual)
 *
 * Por seguridad NO aplica salvo --apply (default dry-run), y exige que
 * DATABASE_URL_NEW apunte explícitamente a prod (evita pegarle al local sin querer).
 *
 * Env requerido (cargar en la tarea programada):
 *   DATABASE_URL_NEW                 = <proxy Railway prod>
 *   DATABASE_URL_KEPLER_CONSOLIDADO  = postgresql://...@localhost:5433/kepler_consolidado
 *   MEGA_DULCES_URL                  = postgresql://...@192.168.0.245:5432/Mega_Dulces  (solo catalog)
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const hb = require('../lib/cron-heartbeat'); // Salud BD: latido por MODO → analytics.cron_runs

const MODE = process.argv[2];
const APPLY = process.argv.includes('--apply');
// Timeout por importer. Un importer sano termina en minutos; un cuelgue (ECONNRESET a
// prod sin timeout de socket) es INFINITO y trababa todo el batch → el scheduler lo
// mataba a los 20min dejando node huérfanos que bloqueaban las corridas siguientes
// (incidente 2026-08-05). Con esto, un paso colgado se mata y el batch sigue.
const STEP_TIMEOUT_MIN = Number(process.env.FEED_STEP_TIMEOUT_MIN) || 10;
// Override de timeout para importers PESADOS que no caben en el default. import-stock-movements
// hace el pase 120d de kdm1⋈kdm2 en las 6 sucursales (delete+reinsert por ventana) → tardaba
// >10 min y el nightly lo mataba (exit 124), dejando /almacen/movimientos sin el backstop de
// correcciones viejas. Le damos presupuesto propio SIN tocar su lógica ni recortar la ventana
// 120d. El pase intradía (ventana corta) hereda el override pero termina mucho antes → inocuo.
// Nota: la versión kepler_ods single-DB (mata el fan-out per-branch) es el fix de fondo pendiente.
const STEP_TIMEOUT_OVERRIDE_MIN = { 'import-stock-movements.js': 30 };
const timeoutMinFor = (script) => Math.max(STEP_TIMEOUT_MIN, STEP_TIMEOUT_OVERRIDE_MIN[path.basename(script)] || 0);
// Techo real de duración de un paso (para el sweep de huérfanos): nunca barrer un paso que
// legítimamente puede correr hasta su override (si no, un intraday concurrente mataría el
// stock-movements 120d del nightly a los 13 min).
const MAX_STEP_MIN = Math.max(STEP_TIMEOUT_MIN, ...Object.values(STEP_TIMEOUT_OVERRIDE_MIN));
const DIR = path.join('database', 'importers');
const K = path.join(DIR, 'kepler');
const SCRIPTS = path.join('database', 'scripts');

const STEPS = {
  // LIVE (cada 15-30 min): venta del día → prod. Solo lee mart.ventas_enriched
  // (consolidado local, que ya incluye las camionetas ruta_NN vía el push) → NO
  // toca las 6 sucursales, así que es barato para correr seguido.
  live: [
    path.join(K, 'import-sales-fact.js'),  // mart.ventas_enriched → analytics.sales_daily (Command Center)
    path.join(K, 'import-sales-stats.js'), // sales_daily → ABC/share
    path.join(K, 'import-demand-clean.js'), // RA-PRO.17.1 demanda LIMPIA (revenue÷precio_pieza) → analytics.product_demand (compra/traspaso/ranking) — tras sales-fact
    path.join(K, 'import-replenishment-plan.js'), // RA-PRO.31 fact del pedido (almacén×producto) → /compras/pedido lee de aquí — tras demanda
    path.join(K, 'import-cash-sessions.js'), // SM.10 — cajas ABIERTAS ahora (kp.kdpv_folio_caja, source=kp por default) → /tienda/cajas
  ],
  // LIVEFAST (loop continuo ~60s): la capa COCINADA display-crítica al momento — venta del día
  // (sales_daily → Command Center) + cajas abiertas (/tienda). Subset barato del 'live': lee el
  // consolidado local (RefreshConsolidado @2min) → UPSERT churn-free. NO recalcula demanda/reabasto
  // (eso se queda en 'live' @30min, no cambia por minuto). Lo agenda \Tienda\LiveFastLoop.
  livefast: [
    path.join(K, 'import-sales-fact.js'),    // mart.ventas_enriched → analytics.sales_daily (revenue)
    path.join(K, 'import-cash-sessions.js'), // cajas ABIERTAS ahora → /tienda/cajas
  ],
  stock:   [
    path.join(K, 'import-branch-stock-live.js'),
    path.join(DIR, 'wincaja', 'import-cedis-stock-wincaja.js'), // RA-PRO.24 CEDIS '00' = Wincaja Irapuato (NO Kepler) — tras stock Kepler, ANTES del fact (guard: no borra si Irapuato vacío)
    path.join(K, 'import-replenishment-plan.js'), // RA-PRO.31 refresca el fact tras cambiar existencia
  ],
  // RECEIPTS — la copia se RETIRÓ 2026-08-19 (`analytics.erp_goods_receipts` es VISTA derive-no-copy
  // sobre kepler_ods.kdm1 XA2001 + Wincaja movimiento_proveedores, mig 20260819120000). Lo único que
  // corre acá es el detector de gemelas CEDIS (RE.12): refresca las marcas de dedup en la tabla chica
  // analytics.erp_goods_receipt_dedup que la vista lee por LEFT JOIN (mig 20260820120000). Lee la
  // vista viva y escribe solo la tabla de marcas — NO reconstruye recepciones.
  receipts: [
    path.join(K, 'detect-goods-receipt-duplicates.js'), // RE.12 marca copias CEDIS '00' → erp_goods_receipt_dedup
  ],
  // INTRADAY (cada ~30-60 min): feeds TRANSACCIONALES que cambian a diario y ANTES estaban
  // huérfanos (no en ningún modo → se quedaban viejos). UPSERT churn-free; ventanas rodantes
  // donde aplica (PAYMENTS_DAYS/…). Los agenda \Kepler\Intraday + los vigila el FeedGuardian.
  intraday: [
    // RETIRADO 2026-08-19: erp_supplier_payments y erp_collections son VISTAS derive-no-copy sobre
    // kepler_ods.kdm1 (mig 20260819220000) → se derivan EN VIVO del ODS, sin importer que se atrase.
    // Correr los importers pegaría contra la vista → error. Los .js quedan como fallback histórico.
    path.join(K, 'import-pos-ticket-sales.js'),    // venta de tickets → analytics.pos_ticket_sales
    path.join(K, 'import-kardex.js'),              // movimientos de inventario → analytics.stock_ledger
    path.join(K, 'import-purchase-adjustments.js'), // ajustes de compra → analytics.erp_purchase_adjustments
    // RETIRADO 2026-09-03: import-kepler-bank-movements.js → analytics.kepler_bank_movements ahora es
    // VISTA derive-no-copy sobre kepler_ods.kdm1⋈kdb1 (mig 20260903120000). Cero importer, siempre fresca.
    // CG.16 — Control de CAJA GENERAL (.mdb/Doctos): los GASTOS se capturan/suben al .mdb (no
    // viven en Kepler), así que el importer del .mdb es la fuente válida. Sube a INTRADAY (no solo
    // nightly) para que refresque seguido junto al ritmo del libro. Requiere Z: (.245) montado.
    path.join(DIR, 'movimientos-caja', 'import-caja-general.js'),
    path.join(K, 'import-stock-movements.js'),   // DM — diario de movimientos Kepler (6 sucursales). Ventana rodante STOCK_MOVEMENTS_DAYS (intradía); el nightly hace el pase 120d. Antes SOLO nightly → /almacen/movimientos iba 2 días atrás mientras Wincaja iba al día.
    // RR — ventas por ruta AL DÍA. El reporte /comercial/ventas-por-ruta lee el rollup
    // analytics.sales_by_route_monthly; antes estos feeds SOLO estaban en nightly → el reporte
    // iba ~24h atrás aunque el ORIGEN (.249 mart.ventas del push de camionetas) va al día (cada
    // 15min). Intradía lo refresca cada ~1h. Idempotentes (UPSERT GREATEST); siguen en nightly
    // como respaldo. El push lee local (.249), la vecinal lee md_01.
    path.join(K, 'import-route-push-monthly.js'),    // WIN-<NN> camionetas PH (.249 mart.ventas ruta_NN → mensual)
    path.join(K, 'import-route-push-lines.js'),      // line-level del push → route_push_lines (drill-down del reporte)
    path.join(K, 'import-kepler-vecinal-routes.js'), // WIN-<1V0NN> rutas vecinales PH (md_01 kdm1.c12)
  ],
  nightly: [
    path.join(K, 'import-rotation-from-consolidado.js'),
    path.join(K, 'import-top-sellers-from-consolidado.js'),
    path.join(K, 'import-margin.js'),        // KV.4 markup (lee sucursal) — antes del fact
    path.join(K, 'import-sales-fact.js'),    // KV.1 fact (lee consolidado; cost usa markup)
    path.join(K, 'import-sales-stats.js'),   // KV.2 ABC/share (lee prod sales_daily) — tras sales-fact
    path.join(K, 'import-sales-monthly.js'), // HVT.1 rollup mensual durable (sales_daily → sales_monthly, serie larga + calibración demanda) — tras sales-fact
    path.join(K, 'import-demand-clean.js'),  // RA-PRO.17.1 demanda LIMPIA (revenue÷precio_pieza) → analytics.product_demand — tras sales-fact
    path.join(DIR, 'wincaja', 'import-cedis-stock-wincaja.js'), // RA-PRO.24 CEDIS '00' = Wincaja Irapuato (NO Kepler) — ANTES de inventory-health/DRP/fact (guard: no borra si Irapuato vacío)
    path.join(K, 'import-inventory-health.js'), // KV.5 días cobertura/status (stock × sales_daily); demanda en PIEZAS crudas (canónico, ver import-inventory-health)
    path.join(K, 'import-reorder-policy.js'),   // RA.2 umbrales reorden Kepler (kdii.c33/34/35 → reorder_policy source=kepler)
    path.join(K, 'import-computed-reorder.js'), // RA.3/RA-PRO.1 reorden por demanda + safety stock por nivel de servicio + XYZ — tras inventory-health
    path.join(K, 'import-network-reorder.js'),  // RA-PRO.6 DRP: reorden del CEDIS por demanda dependiente (Σ sucursales) — tras computed-reorder
    // RETIRADO 2026-08-28: import-in-transit — el tránsito (X-A-35 sin X-A-40) se DERIVA del ODS
    // dentro de import-replenishment-plan (CTE `tr`). Mientras fue tabla + importer aparte, el
    // rename qty_in_transit → transit_cajas se comió la conversión de unidad. Ver GOTCHAS §25.
    path.join(K, 'import-auto-received.js'),     // RA.15.1 auto-received: X-A-40 Kepler → cierra nuestras OC abiertas (OE source=kepler, sin mover stock)
    path.join(K, 'import-stock-movements.js'),  // DM — Diario de movimientos (kdm1⋈kdm2 filtrado por doctype.k_binv) → analytics.stock_movements (ventana 120d)
    path.join(K, 'import-purchase-velocity.js'), // RA-PRO.17 velocidad de compra real (entrada X-A-40) → analytics.purchase_velocity — TRAS stock-movements (ancla del sugerido)
    // RETIRADO 2026-08-20: import-erp-promos — analytics.erp_promotions es VISTA derive-no-copy
    // sobre kepler_ods.kdpv_* (mig 20260820160000). Correrlo pegaría TRUNCATE/INSERT contra la vista.
    // RETIRADO 2026-08-20: import-erp-customers — analytics.erp_customers es VISTA derive-no-copy
    // sobre kepler_ods.kdud (mig 20260820150000). Correrlo pegaría INSERT contra la vista → error.
    path.join(K, 'import-customer-sales.js'),// KV.3 historial por cliente (lee consolidado) → analytics.customer_product_sales (fuente RFM de customer_360, CT-C.1b)
    path.join(K, 'import-logistics-dims.js'),// KV.8 dims logística (rutas/choferes/flota)
    // RETIRADO 2026-08-20: import-erp-shipments — analytics.erp_shipments es VISTA derive-no-copy
    // sobre kepler_ods.kdpord (anti-réplica c19=sucursal, mig 20260820170000). No correr contra la vista.
    path.join(K, 'import-product-sales-monthly.js'), // SAL.1 venta mensual x producto (lee 6 sucursales live U/D/10)
    path.join(K, 'import-product-sales-daily.js'), // SAL.5 venta DIARIA x producto (rango 7/15/30d; upsert acumulativo 180d)
    path.join(K, 'import-sales-by-route-monthly.js'), // RR.2 venta mensual x RUTA (serie c63; upsert acumulativo)
    path.join(K, 'import-route-push-monthly.js'), // RR — venta en ruta del PUSH (.249 mart.ventas ruta_NN) → WIN-<NN> (PH migró de .mdb al push, jul→)
    path.join(K, 'import-route-push-lines.js'), // RR — line-level del push (.249) → route_push_lines (drill-down del reporte; incremental)
    path.join(K, 'import-kepler-vecinal-routes.js'), // RR — rutas VECINALES de Kepler (md_01, kdm1.c12=1V0NN) separadas de mostrador → WIN-<code> + route_push_lines
    path.join(K, 'import-canindo-routes-monthly.js'), // RR — rutas de Canindo desde Kepler '06' (c67=500N → WIN-50N); reemplaza el feed Wincaja de '50', mismo namespace → serie continua
    path.join(K, 'repoint-catalog-presence.js'), // catálogo — INSERTA productos nuevos + REACTIVA borrados-vivos desde KP_CONCENTRADA (el snapshot Mega_Dulces se atrasa). ANTES de names/prices para que existan al repuntarlos.
    path.join(K, 'repoint-catalog-names.js'), // catálogo — repoint UPDATE-only de nombres de claves REUSADAS desde KP_CONCENTRADA (catalogo_completo externo se atrasa)
    // catálogo — RELLENO de precio base + recálculo de is_promo. Degradado a --gap-fill-only 2026-08-24:
    // el precio de venta lo lleva `normalizeSalePrice` (ods-derived) AL MOMENTO vía hop-2, porque leer
    // `kdii.c90` como "precio pieza" es un decode equivocado (c90 es el precio de la UNIDAD BASE) y
    // kdii carga 219 tripletas de plantilla que afectan 1,667 SKUs. Este paso ya NO toca precios
    // existentes; sólo rellena huecos y mantiene is_promo.
    // NO agregar acá un feed de precio: nada derivado del ODS se refresca por cron.
    // Ver docs/IMPLEMENTACION/KEPLER_PRECIOS_MODELO.md y feedback_ods_derived_realtime_no_batch_lag.
    [path.join(K, 'repoint-catalog-prices.js'), '--gap-fill-only'],
    path.join(K, 'repoint-catalog-cost.js'), // CANON.0.1 catálogo — SYNC costo (kepler_ods.kdik.c16 mediana retail → cost_base/with_tax/per_case, clamp [1/3,3]× anti-unidad-caja). Mata el escritor de costo de catalog-bulk (.245); nightly lo mantiene fresco entre corridas semanales de catalog. TRAS presence (que los productos existan).
    path.join(K, 'import-transfers-monthly.js'), // T — traspasos NO-venta (salida CEDIS U/D/13 + consolidación UD06 + recepción UA50; upsert acumulativo)
    path.join(K, 'import-expenses-polizas.js'), // GX — egresos contables (pólizas gastos 6xx + compras 5xx) desde kdc2YYMM
    path.join(K, 'import-ap-findings.js'),      // GX v3 — auxiliar de proveedores (201) + hallazgos (iva_bug/203/107)
    path.join(K, 'import-ledger-chain.js'),      // MAAT.1 — balanza fam 1-9 + cadena de gasto → Maat P&L / fiscal / impuestos provisionales
    path.join(K, 'import-expense-requests.js'),  // GX.6 — vínculo solicitud↔gasto (expense_documents.solicitud_*) + hallazgos. `expense_requests` es VISTA (mig 20260819160000); lee de kepler_ods (local, sin timeout) — TRAS expenses-polizas
    path.join(K, 'import-sales-by-channel.js'),  // venta contable 401 reclasificada por canal real (solo CEDIS)
    path.join(K, 'import-cash-cuts.js'),         // SM.1 — cortes/arqueos de caja POS (kdpv_folio_caja)
    // RETIRADO 2026-09-03: import-bank-postings.js → analytics.bank_postings ahora es MATERIALIZED VIEW
    // derive-no-copy sobre kepler_ods.kdc2YYMM vía analytics.bank_postings_src() (mig 20260903130000).
    // La refresca AnalyticsRefreshService (cron 15m). Cero importer.
    path.join(DIR, 'movimientos-caja', 'import-caja-general.js'), // CG — arqueo caja 20 VIVO (BMovimientosCajas, al día) + Base Movimientos (histórico). Idempotente (UPSERT). REQUIERE Z: (.245 \\D) montado en el host del feed + PowerShell/ACE.OLEDB.
    // Feeds antes HUÉRFANOS (nunca agendados → se quedaban viejos). Cadencia diaria correcta.
    path.join(K, 'import-kepler-polizas.js'),    // pólizas contables Kepler (kdc2) → analytics.gl_poliza_*
    path.join(K, 'import-sales-boxes-monthly.js'), // venta en cajas mensual → analytics.sales_boxes_monthly
    path.join(DIR, 'wincaja', 'import-sales-by-vendor-monthly.js'), // AUDIT 2026-08-20 — era HUÉRFANO (648k filas sell-out x vendedor, sin modo ni latido). Al nightly + hereda heartbeat feed_nightly. Idempotente (UPSERT + DELETE-orphan + Canindo remap).
    path.join(K, 'import-pos-cashiers.js'),      // dim cajeros POS → analytics.pos_cashiers
    path.join(K, 'import-supplier-params.js'),   // params de proveedor → catalog.suppliers (UPDATE)
    // RETIRADO 2026-08-26: import-kepler-accounts — finance.kepler_accounts es VISTA derive-no-copy
    // sobre analytics.ledger_monthly (mig 20260826190000). Correrlo pegaría INSERT contra la vista.
    // Pasó el gate de costo: fuente 2,548 filas, paridad 175/175 exacta, misma latencia de lectura.
    path.join(K, 'import-replenishment-cadence.js'), // cadencia de reabasto → commercial.replenishment_channel
    // CT-C.3 — feature store de Thot al nightly (antes eran scripts manuales): afinidad de canasta + demanda por zona
    // + presencia en PdV. Alimentan el score de suggest (afinidad/zona/whitespace) y los findings de distribución.
    path.join(SCRIPTS, 'thot-build-features.js'),     // intelligence.product_affinity (lift market-basket) + zone_demand
    path.join(SCRIPTS, 'thot-build-pdv-presence.js'), // intelligence.pdv_presence (desde capturas Trade)
    path.join(K, 'import-demand-acceleration.js'), // RA-PRO.36 IAD por SKU (−2..+2) para la matriz — tras demanda (usa piece_price)
    path.join(K, 'import-box-factor.js'),          // RA-PRO.37 factor de caja autoritativo (kdii.c84) — ANTES del plan (el uxc lo usa)
    path.join(K, 'import-box-price.js'),           // RA-PRO.39 precio de CJA por producto (kdpv) — base de cajas money-anchored en sell-out
    path.join(K, 'import-label-data.js'),          // Etiquetas de anaquel (kdii c90/91/92 precio pieza/paq/caja) → product_label_prices. ANTES quedaba stale (no estaba en nightly) → precios de anaquel ~10% abajo del Kepler vigente (bug 30061 ago-2026)
    path.join(DIR, 'wincaja', 'import-wincaja-caja-factor.js'), // Factor de caja Wincaja (factor_venta) para MOSTRAR cajas en almacenes ciegos MD-30/32/50 — depende de box-factor(c84)+label(c81). Set doble-testigo (anida+costo=paquete)
    path.join(K, 'import-replenishment-plan.js'), // RA-PRO.31 fact del pedido — AL FINAL (tras demanda/stock/velocity/tránsito/reorden)
    // Norm ALMACÉN Paso 2b (BARRIDO): tras todos los importers, llena warehouse_id NULL de las
    // tablas normalizadas (batch 1 warehouse_code + batch 2 sucursal). Idempotente (solo toca NULL),
    // barato. Batch 1 ya va inline en sus writers; esto cubre batch 2 (~15 importers) sin editarlos +
    // identity.users (app-escrita) + auto-cubre futuros batches. AL FINAL (tras poblarse las filas).
    path.join(SCRIPTS, 'backfill-warehouse-id-batch1.js'),
    path.join(SCRIPTS, 'backfill-warehouse-id-batch2.js'),
  ],
  catalog: [
    path.join(K, 'import-brands-lineas.js'), // líneas kdig → brands nuevas (si falta la línea, el producto se descarta abajo)
    // CANON.0.2 (2026-08-21) — RETIRADOS los 2 escritores .245 (Mega_Dulces) → mata la fuente .245 (7→6):
    //   · import-catalog-bulk.js  — su COSTO ya lo cubre repoint-catalog-cost (CANON.0.1); nombre/precio/
    //     presencia/barcode los cubren los repoints ODS (CANON.1.3). Los campos ESTÁTICOS que solo él
    //     escribía (category_id/description/unit_purchase/factor_purchase/location/loyalty/iva_purchase) se
    //     CONGELAN en su valor actual (cambian poco; category_id ya estaba deprecado/inconsistente).
    //   · import-prices-bulk.js   — tiers P1-P4/MAYOREO = DATO MUERTO (0 clientes fuera de BASE-MXN). Su
    //     único valor, el recálculo de is_promo, se REUBICÓ a repoint-catalog-prices (misma fuente kdii.c90).
    // Ambos .js quedan como fallback manual histórico (y semilla de un futuro mayoreo real desde kdpv_prod_util).
    path.join(K, 'import-kepler-suppliers.js'), // RA — proveedores kdig + products.supplier_id (filtro/sugerido de compras)
  ],
  // KV.8 — logística sola (on-demand): dims. (import-erp-shipments RETIRADO 2026-08-20:
  // analytics.erp_shipments es VISTA derive-no-copy sobre kepler_ods.kdpord, mig 20260820170000
  // → correrlo pegaba INSERT/DEL contra la vista y fallaba. Se derivan en vivo del ODS.)
  logistics: [
    path.join(K, 'import-logistics-dims.js'),
  ],
  // CONTPAQi (cada 1 min): pólizas + bancos INCREMENTALES por firma RowVersion — cada corrida
  // lee solo las firmas (ligero) y trae/UPSERTea solo el delta (insert+update). No machaca el SoR.
  contpaqi: [
    path.join(DIR, 'contpaqi', 'import-contpaqi-polizas.js'),        // → analytics.gl_poliza_* (incremental)
    path.join(DIR, 'contpaqi', 'import-contpaqi-bank-movements.js'), // → analytics.contpaqi_bank_movements (incremental)
  ],
  // CONTPAQi lento (cada ~2h): balanza + proveedores (full, cambian poco). Requiere CONTPAQI_SQL_*.
  'contpaqi-slow': [
    path.join(DIR, 'contpaqi', 'import-contpaqi-ledger.js'),    // → analytics.contpaqi_ledger_monthly (balanza)
    path.join(DIR, 'contpaqi', 'import-contpaqi-suppliers.js'), // → analytics.contpaqi_suppliers (× EFOS)
  ],
  // FINANCE — feeds contables solos (re-run manual). Mismo set que corre en nightly.
  // Todos idempotentes por UPSERT (no DELETE) para no cargar la red de Railway.
  finance: [
    path.join(K, 'import-expenses-polizas.js'),
    path.join(K, 'import-ap-findings.js'),
    path.join(K, 'import-ledger-chain.js'),
    path.join(K, 'import-expense-requests.js'), // tras expenses-polizas (UPDATE a expense_documents)
    path.join(K, 'import-sales-by-channel.js'),
    path.join(K, 'import-cash-cuts.js'),
    // RETIRADO 2026-09-03: import-bank-postings.js → analytics.bank_postings es MATERIALIZED VIEW (mig 20260903130000).
    path.join(DIR, 'movimientos-caja', 'import-caja-general.js'), // CG — arqueo caja 20 vivo + Base Movimientos. Requiere Z: (.245) montado.
  ],
};
STEPS.all = [...STEPS.catalog, ...STEPS.stock, ...STEPS.nightly];

// Etiquetas legibles del latido por modo (Salud BD grupo "Crons"). Los modos AGENDADOS
// se registran además en db-health.service.ts (CRON_JOBS) con su cadencia+umbral → un
// silencio los pinta en ROJO (dead-man's switch). Los modos MANUALES (finance/logistics/
// all) laten también pero, al no estar registrados, el tablero los muestra en verde sin
// alarmar (no tienen cadencia esperada).
const FEED_LABELS = {
  live: 'Feed live (venta viva @30min)',
  livefast: 'Feed livefast (loop ~60s)',
  stock: 'Feed stock (existencia @15min)',
  receipts: 'Feed recepciones (XA2001 @1-2min)',
  intraday: 'Feed intraday (transaccionales @1h)',
  nightly: 'Feed nightly (batch nocturno)',
  catalog: 'Feed catálogo (semanal/diario)',
  contpaqi: 'Feed ContPAQi (pólizas+bancos @1min)',
  'contpaqi-slow': 'Feed ContPAQi lento (balanza+prov @2h)',
  finance: 'Feed finanzas (manual)',
  logistics: 'Feed logística (manual)',
  all: 'Feed all (cutover/manual)',
};

function usage() {
  console.error('Uso: node run-prod-feeds.js <live|stock|nightly|finance|catalog|logistics|all> [--apply]');
  process.exit(2);
}

let currentChild = null;

// Mata un proceso y TODO su árbol (Windows: taskkill /T). SIGKILL solo no basta si el
// importer dejó subprocesos; y un node colgado en un socket muerto ignora SIGTERM.
function killTree(proc) {
  try { proc.kill('SIGKILL'); } catch { /* ya murió */ }
  if (process.platform === 'win32' && proc.pid) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore', timeout: 10000 }); } catch { /* */ }
  }
}

// Una entrada de la lista puede ser una ruta o `[ruta, ...flags]` cuando el script necesita un
// modo distinto del default (ej. repoint-catalog-prices en --gap-fill-only, porque el sync de
// precio lo tomó repoint-prices-from-bitacora).
const pathOf = (entry) => (Array.isArray(entry) ? entry[0] : entry);

function run(entry) {
  return new Promise((resolve) => {
    const script = pathOf(entry);
    const args = [script, ...(Array.isArray(entry) ? entry.slice(1) : [])];
    if (APPLY) args.push('--apply');
    const proc = spawn('node', args, { stdio: 'inherit' });
    currentChild = proc;
    let done = false;
    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      if (currentChild === proc) currentChild = null;
      resolve(code);
    };
    const mins = timeoutMinFor(script);
    const timer = setTimeout(() => {
      console.error(`⏱️  TIMEOUT ${mins} min — ${script} colgado, matando y sigo`);
      killTree(proc);
      finish(124);
    }, mins * 60 * 1000);
    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (e) => { console.error(`No se pudo ejecutar ${script}: ${e.message}`); finish(1); });
  });
}

// Barre node huérfanos de una corrida previa (scripts de ESTE modo, vivos > timeout+3min
// → colgados). El umbral protege una corrida concurrente legítima de otro modo (joven).
// Se apoya en kill-stale-feeds.ps1 (Windows) para evitar el infierno de comillas inline.
// TODO el cuerpo va dentro del try: esto es limpieza best-effort y NO puede tumbar la corrida.
// Lo que pasó el 25 y el 26-ago: `names` se calculaba FUERA del try, tiró ERR_INVALID_ARG_TYPE
// (un step `[ruta, ...flags]` llegando a basename) y se llevó el modo `nightly` entero — y encima
// antes del primer latido, así que ni `cron_runs` registró el intento.
function sweepStaleOrphans(steps) {
  if (process.platform !== 'win32') return;
  try {
    const ps1 = path.join(__dirname, 'kill-stale-feeds.ps1');
    // pathOf: una entrada puede ser `[ruta, ...flags]` (ver arriba); basename() sobre el Array explota.
    const names = [...new Set(steps.map((s) => path.basename(pathOf(s))))].join(',');
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Names', names, '-MaxAgeMin', String(MAX_STEP_MIN + 3), '-SelfPid', String(process.pid)],
      { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '').trim();
    if (out) console.log('🧹 huérfanos previos:\n   ' + out.replace(/\n/g, '\n   '));
  } catch (e) { console.error('sweep huérfanos (no fatal): ' + e.message.slice(0, 100)); }
}

// Si al orquestador lo terminan (Ctrl-C / scheduler), matar el hijo en curso — no
// dejar huérfanos (best-effort; en Windows SIGTERM es limitado pero SIGINT funciona).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (currentChild) killTree(currentChild); process.exit(1); });
}

(async () => {
  const steps = STEPS[MODE];
  if (!steps) usage();

  const LOCAL = process.argv.includes('--local');
  const dst = process.env.DATABASE_URL_NEW || '';
  const isRailway = /proxy\.rlwy\.net|railway/i.test(dst);
  const isLocal = dst === '' || /localhost|127\.0\.0\.1|192\.168\.|::1/i.test(dst);
  // Por default solo-prod (evita pegarle a local sin querer). Pasá --local para poblar
  // la DB de desarrollo (localhost/LAN); en ese caso EXIGE que el target NO sea Railway.
  if (APPLY && !LOCAL && !isRailway) {
    console.error('ABORT: --apply requiere DATABASE_URL_NEW=prod (Railway), o pasá --local para poblar dev. Actual: ' + (dst || '(vacío/default local)'));
    process.exit(3);
  }
  if (APPLY && LOCAL && !isLocal) {
    console.error('ABORT: --local pero DATABASE_URL_NEW no es local/LAN (parece prod). Quitá --local o corregí el target. Actual: ' + dst);
    process.exit(3);
  }
  if (LOCAL) console.log('  modo LOCAL: poblando DB de desarrollo (' + (dst || 'default localhost:5433/postgres_platform') + ')');

  console.log(`\n=== Runner prod feeds — modo "${MODE}" (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${steps.length} paso(s) ===`);

  // El latido va PRIMERO, antes de cualquier otra cosa. Si el runner se cae despues (o se lo
  // matan), queda un latido 'running' que envejece y Salud BD lo marca en rojo por maxRunH: es
  // el dead-man's switch. Cuando el latido iba DESPUES del sweep, el crash del 25 y 26-ago no
  // dejo rastro en cron_runs — el nightly simplemente no existio dos noches y nadie se entero.
  const hbKey = `feed_${MODE}`;
  if (APPLY) await hb.begin(hbKey, FEED_LABELS[MODE] || `Feed ${MODE}`);

  sweepStaleOrphans(steps); // limpia colgados de una corrida previa antes de arrancar

  let failed = 0;
  const failedSteps = [];
  for (const s of steps) {
    console.log(`\n--- ${pathOf(s)} ---`);
    const code = await run(s);
    if (code !== 0) { failed++; failedSteps.push(path.basename(pathOf(s))); console.error(`✗ ${pathOf(s)} salió con código ${code}`); }
  }
  console.log(`\n=== Runner terminó: ${steps.length - failed}/${steps.length} OK ===`);

  // Latido de cierre. status='error' SOLO si el batch entero falló (DB caída / mode roto);
  // una falla PARCIAL (p.ej. 1 paso flaky en el nightly) queda en 'ok' con el detalle en note
  // → visible en el tablero sin disparar alarma crítica por ruido.
  if (APPLY) {
    const total = steps.length;
    const okCount = total - failed;
    await hb.end(hbKey, {
      status: total > 0 && failed === total ? 'error' : 'ok',
      rows: okCount,
      note: `${okCount}/${total} pasos OK`,
      error: failed ? `${failed} paso(s) fallaron: ${failedSteps.join(', ')}`.slice(0, 500) : null,
    });
  }
  process.exit(failed ? 1 : 0);
})();
