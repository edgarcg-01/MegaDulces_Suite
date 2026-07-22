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

const { spawn } = require('node:child_process');
const path = require('node:path');

const MODE = process.argv[2];
const APPLY = process.argv.includes('--apply');
const DIR = path.join('database', 'importers');
const K = path.join(DIR, 'kepler');

const STEPS = {
  // LIVE (cada 15-30 min): venta del día → prod. Solo lee mart.ventas_enriched
  // (consolidado local, que ya incluye las camionetas ruta_NN vía el push) → NO
  // toca las 6 sucursales, así que es barato para correr seguido.
  live: [
    path.join(K, 'import-sales-fact.js'),  // mart.ventas_enriched → analytics.sales_daily (Command Center)
    path.join(K, 'import-sales-stats.js'), // sales_daily → ABC/share
  ],
  stock:   [path.join(K, 'import-branch-stock-live.js')],
  nightly: [
    path.join(K, 'import-rotation-from-consolidado.js'),
    path.join(K, 'import-top-sellers-from-consolidado.js'),
    path.join(K, 'import-margin.js'),        // KV.4 markup (lee sucursal) — antes del fact
    path.join(K, 'import-sales-fact.js'),    // KV.1 fact (lee consolidado; cost usa markup)
    path.join(K, 'import-sales-stats.js'),   // KV.2 ABC/share (lee prod sales_daily) — tras sales-fact
    path.join(K, 'import-inventory-health.js'), // KV.5 días cobertura/status (stock × sales_daily)
    path.join(K, 'import-reorder-policy.js'),   // RA.2 umbrales reorden Kepler (kdii.c33/34/35 → reorder_policy source=kepler)
    path.join(K, 'import-computed-reorder.js'), // RA.3/RA-PRO.1 reorden por demanda + safety stock por nivel de servicio + XYZ — tras inventory-health
    path.join(K, 'import-network-reorder.js'),  // RA-PRO.6 DRP: reorden del CEDIS por demanda dependiente (Σ sucursales) — tras computed-reorder
    path.join(K, 'import-in-transit.js'),       // RA.5 OC en tránsito (X-A-35 sin X-A-40) → analytics.purchase_in_transit (resta del sugerido)
    path.join(K, 'import-auto-received.js'),     // RA.15.1 auto-received: X-A-40 Kepler → cierra nuestras OC abiertas (OE source=kepler, sin mover stock)
    path.join(K, 'import-stock-movements.js'),  // DM — Diario de movimientos (kdm1⋈kdm2 filtrado por doctype.k_binv) → analytics.stock_movements (ventana 120d)
    path.join(K, 'import-erp-promos.js'),    // KV.6 promos vigentes (lee sucursal)
    path.join(K, 'import-erp-customers.js'), // KV.3 dim clientes (lee 6 sucursales)
    path.join(K, 'import-customer-sales.js'),// KV.3 historial por cliente (lee consolidado)
    path.join(K, 'import-logistics-dims.js'),// KV.8 dims logística (rutas/choferes/flota)
    path.join(K, 'import-erp-shipments.js'), // KV.8 embarques reales (kdpord)
    path.join(K, 'import-product-sales-monthly.js'), // SAL.1 venta mensual x producto (lee 6 sucursales live U/D/10)
    path.join(K, 'import-product-sales-daily.js'), // SAL.5 venta DIARIA x producto (rango 7/15/30d; upsert acumulativo 180d)
    path.join(K, 'import-sales-by-route-monthly.js'), // RR.2 venta mensual x RUTA (serie c63; upsert acumulativo)
    path.join(K, 'import-transfers-monthly.js'), // T — traspasos NO-venta (salida CEDIS U/D/13 + consolidación UD06 + recepción UA50; upsert acumulativo)
    path.join(K, 'import-expenses-polizas.js'), // GX — egresos contables (pólizas gastos 6xx + compras 5xx) desde kdc2YYMM
    path.join(K, 'import-ap-findings.js'),      // GX v3 — auxiliar de proveedores (201) + hallazgos (iva_bug/203/107)
    path.join(K, 'import-ledger-chain.js'),      // MAAT.1 — balanza fam 1-9 + cadena de gasto → Maat P&L / fiscal / impuestos provisionales
    path.join(K, 'import-expense-requests.js'),  // GX.6 — solicitudes XA1501 (+UPDATE a expense_documents) — TRAS expenses-polizas
    path.join(K, 'import-sales-by-channel.js'),  // venta contable 401 reclasificada por canal real (solo CEDIS)
    path.join(K, 'import-cash-cuts.js'),         // SM.1 — cortes/arqueos de caja POS (kdpv_folio_caja)
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
  // FINANCE — feeds contables solos (re-run manual). Mismo set que corre en nightly.
  // Todos idempotentes por UPSERT (no DELETE) para no cargar la red de Railway.
  finance: [
    path.join(K, 'import-expenses-polizas.js'),
    path.join(K, 'import-ap-findings.js'),
    path.join(K, 'import-ledger-chain.js'),
    path.join(K, 'import-expense-requests.js'), // tras expenses-polizas (UPDATE a expense_documents)
    path.join(K, 'import-sales-by-channel.js'),
    path.join(K, 'import-cash-cuts.js'),
  ],
};
STEPS.all = [...STEPS.catalog, ...STEPS.stock, ...STEPS.nightly];

function usage() {
  console.error('Uso: node run-prod-feeds.js <live|stock|nightly|finance|catalog|logistics|all> [--apply]');
  process.exit(2);
}

function run(script) {
  return new Promise((resolve) => {
    const args = [script];
    if (APPLY) args.push('--apply');
    const proc = spawn('node', args, { stdio: 'inherit' });
    proc.on('close', (code) => resolve(code ?? 1));
    proc.on('error', (e) => { console.error(`No se pudo ejecutar ${script}: ${e.message}`); resolve(1); });
  });
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
  let failed = 0;
  for (const s of steps) {
    console.log(`\n--- ${s} ---`);
    const code = await run(s);
    if (code !== 0) { failed++; console.error(`✗ ${s} salió con código ${code}`); }
  }
  console.log(`\n=== Runner terminó: ${steps.length - failed}/${steps.length} OK ===`);
  process.exit(failed ? 1 : 0);
})();
