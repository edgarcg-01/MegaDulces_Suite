/* eslint-disable no-console */
/**
 * Orquestador del RUNNER ON-PREM → prod (Railway). Punto de entrada único para el
 * Task Scheduler de Windows. Corre los importers bulk como subprocesos, en orden,
 * con el env ya cargado. NO contiene lógica de negocio (cada importer es la fuente
 * de verdad); solo secuencia + guardas.
 *
 * Modos:
 *   node database/importers/kepler/run-prod-feeds.js stock     # stock 6 sucursales (cada 30 min)
 *   node database/importers/kepler/run-prod-feeds.js nightly   # rotación + top-sellers (nightly)
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
  stock:   [path.join(K, 'import-branch-stock-live.js')],
  nightly: [
    path.join(K, 'import-rotation-from-consolidado.js'),
    path.join(K, 'import-top-sellers-from-consolidado.js'),
    path.join(K, 'import-margin.js'),        // KV.4 markup (lee sucursal) — antes del fact
    path.join(K, 'import-sales-fact.js'),    // KV.1 fact (lee consolidado; cost usa markup)
    path.join(K, 'import-sales-stats.js'),   // KV.2 ABC/share (lee prod sales_daily) — tras sales-fact
    path.join(K, 'import-inventory-health.js'), // KV.5 días cobertura/status (stock × sales_daily)
    path.join(K, 'import-erp-promos.js'),    // KV.6 promos vigentes (lee sucursal)
    path.join(K, 'import-erp-customers.js'), // KV.3 dim clientes (lee 6 sucursales)
    path.join(K, 'import-customer-sales.js'),// KV.3 historial por cliente (lee consolidado)
    path.join(K, 'import-logistics-dims.js'),// KV.8 dims logística (rutas/choferes/flota)
    path.join(K, 'import-erp-shipments.js'), // KV.8 embarques reales (kdpord)
    path.join(K, 'import-product-sales-monthly.js'), // SAL.1 venta mensual x producto (lee 6 sucursales live U/D/10)
    path.join(K, 'import-product-sales-daily.js'), // SAL.5 venta DIARIA x producto (rango 7/15/30d; upsert acumulativo 180d)
    path.join(K, 'import-sales-by-route-monthly.js'), // RR.2 venta mensual x RUTA (serie c63; upsert acumulativo)
    path.join(K, 'import-transfers-monthly.js'), // T — traspasos NO-venta (salida CEDIS U/D/13 + consolidación UD06 + recepción UA50; upsert acumulativo)
  ],
  catalog: [
    path.join(DIR, 'import-catalog-bulk.js'),
    path.join(DIR, 'import-prices-bulk.js'),
  ],
  // KV.8 — logística sola (on-demand): dims + embarques.
  logistics: [
    path.join(K, 'import-logistics-dims.js'),
    path.join(K, 'import-erp-shipments.js'),
  ],
};
STEPS.all = [...STEPS.catalog, ...STEPS.stock, ...STEPS.nightly];

function usage() {
  console.error('Uso: node run-prod-feeds.js <stock|nightly|catalog|logistics|all> [--apply]');
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

  const dst = process.env.DATABASE_URL_NEW || '';
  if (APPLY && !/proxy\.rlwy\.net|railway/i.test(dst)) {
    console.error('ABORT: --apply requiere DATABASE_URL_NEW apuntando a prod (Railway). Actual: ' + (dst || '(vacío)'));
    process.exit(3);
  }

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
