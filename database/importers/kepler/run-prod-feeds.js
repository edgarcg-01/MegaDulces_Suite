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

const MODE = process.argv[2];
const APPLY = process.argv.includes('--apply');
// Timeout por importer. Un importer sano termina en minutos; un cuelgue (ECONNRESET a
// prod sin timeout de socket) es INFINITO y trababa todo el batch → el scheduler lo
// mataba a los 20min dejando node huérfanos que bloqueaban las corridas siguientes
// (incidente 2026-08-05). Con esto, un paso colgado se mata y el batch sigue.
const STEP_TIMEOUT_MIN = Number(process.env.FEED_STEP_TIMEOUT_MIN) || 10;
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
  // RECEIPTS (cada 1-2 min): detecta órdenes de entrada XA2001 nuevas en las sucursales Kepler
  // y las empuja a Railway por feeds-ingest (ingress gratis). Ventana rodante vía RECEIPTS_DAYS.
  receipts: [
    path.join(K, 'import-goods-receipts.js'),
  ],
  // INTRADAY (cada ~30-60 min): feeds TRANSACCIONALES que cambian a diario y ANTES estaban
  // huérfanos (no en ningún modo → se quedaban viejos). UPSERT churn-free; ventanas rodantes
  // donde aplica (PAYMENTS_DAYS/…). Los agenda \Kepler\Intraday + los vigila el FeedGuardian.
  intraday: [
    path.join(K, 'import-supplier-payments.js'),  // CxP → analytics.erp_supplier_payments (/finanzas/pagos-comprobantes)
    path.join(K, 'import-collections.js'),         // cobranza → analytics.erp_collections (fichas de depósito)
    path.join(K, 'import-pos-ticket-sales.js'),    // venta de tickets → analytics.pos_ticket_sales
    path.join(K, 'import-kardex.js'),              // movimientos de inventario → analytics.stock_ledger
    path.join(K, 'import-purchase-adjustments.js'), // ajustes de compra → analytics.erp_purchase_adjustments
    path.join(K, 'import-kepler-bank-movements.js'), // CB 3ª fuente: bancos Kepler por cuenta (kdm1⋈kdb1) → analytics.kepler_bank_movements
    path.join(K, 'import-stock-movements.js'),   // DM — diario de movimientos Kepler (6 sucursales). Ventana rodante STOCK_MOVEMENTS_DAYS (intradía); el nightly hace el pase 120d. Antes SOLO nightly → /almacen/movimientos iba 2 días atrás mientras Wincaja iba al día.
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
    path.join(K, 'import-in-transit.js'),       // RA.5 OC en tránsito (X-A-35 sin X-A-40) → analytics.purchase_in_transit (resta del sugerido)
    path.join(K, 'import-auto-received.js'),     // RA.15.1 auto-received: X-A-40 Kepler → cierra nuestras OC abiertas (OE source=kepler, sin mover stock)
    path.join(K, 'import-stock-movements.js'),  // DM — Diario de movimientos (kdm1⋈kdm2 filtrado por doctype.k_binv) → analytics.stock_movements (ventana 120d)
    path.join(K, 'import-purchase-velocity.js'), // RA-PRO.17 velocidad de compra real (entrada X-A-40) → analytics.purchase_velocity — TRAS stock-movements (ancla del sugerido)
    path.join(K, 'import-erp-promos.js'),    // KV.6 promos vigentes (lee sucursal)
    path.join(K, 'import-erp-customers.js'), // KV.3 dim clientes (lee 6 sucursales)
    path.join(K, 'import-customer-sales.js'),// KV.3 historial por cliente (lee consolidado) → analytics.customer_product_sales (fuente RFM de customer_360, CT-C.1b)
    path.join(K, 'import-logistics-dims.js'),// KV.8 dims logística (rutas/choferes/flota)
    path.join(K, 'import-erp-shipments.js'), // KV.8 embarques reales (kdpord)
    path.join(K, 'import-product-sales-monthly.js'), // SAL.1 venta mensual x producto (lee 6 sucursales live U/D/10)
    path.join(K, 'import-product-sales-daily.js'), // SAL.5 venta DIARIA x producto (rango 7/15/30d; upsert acumulativo 180d)
    path.join(K, 'import-sales-by-route-monthly.js'), // RR.2 venta mensual x RUTA (serie c63; upsert acumulativo)
    path.join(K, 'import-route-push-monthly.js'), // RR — venta en ruta del PUSH (.249 mart.ventas ruta_NN) → WIN-<NN> (PH migró de .mdb al push, jul→)
    path.join(K, 'import-route-push-lines.js'), // RR — line-level del push (.249) → route_push_lines (drill-down del reporte; incremental)
    path.join(K, 'import-kepler-vecinal-routes.js'), // RR — rutas VECINALES de Kepler (md_01, kdm1.c12=1V0NN) separadas de mostrador → WIN-<code> + route_push_lines
    path.join(K, 'repoint-catalog-presence.js'), // catálogo — INSERTA productos nuevos + REACTIVA borrados-vivos desde KP_CONCENTRADA (el snapshot Mega_Dulces se atrasa). ANTES de names/prices para que existan al repuntarlos.
    path.join(K, 'repoint-catalog-names.js'), // catálogo — repoint UPDATE-only de nombres de claves REUSADAS desde KP_CONCENTRADA (catalogo_completo externo se atrasa)
    path.join(K, 'repoint-catalog-prices.js'), // catálogo — SYNC precio base (KP_CONCENTRADA c90 → BASE-MXN, Kepler autoridad, churn-free; piso anti-promo c90>0.05)
    path.join(K, 'import-transfers-monthly.js'), // T — traspasos NO-venta (salida CEDIS U/D/13 + consolidación UD06 + recepción UA50; upsert acumulativo)
    path.join(K, 'import-expenses-polizas.js'), // GX — egresos contables (pólizas gastos 6xx + compras 5xx) desde kdc2YYMM
    path.join(K, 'import-ap-findings.js'),      // GX v3 — auxiliar de proveedores (201) + hallazgos (iva_bug/203/107)
    path.join(K, 'import-ledger-chain.js'),      // MAAT.1 — balanza fam 1-9 + cadena de gasto → Maat P&L / fiscal / impuestos provisionales
    path.join(K, 'import-expense-requests.js'),  // GX.6 — solicitudes XA1501 (+UPDATE a expense_documents) — TRAS expenses-polizas
    path.join(K, 'import-sales-by-channel.js'),  // venta contable 401 reclasificada por canal real (solo CEDIS)
    path.join(K, 'import-cash-cuts.js'),         // SM.1 — cortes/arqueos de caja POS (kdpv_folio_caja)
    path.join(K, 'import-bank-postings.js'),     // CB.4.1 — postings 102 Kepler (matching banco↔libro conciliación bancaria)
    path.join(DIR, 'movimientos-caja', 'import-caja-general.js'), // CG — arqueo caja 20 VIVO (BMovimientosCajas, al día) + Base Movimientos (histórico). Idempotente (UPSERT). REQUIERE Z: (.245 \\D) montado en el host del feed + PowerShell/ACE.OLEDB.
    // Feeds antes HUÉRFANOS (nunca agendados → se quedaban viejos). Cadencia diaria correcta.
    path.join(K, 'import-kepler-polizas.js'),    // pólizas contables Kepler (kdc2) → analytics.gl_poliza_*
    path.join(K, 'import-sales-boxes-monthly.js'), // venta en cajas mensual → analytics.sales_boxes_monthly
    path.join(K, 'import-pos-cashiers.js'),      // dim cajeros POS → analytics.pos_cashiers
    path.join(K, 'import-supplier-params.js'),   // params de proveedor → catalog.suppliers (UPDATE)
    path.join(K, 'import-kepler-accounts.js'),   // dim cuentas contables → finance.kepler_accounts
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
  ],
  catalog: [
    path.join(K, 'import-brands-lineas.js'), // líneas kdig → brands nuevas (si falta la línea, el producto se descarta abajo)
    path.join(DIR, 'import-catalog-bulk.js'),
    path.join(DIR, 'import-prices-bulk.js'),
    path.join(K, 'import-kepler-suppliers.js'), // RA — proveedores kdig + products.supplier_id (filtro/sugerido de compras)
  ],
  // KV.8 — logística sola (on-demand): dims + embarques.
  logistics: [
    path.join(K, 'import-logistics-dims.js'),
    path.join(K, 'import-erp-shipments.js'),
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
    path.join(K, 'import-bank-postings.js'),
    path.join(DIR, 'movimientos-caja', 'import-caja-general.js'), // CG — arqueo caja 20 vivo + Base Movimientos. Requiere Z: (.245) montado.
  ],
};
STEPS.all = [...STEPS.catalog, ...STEPS.stock, ...STEPS.nightly];

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

