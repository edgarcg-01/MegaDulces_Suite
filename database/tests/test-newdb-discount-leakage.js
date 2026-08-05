/**
 * RE.10 — Smoke del detector "descuento no capturado" (pronto pago dejado en la mesa).
 *
 * Verifica (newdb local, feed real):
 *  1. `commercial.supplier_discount_policy` poblada (tasa observada por proveedor).
 *  2. `leakageGroups` (réplica): pagos con `descuento=0` de un proveedor CON política →
 *     fuga = tasa × monto; coherencia `lost == rate × monto_uncaptured`.
 *  3. Push a `finance.findings` (regla `descuento_no_capturado`, clase oportunidad),
 *     clean-slate + idempotente (réplica de MaatFindingsSinkService).
 * Skip-graceful si no hay política/fuga (feed no cargado).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-discount-leakage.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const MIN_LOST = 1000;
const RULE = 'descuento_no_capturado';
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };
const near = (a, b, tol = 1) => Math.abs(Number(a) - Number(b)) <= tol;

async function pushFindings(client, findings) {
  await client.query(
    `INSERT INTO finance.rule_registry (tenant_id, rule_key, nombre, descripcion, clase, params)
     VALUES ($1,$2,$3,$4,'oportunidad',$5::jsonb)
     ON CONFLICT (tenant_id, rule_key) DO UPDATE SET nombre=EXCLUDED.nombre, clase=EXCLUDED.clase, updated_at=now()`,
    [TENANT, RULE, 'Descuento de pronto pago no capturado', 'Proveedor con política que pagó sin descuento.', JSON.stringify({ min_lost: MIN_LOST })]);
  let inserted = 0;
  for (const f of findings) {
    const res = await client.query(
      `INSERT INTO finance.findings
         (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, periodo, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
       VALUES ($1,$2,'oportunidad',$3,'nuevo',$4,$5,$6,$7::jsonb,NULL,$8,$9::jsonb,$10, now(), now(), now(), now())
       ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET last_seen=now(), importe=EXCLUDED.importe, resumen=EXCLUDED.resumen, severity=EXCLUDED.severity, evidencia=EXCLUDED.evidencia, score=EXCLUDED.score, updated_at=now()
       RETURNING (xmax = 0) AS is_insert`,
      [TENANT, RULE, f.severity, f.score, f.titulo, f.resumen, JSON.stringify(f.entity), f.importe, JSON.stringify(f.evidencia), f.dedup_key]);
    if (res.rows[0].is_insert) inserted++;
  }
  return inserted;
}

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('RE.10 — detector "descuento no capturado"\n');
  try {
    const nPol = Number((await c.query(`SELECT count(*)::int n FROM commercial.supplier_discount_policy WHERE tenant_id=$1 AND active AND expected_discount_rate>0`, [TENANT])).rows[0].n);
    console.log(`  · políticas activas: ${nPol}`);
    if (nPol === 0) { console.log('\n  ⚠️  SKIP — sin política de descuento (corré import-supplier-discount-policy.js). Wiring cubierto por el build.'); await c.end(); process.exit(0); }
    ok(nPol > 0, 'commercial.supplier_discount_policy poblada');

    // leakageGroups (réplica exacta del service)
    const groups = (await c.query(
      `SELECT p.proveedor_code, max(p.proveedor_nombre) AS proveedor_nombre, pol.expected_discount_rate AS rate,
              count(*)::int AS n_total, count(*) FILTER (WHERE p.descuento>0)::int AS n_captured,
              count(*) FILTER (WHERE p.descuento=0)::int AS n_uncaptured,
              COALESCE(sum(p.monto) FILTER (WHERE p.descuento=0),0)::numeric AS monto_uncaptured,
              round(pol.expected_discount_rate * COALESCE(sum(p.monto) FILTER (WHERE p.descuento=0),0), 2) AS lost
         FROM analytics.erp_supplier_payments p
         JOIN commercial.supplier_discount_policy pol ON pol.tenant_id=p.tenant_id AND pol.proveedor_code=p.proveedor_code
        WHERE p.tenant_id=$1 AND pol.active AND pol.expected_discount_rate>0
        GROUP BY p.proveedor_code, pol.expected_discount_rate
       HAVING count(*) FILTER (WHERE p.descuento=0) > 0
        ORDER BY lost DESC LIMIT 300`, [TENANT])).rows;

    const totalLost = groups.reduce((s, g) => s + Number(g.lost || 0), 0);
    console.log(`  · proveedores con fuga: ${groups.length} · total dejado en la mesa: ${money(totalLost)}`);
    ok(groups.length > 0, 'leakageGroups devuelve proveedores con descuento no capturado');
    ok(groups.every((g) => near(g.lost, Number(g.rate) * Number(g.monto_uncaptured), 1)), 'coherencia: lost == tasa × monto_no_capturado en cada fila');

    // findings (lost >= MIN_LOST) + push idempotente
    const findings = groups.filter((g) => Number(g.lost) >= MIN_LOST).map((g) => ({
      severity: g.lost >= 50000 ? 'critical' : g.lost >= 10000 ? 'warn' : 'info',
      score: Math.min(0.9, 0.4 + 0.5 * (g.n_total ? g.n_uncaptured / g.n_total : 0)),
      titulo: `Descuento de pronto pago no capturado — ${g.proveedor_nombre || g.proveedor_code}`,
      resumen: `${g.n_uncaptured}/${g.n_total} pagos sin descuento; ~${money(g.lost)} a ${(g.rate * 100).toFixed(2)}%.`,
      entity: { proveedor_code: g.proveedor_code, expected_rate: Number(g.rate) },
      importe: Number(g.lost), evidencia: { n_uncaptured: g.n_uncaptured, monto_uncaptured: Number(g.monto_uncaptured) },
      dedup_key: `${RULE}|${g.proveedor_code}`,
    }));
    console.log(`  · hallazgos ≥ ${money(MIN_LOST)}: ${findings.length}`);

    await c.query(`DELETE FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE]);
    const i1 = await pushFindings(c, findings);
    ok(i1 === findings.length, `1ª corrida: ${i1} hallazgos nuevos == ${findings.length}`);
    const i2 = await pushFindings(c, findings);
    ok(i2 === 0, `2ª corrida idempotente: 0 nuevos (fueron ${i2})`);
    const cnt = Number((await c.query(`SELECT count(*)::int n FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE])).rows[0].n);
    ok(cnt === findings.length, `finance.findings tiene ${cnt} filas (esperado ${findings.length})`);

    const top = groups[0];
    if (top) console.log(`  · top: ${top.proveedor_nombre || top.proveedor_code} — ${top.n_uncaptured}/${top.n_total} sin desc · tasa ${(top.rate * 100).toFixed(2)}% · ${money(top.lost)} perdido`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — descuento no capturado detectado + en bandeja de oportunidades'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
