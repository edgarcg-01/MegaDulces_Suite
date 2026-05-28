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
  // HTTP E2E (requieren API)
  { file: 'http-e2e-test.js', label: 'B.1 HTTP CRUD + order flow', needsApi: true },
  { file: 'http-tenant-isolation-test.js', label: 'B HTTP tenant isolation', needsApi: true },
  { file: 'http-analytics-test.js', label: 'C.0 analytics endpoints', needsApi: true },
  { file: 'http-analytics-mv-test.js', label: 'C.1 materialized views', needsApi: true },
  { file: 'http-alerts-ws-test.js', label: 'C.4 alerts WS realtime', needsApi: true },
  { file: 'http-portal-b2b-test.js', label: 'D.1 portal B2B + audit history', needsApi: true },
  { file: 'http-recommendations-test.js', label: 'D.4 recommendations basket', needsApi: true },
  // Fase J — Logística
  { file: 'test-logistics-rls-smoke.js', label: 'J.0 logistics RLS isolation', needsApi: false },
  { file: 'http-logistics-e2e-test.js', label: 'J.1 logistics modules E2E (fleet+shipments+guides+expenses+payroll)', needsApi: true },
  { file: 'http-logistics-analytics-test.js', label: 'J.5 logistics analytics (overview, profitability, fleet, payroll)', needsApi: true },
  { file: 'http-shipment-hook-fulfill-test.js', label: 'J.6.1 hook close→fulfilled consume stock (FIX)', needsApi: true },
  { file: 'http-logistics-j8-test.js', label: 'J.8 migración repo (state machine 7 estados, checklists, photos, reports jspdf)', needsApi: true },
  { file: 'http-logistics-j9-test.js', label: 'J.9 UI port (endpoints dashboard/staff/guides/costs)', needsApi: true },
  // Fase K — AI product match en captures
  { file: 'http-ai-match-test.js', label: 'K.1 AI product match (Claude Haiku + Voyage + pgvector)', needsApi: true },
];

(async () => {
  const root = path.resolve(__dirname);
  const results = [];

  for (const t of TESTS) {
    const filePath = path.join(root, t.file);
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
  process.exit(failCount === 0 ? 0 : 1);
})();
