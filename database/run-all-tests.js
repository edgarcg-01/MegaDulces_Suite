/* eslint-disable no-console */
/**
 * Runner agregado: corre todos los smoke tests en secuencia y reporta total.
 *
 * Categorías:
 *   1. DB direct (knex sin API) — Sprints A.0mt, B.0
 *   2. HTTP E2E (requiere API en :3334) — Sprints B.1+, C.*
 *
 * Para correr esto, el API debe estar arriba en :3334 con ENABLE_MULTITENANT=true.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  // DB direct (no requieren API)
  { file: 'test-newdb-tenant-context.js', label: 'A.0mt.1 tenant context', needsApi: false },
  { file: 'test-newdb-rls-isolation.js', label: 'A.0mt.2 RLS isolation', needsApi: false },
  { file: 'test-newdb-auth-multitenant.js', label: 'A.0mt.3 auth multi-tenant', needsApi: false },
  { file: 'test-newdb-orders-flow.js', label: 'B.2 orders state machine', needsApi: false },
  { file: 'test-newdb-orders-with-testdata.js', label: 'B.3.2 multi-line order', needsApi: false },
  { file: 'test-newdb-inventory-count.js', label: 'I.1 inventario físico (folio+snapshot+conteo ciego+coverage+freeze+reconcile)', needsApi: false },
  // HTTP E2E (requieren API)
  { file: 'http-inventory-count-test.js', label: 'I.5 conteo correctness (A1 freeze guard + A2 no-revierte + A4 segregación count_3)', needsApi: true },
  { file: 'http-inventory-abc-test.js', label: 'I.6 clasificación ABC (refresh + shape + filtro por clase)', needsApi: true },
  { file: 'http-inventory-cycle-count-test.js', label: 'I.7 conteo cíclico acotado (open-cycle por clase/lista)', needsApi: true },
  { file: 'http-inventory-aisles-test.js', label: 'PA.1 pasillos 2D (CRUD + mapeo bulk SKU→pasillo + carga)', needsApi: true },
  { file: 'http-inventory-aisle-teams-test.js', label: 'PA.3 tablero de equipos por folio (board + generar parejo + set manual)', needsApi: true },
  { file: 'http-e2e-test.js', label: 'B.1 HTTP CRUD + order flow', needsApi: true },
  { file: 'http-carga-load-status-test.js', label: 'Carga: checklist sí/no cargamos (load-status E2E)', needsApi: true },
  { file: 'http-tenant-isolation-test.js', label: 'B HTTP tenant isolation', needsApi: true },
  { file: 'http-analytics-test.js', label: 'C.0 analytics endpoints', needsApi: true },
  { file: 'http-analytics-mv-test.js', label: 'C.1 materialized views', needsApi: true },
  { file: 'http-alerts-ws-test.js', label: 'C.4 alerts WS realtime', needsApi: true },
  { file: 'http-portal-b2b-test.js', label: 'D.1 portal B2B + audit history', needsApi: true },
  { file: 'http-recommendations-test.js', label: 'D.4 recommendations basket', needsApi: true },
  { file: 'http-intelligence-test.js', label: 'M Motor de Inteligencia (Customer360+NBA+agente+feedback)', needsApi: true },
  // Fase J — Logística
  { file: 'test-logistics-rls-smoke.js', label: 'J.0 logistics RLS isolation', needsApi: false },
  { file: 'http-logistics-e2e-test.js', label: 'J.1 logistics modules E2E (fleet+shipments+guides+expenses+payroll)', needsApi: true },
  { file: 'http-logistics-analytics-test.js', label: 'J.5 logistics analytics (overview, profitability, fleet, payroll)', needsApi: true },
  { file: 'http-shipment-hook-fulfill-test.js', label: 'J.6.1 hook close→fulfilled consume stock (FIX)', needsApi: true },
  { file: 'http-logistics-j8-test.js', label: 'J.8 migración repo (state machine 7 estados, checklists, photos, reports jspdf)', needsApi: true },
  { file: 'http-logistics-j9-test.js', label: 'J.9 UI port (endpoints dashboard/staff/guides/costs)', needsApi: true },
  { file: 'http-j10-order-tracking-test.js', label: 'J.10 order tracking (commercial/orders/:id/shipments)', needsApi: true },
  // Fase K — AI product match en captures
  { file: 'http-ai-match-test.js', label: 'K.1 AI product match (Claude Haiku + Voyage + pgvector)', needsApi: true },
  // Cierre de ruta (port Automation_RD)
  { file: 'test-route-tickets-rls-smoke.js', label: 'RD route_tickets RLS isolation', needsApi: false },
  { file: 'http-route-tickets-test.js', label: 'RD cierre de ruta E2E (3 tickets + reportes)', needsApi: true },
  // Captura de vendedor — cadena post-OCR (bridge alias + venta + visita sin ponderación)
  { file: 'http-vendor-capture-e2e-test.js', label: 'VC captura vendedor E2E (alias código→planograma + venta + visita)', needsApi: true },
  // Apartado Rutas — detalle por ruta (tiendas/cobertura + tiempos + trazabilidad)
  { file: 'http-routes-analysis-test.js', label: 'Rutas: detalle por ruta (visits tiempos+GPS, stores cobertura)', needsApi: true },
  // Mapa Comercial — tiendas geolocalizadas + historial propio vs competencia
  { file: 'http-commercial-map-test.js', label: 'Mapa Comercial: stores (coord híbrida + presencia) + history (propio/competencia)', needsApi: true },
  // V.6 Modo Vendedor — autodetección de llegada (nearby + anti-traslape + backfill capture-on-visit)
  { file: 'http-vendor-geo-test.js', label: 'V.6 autodetección llegada (nearby ranked + guard anti-traslape + check-in backfill)', needsApi: true },
  // Thot T.1 — recomendación producto-first (afinidad market-basket + zona + rotación + margen)
  { file: 'http-thot-test.js', label: 'Thot T.1 suggest (afinidad cart-aware + zona + rotación·margen, sin basura)', needsApi: true },
  // Thot T.2 — empuje dirigido (marca foco): el negocio decide qué empujar
  { file: 'http-thot-directives-test.js', label: 'Thot T.2 empuje dirigido (directriz marca foco → suggest reason=estrategia)', needsApi: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Suites que disparan el tier `short`/`long` del throttler global y necesitan
// el reset del bucket (ttl 60s) antes de correr. Si no esperamos, llegan al
// PRIMER request con 429 porque las suites previas agotaron la cuota.
const NEEDS_THROTTLE_COOLDOWN = new Set([
  'http-analytics-mv-test.js',  // C.1 — POST /refresh tiene @Throttle short: 3/60s
  'http-ai-match-test.js',      // K.1 — @Throttle long: 10/60s, además testea el 429 internamente
]);

(async () => {
  const root = path.resolve(__dirname);
  const results = [];
  const useThrottleBypass = process.env.THROTTLE_DISABLED === 'true';
  if (useThrottleBypass) {
    console.log('THROTTLE_DISABLED=true — API debería estar arriba con skipIf activo, sin cooldowns.');
  }

  for (const t of TESTS) {
    if (t.needsApi && !useThrottleBypass && NEEDS_THROTTLE_COOLDOWN.has(t.file)) {
      process.stdout.write(`\n⏸ throttle cooldown 65s antes de ${t.label}...\n`);
      await sleep(65_000);
    } else if (t.needsApi) {
      // Pequeña pausa entre suites HTTP para no agotar el tier short (10/s).
      await sleep(1_500);
    }
    const filePath = path.join(root, 'tests', t.file);
    process.stdout.write(`\n━━━ ${t.label} (${t.file}) ━━━\n`);
    const start = Date.now();
    const r = spawnSync('node', [filePath], {
      cwd: path.resolve(root, '..'),
      stdio: 'inherit',
      env: process.env,
    });
    const ms = Date.now() - start;
    results.push({
      label: t.label,
      file: t.file,
      exit: r.status,
      ok: r.status === 0,
      ms,
    });
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                  RESUMEN DE SUITES                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`${status} ${r.label.padEnd(40)} ${r.ms}ms`);
    if (r.ok) okCount++;
    else failCount++;
  }
  console.log(`\nTotal: ${okCount}/${results.length} suites verde, ${failCount} fallaron.`);

  if (failCount > 0) {
    console.log('\n┌── HINTS MEMORIALES (si viste alguno de estos patterns arriba) ──────────');
    console.log('│');
    console.log('│  Connection refused / ECONNREFUSED');
    console.log('│    → API no está arriba en :3334. nx serve api con ENABLE_MULTITENANT=true.');
    console.log('│');
    console.log('│  23502 not-null violation column "tenant_id"');
    console.log('│    → trigger auto_populate_tenant_id no aplicado en la tabla. Ver memoria');
    console.log('│      feedback_auto_populate_trigger_prod. Fix: migración 20260606000000.');
    console.log('│');
    console.log('│  25P02 in_failed_sql_transaction');
    console.log('│    → un catch que tragó error DB dejó la trx en estado falla y siguió.');
    console.log('│      Ver memoria feedback_global_request_tx_25p02. Fix: savepoint.');
    console.log('│');
    console.log('│  permission denied for table / RLS 0 rows con data presente');
    console.log('│    → request handler no usa TenantKnexService.run() → app_runtime ve 0.');
    console.log('│      Ver memoria feedback_tenant_knex_rls. Fix: envolver query en run().');
    console.log('│');
    console.log('│  403 "permisos dinámicos" para rol con permiso correcto en JWT');
    console.log('│    → permission nuevo SIN map en permissionToSubject / permissionToAction');
    console.log('│      en apps/api/.../ability.factory.ts. Ver memoria feedback_ability_factory_mapping.');
    console.log('│');
    console.log('│  column "activo" can only be updated to DEFAULT');
    console.log('│    → writes a columna GENERATED ALWAYS AS (deleted_at IS NULL). Fix:');
    console.log('│      usar deleted_at:NOW() / null. Ver memoria feedback_activo_generated_pattern.');
    console.log('│');
    console.log('│  429 Too Many Requests / ThrottlerException');
    console.log('│    → tier short (10/s) o long (10/60s) agotado. Correr con THROTTLE_DISABLED=true');
    console.log('│      o agregar la suite a NEEDS_THROTTLE_COOLDOWN en run-all-tests.js.');
    console.log('│');
    console.log('│  401 / JWT secret invalid / signature verification failed');
    console.log('│    → JWT_SECRET mismatch entre cliente y server. Arrancar API con');
    console.log('│      JWT_SECRET= explícito en env hasta fix de boot order. Ver memoria');
    console.log('│      project_trade_marketing_b2b_evolution (gaps verificación HTTP E2E).');
    console.log('│');
    console.log('│  "directory corrupt" durante migrate / knex_migrations mismatch');
    console.log('│    → fila en knex_migrations sin archivo en filesystem. Ver memoria');
    console.log('│      feedback_no_manual_knex_migrations_prod. NUNCA INSERT manual.');
    console.log('│');
    console.log('│  ¿Otro patron? Buscá en ~/.claude/projects/.../memory/ con grep antes de debuggear.');
    console.log('└─────────────────────────────────────────────────────────────────────────');
  }

  process.exit(failCount === 0 ? 0 : 1);
})();
