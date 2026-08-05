/**
 * RE.10 — Smoke del bridge de facturas duplicadas → bandeja de hallazgos (finance.findings).
 *
 * Replica FIELMENTE el camino real:
 *   PurchaseAdjustmentsFindingsBridgeService.syncForTenant()  (construcción de hallazgos)
 *   → MaatFindingsSinkService.pushFindings()                  (registrar regla + UPSERT idempotente)
 *
 * En runtime el push corre por DI (bridge @Optional inyecta el sink); aquí probamos, contra
 * el schema REAL, que: (1) el SQL de duplicados devuelve grupos; (2) el shape del hallazgo
 * encaja en finance.findings; (3) el UPSERT es idempotente por dedup_key (2ª corrida = 0 nuevos);
 * (4) no hay dedup_key repetido. Skip-graceful si no hay grupos (data de feed).
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-purchase-adjustments-findings.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const WINDOW_DAYS = 30;
const MIN_MONTO = 500;
const RULE_KEY = 'compra_factura_duplicada';

const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const ym = (v) => (v == null ? null : v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}` : String(v).slice(0, 7));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

// Espejo de PurchaseAdjustmentsService.duplicateGroups()
async function duplicateGroups(client) {
  const { rows } = await client.query(
    `SELECT proveedor_code, max(proveedor_nombre) AS proveedor_nombre, monto,
            count(*)::int AS veces, (count(*)-1)::int AS copias_extra,
            round((count(*)-1)*monto, 2) AS monto_riesgo,
            min(receipt_date) AS desde, max(receipt_date) AS hasta,
            (max(receipt_date)-min(receipt_date))::int AS span_dias,
            array_agg(folio ORDER BY receipt_date) AS folios,
            array_agg(sucursal ORDER BY receipt_date) AS sucursales
       FROM analytics.erp_goods_receipts
      WHERE tenant_id = $1 AND monto > 0
      GROUP BY proveedor_code, monto
     HAVING count(*) > 1 AND (max(receipt_date)-min(receipt_date)) <= $2
      ORDER BY (count(*)-1)*monto DESC
      LIMIT 200`,
    [TENANT, WINDOW_DAYS],
  );
  return rows;
}

// Espejo del finding-builder del bridge
function buildFindings(groups) {
  const out = [];
  for (const g of groups) {
    const montoRiesgo = Number(g.monto_riesgo || 0);
    if (montoRiesgo < MIN_MONTO) continue;
    const veces = Number(g.veces || 0);
    const monto = Number(g.monto || 0);
    out.push({
      rule_key: RULE_KEY, clase: 'riesgo',
      severity: montoRiesgo >= 50000 ? 'critical' : montoRiesgo >= 10000 ? 'warn' : 'info',
      score: Math.min(0.85, 0.5 + 0.1 * (veces - 1)),
      titulo: `Posible factura de compra duplicada — ${g.proveedor_nombre || g.proveedor_code}`,
      resumen: `${g.proveedor_nombre || g.proveedor_code}: ${veces} entradas por el MISMO monto ${money(monto)} en ${g.span_dias} día(s). Riesgo doble pago ${money(montoRiesgo)}.`,
      entity: { proveedor_code: g.proveedor_code, proveedor_nombre: g.proveedor_nombre, monto },
      periodo: ym(g.hasta), importe: montoRiesgo,
      evidencia: { veces, folios: g.folios, sucursales: g.sucursales, span_dias: Number(g.span_dias || 0), window_days: WINDOW_DAYS, fuente: 'analytics.erp_goods_receipts' },
      dedup_key: `${RULE_KEY}|${g.proveedor_code}|${monto}`,
    });
  }
  return out;
}

// Espejo de MaatFindingsSinkService.pushFindings() (registrar regla + UPSERT)
async function pushFindings(client, findings) {
  await client.query(
    `INSERT INTO finance.rule_registry (tenant_id, rule_key, nombre, descripcion, clase, params)
     VALUES ($1,$2,$3,$4,'riesgo',$5::jsonb)
     ON CONFLICT (tenant_id, rule_key) DO UPDATE SET nombre=EXCLUDED.nombre, descripcion=EXCLUDED.descripcion, clase=EXCLUDED.clase, updated_at=now()`,
    [TENANT, RULE_KEY, 'Posible factura de compra duplicada', 'Entradas mismo proveedor+monto exacto repetido en ventana corta.', JSON.stringify({ window_days: WINDOW_DAYS, min_monto: MIN_MONTO })],
  );
  const active = (await client.query(`SELECT 1 FROM finance.rule_registry WHERE tenant_id=$1 AND rule_key=$2 AND enabled=true AND suppressed_auto=false`, [TENANT, RULE_KEY])).rowCount > 0;
  let inserted = 0, skipped = 0;
  for (const f of findings) {
    if (!active) { skipped++; continue; }
    const res = await client.query(
      `INSERT INTO finance.findings
         (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, periodo, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'nuevo',$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12, now(), now(), now(), now())
       ON CONFLICT (tenant_id, dedup_key) DO UPDATE
         SET last_seen=now(), importe=EXCLUDED.importe, resumen=EXCLUDED.resumen, titulo=EXCLUDED.titulo,
             severity=EXCLUDED.severity, evidencia=EXCLUDED.evidencia, score=EXCLUDED.score, updated_at=now()
       RETURNING (xmax = 0) AS is_insert`,
      [TENANT, f.rule_key, f.clase, f.severity, f.score, f.titulo, f.resumen, JSON.stringify(f.entity), f.periodo, f.importe, JSON.stringify(f.evidencia), f.dedup_key],
    );
    if (res.rows[0].is_insert) inserted++;
  }
  // Paso 4 del sink: refrescar findings_total (contador de la UI de Maat).
  await client.query(
    `UPDATE finance.rule_registry SET findings_total = (SELECT count(*) FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2), updated_at=now() WHERE tenant_id=$1 AND rule_key=$2`,
    [TENANT, RULE_KEY],
  );
  return { inserted, skipped };
}

(async () => {
  const client = new Client({ connectionString: DST });
  await client.connect();
  console.log('RE.10 — bridge facturas duplicadas → finance.findings\n');
  try {
    const groups = await duplicateGroups(client);
    console.log(`  · grupos de duplicados (win ${WINDOW_DAYS}d): ${groups.length}`);
    const findings = buildFindings(groups);
    const riesgoTotal = findings.reduce((s, f) => s + f.importe, 0);
    console.log(`  · hallazgos ≥ ${money(MIN_MONTO)}: ${findings.length} · riesgo total ${money(riesgoTotal)}`);

    if (!findings.length) {
      console.log('\n  ⚠️  SKIP — sin grupos de duplicados en la data local (feed no cargado). Wiring cubierto por el build.');
      await client.end();
      process.exit(0);
    }

    // Clean slate SOLO de este rule (nadie más lo usa) → test determinista entre corridas.
    await client.query(`DELETE FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE_KEY]);

    const p1 = await pushFindings(client, findings);
    ok(p1.inserted === findings.length && p1.skipped === 0, `1ª corrida (slate limpio): ${p1.inserted} nuevos == ${findings.length} construidos, ${p1.skipped} omitidos`);

    const p2 = await pushFindings(client, findings);
    ok(p2.inserted === 0, `2ª corrida idempotente: 0 nuevos (fueron ${p2.inserted})`);

    const cnt = Number((await client.query(`SELECT count(*)::int AS n FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE_KEY])).rows[0].n);
    ok(cnt === findings.length, `finance.findings tiene ${cnt} filas del rule (esperado ${findings.length})`);

    const dk = Number((await client.query(`SELECT count(DISTINCT dedup_key)::int AS n FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE_KEY])).rows[0].n);
    ok(dk === cnt, `dedup_key único (${dk} distintos == ${cnt} filas)`);

    const rt = Number((await client.query(`SELECT findings_total FROM finance.rule_registry WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE_KEY])).rows[0]?.findings_total || 0);
    console.log(`  · rule_registry.findings_total = ${rt}`);

    const top = (await client.query(`SELECT titulo, severity, importe FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2 ORDER BY importe DESC LIMIT 1`, [TENANT, RULE_KEY])).rows[0];
    if (top) console.log(`  · top: "${top.titulo}" [${top.severity}] ${money(top.importe)}`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — duplicadas visibles en la bandeja de hallazgos, idempotente'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await client.end();
  }
  process.exit(failed ? 1 : 0);
})();
