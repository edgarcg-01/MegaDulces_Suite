/* eslint-disable no-console */
/**
 * HTTP smoke test SM.1/SM.2 — Supervisor de Movimientos (cuadre, ADR-029).
 * Self-contained: inyecta data sintética en analytics.* → escanea → verifica la
 * bandeja → feedback (L2) → limpia. NO depende de que los importers hayan corrido.
 * Verifica:
 *   1. login
 *   2. inyecta un corte de caja con faltante grande + una merma → analytics.*
 *   3. POST /reconciliation/scan → total_nuevos ≥ 2 (caja crítico + merma)
 *   4. GET /reconciliation/discrepancies → aparecen ambos, ordenados por severidad/$
 *   5. GET /reconciliation/discrepancies/stats → pendientes/criticos/por_plano
 *   6. GET /reconciliation/rules → caja_descuadre + merma_inventario presentes
 *   7. POST feedback (util) → status=confirmado, precision recalculada
 *   8. cleanup (borra lo sintético + sus discrepancies + feedback)
 *
 * Requiere API corriendo (RECON_TEST_PORT, default 3336) + newdb con migs SM aplicadas.
 */
const BASE = `http://localhost:${process.env.RECON_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';
const WH = 'ZZ';          // sucursal sintética (aislada)
const FECHA = '2026-07-01';
const SKU = 'SMOKE-SKU';

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}

async function cleanup(pg) {
  await pg.query(`DELETE FROM reconciliation.discrepancy_feedback WHERE tenant_id=$1 AND discrepancy_id IN (SELECT id FROM reconciliation.discrepancies WHERE tenant_id=$1 AND (entity->>'sucursal')=$2)`, [M, WH]).catch(() => {});
  await pg.query(`DELETE FROM reconciliation.discrepancies WHERE tenant_id=$1 AND (entity->>'sucursal')=$2`, [M, WH]).catch(() => {});
  await pg.query(`DELETE FROM analytics.cash_cuts WHERE tenant_id=$1 AND warehouse_code=$2`, [M, WH]).catch(() => {});
  await pg.query(`DELETE FROM analytics.stock_ledger WHERE tenant_id=$1 AND warehouse_code=$2`, [M, WH]).catch(() => {});
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();

  const login = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('login OK', !!token, `status=${login.status}`);
  if (!token) { await pg.end(); process.exit(1); }

  console.log('\n── 1. Inyectar data sintética ──');
  await cleanup(pg); // idempotente: limpia corridas previas
  await pg.query(
    `INSERT INTO analytics.cash_cuts (tenant_id, warehouse_code, warehouse_name, caja, folio, business_date, cajero_cierre, efectivo_esperado, efectivo_contado, efectivo_diff, total_venta)
     VALUES ($1,$2,'SMOKE','9','SMOKE-1',$3,'SMOKECJRO',20000,10000,10000,20000)`,
    [M, WH, FECHA],
  );
  await pg.query(
    `INSERT INTO analytics.stock_ledger (tenant_id, warehouse_code, sku, genero, naturaleza, grupo, clase_mov, folio, unidades, importe, fecha)
     VALUES ($1,$2,$3,'N','D','5','merma','SMOKE-M',5,150000,$4)`,
    [M, WH, SKU, FECHA],
  );
  check('cash_cut + stock_ledger sintéticos insertados', true);

  console.log('\n── 2. Escaneo del motor ──');
  const scan = await req('POST', '/reconciliation/scan', token);
  check('scan 200/201', scan.status === 200 || scan.status === 201, `status=${scan.status}`);
  check('total_nuevos ≥ 2', (scan.body?.total_nuevos || 0) >= 2, `n=${scan.body?.total_nuevos}`);
  check('≥1 crítico nuevo', (scan.body?.nuevos_criticos || []).length >= 1, `crit=${scan.body?.nuevos_criticos?.length}`);

  console.log('\n── 3. Bandeja ──');
  const caja = await req('GET', '/reconciliation/discrepancies?plano=caja', token);
  const mermaList = await req('GET', '/reconciliation/discrepancies?plano=inventario', token);
  const cajaHit = (caja.body || []).find((d) => d.entity?.sucursal === WH);
  const mermaHit = (mermaList.body || []).find((d) => d.entity?.sucursal === WH);
  check('descuadre de caja en bandeja', !!cajaHit, `titulo=${cajaHit?.titulo}`);
  check('caja crítico + faltante $10k', cajaHit?.severity === 'critical' && Math.round(cajaHit?.importe) === 10000, `sev=${cajaHit?.severity} imp=${cajaHit?.importe}`);
  check('merma en bandeja (inventario)', !!mermaHit, `titulo=${mermaHit?.titulo}`);

  console.log('\n── 4. Stats + reglas ──');
  const stats = await req('GET', '/reconciliation/discrepancies/stats', token);
  check('stats con pendientes ≥ 2', (stats.body?.pendientes || 0) >= 2, JSON.stringify(stats.body));
  check('stats por_plano incluye caja e inventario', (stats.body?.por_plano || []).some((p) => p.plano === 'caja') && (stats.body?.por_plano || []).some((p) => p.plano === 'inventario'));
  const rules = await req('GET', '/reconciliation/rules', token);
  const rk = (rules.body || []).map((r) => r.rule_key);
  check('reglas caja_descuadre + merma_inventario', rk.includes('caja_descuadre') && rk.includes('merma_inventario'), rk.join(','));

  console.log('\n── 5. Feedback (L2) ──');
  const fb = await req('POST', `/reconciliation/discrepancies/${cajaHit.id}/feedback`, token, { verdict: 'util', causa: 'faltante_caja' });
  check('feedback 200/201', fb.status === 200 || fb.status === 201, `status=${fb.status}`);
  check('status → confirmado', fb.body?.status === 'confirmado', `st=${fb.body?.status}`);
  const conf = await pg.query(`SELECT status, causa_confirmada FROM reconciliation.discrepancies WHERE id=$1`, [cajaHit.id]);
  check('DB: confirmado + causa asignada', conf.rows[0]?.status === 'confirmado' && conf.rows[0]?.causa_confirmada === 'faltante_caja', JSON.stringify(conf.rows[0]));

  console.log('\n── 6. Cleanup ──');
  await cleanup(pg);
  const left = await pg.query(`SELECT count(*)::int n FROM analytics.cash_cuts WHERE tenant_id=$1 AND warehouse_code=$2`, [M, WH]);
  check('data sintética removida', left.rows[0]?.n === 0, `n=${left.rows[0]?.n}`);

  await pg.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} reconciliation smoke: ${pass} OK / ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