function run(script) {
  return new Promise((resolve) => {
    const args = [script];
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
    const timer = setTimeout(() => {
      console.error(`⏱️  TIMEOUT ${STEP_TIMEOUT_MIN} min — ${script} colgado, matando y sigo`);
      killTree(proc);
      finish(124);
    }, STEP_TIMEOUT_MIN * 60 * 1000);
    proc.on('close', (code) => finish(code ?? 1));
    proc.on('error', (e) => { console.error(`No se pudo ejecutar ${script}: ${e.message}`); finish(1); });
  });
}

// Barre node huérfanos de una corrida previa (scripts de ESTE modo, vivos > timeout+3min
// → colgados). El umbral protege una corrida concurrente legítima de otro modo (joven).
// Se apoya en kill-stale-feeds.ps1 (Windows) para evitar el infierno de comillas inline.
function sweepStaleOrphans(steps) {
  if (process.platform !== 'win32') return;
  const ps1 = path.join(__dirname, 'kill-stale-feeds.ps1');
  const names = [...new Set(steps.map((s) => path.basename(s)))].join(',');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
      '-Names', names, '-MaxAgeMin', String(STEP_TIMEOUT_MIN + 3), '-SelfPid', String(process.pid)],
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
  sweepStaleOrphans(steps); // limpia colgados de una corrida previa antes de arrancar
  let failed = 0;
  for (const s of steps) {
    console.log(`\n--- ${s} ---`);
    const code = await run(s);
    if (code !== 0) { failed++; console.error(`✗ ${s} salió con código ${code}`); }
  }
  console.log(`\n=== Runner terminó: ${steps.length - failed}/${steps.length} OK ===`);
  process.exit(failed ? 1 : 0);
})();
