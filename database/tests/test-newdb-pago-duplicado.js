/**
 * Maat — Smoke del detector `pago_duplicado` (doble pago sobre pagos reales).
 *
 * Aplica a PAGOS el mismo control que la factura duplicada aplica a compras: mismo
 * proveedor + monto exacto + método en ventana corta sobre `analytics.erp_supplier_payments`
 * → hallazgo `riesgo` en `finance.findings`. Replica FIELMENTE `MaatDetectorService.detPagoDuplicado`
 * + el UPSERT de `scanAll` (registra regla → UPSERT idempotente por dedup_key).
 * Skip-graceful si no hay pagos. Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-pago-duplicado.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const WIN = 30, MIN = 10000, CRIT = 100000, RULE = 'pago_duplicado';
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

async function pushFindings(client, findings) {
  await client.query(
    `INSERT INTO finance.rule_registry (tenant_id, rule_key, nombre, descripcion, clase, params)
     VALUES ($1,$2,'Posible pago duplicado','Doble pago mismo proveedor+monto+método.','riesgo',$3::jsonb)
     ON CONFLICT (tenant_id, rule_key) DO UPDATE SET clase='riesgo', updated_at=now()`,
    [TENANT, RULE, JSON.stringify({ ventana_dias: WIN, min_monto: MIN, critico_monto: CRIT })]);
  let inserted = 0;
  for (const f of findings) {
    const res = await client.query(
      `INSERT INTO finance.findings (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, periodo, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
       VALUES ($1,$2,'riesgo',$3,'nuevo',$4,$5,$6,$7::jsonb,NULL,$8,$9::jsonb,$10, now(), now(), now(), now())
       ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET last_seen=now(), importe=EXCLUDED.importe, severity=EXCLUDED.severity, updated_at=now()
       RETURNING (xmax = 0) AS is_insert`,
      [TENANT, RULE, f.severity, f.score, f.titulo, f.resumen, JSON.stringify(f.entity), f.importe, JSON.stringify(f.evidencia), f.dedup_key]);
    if (res.rows[0].is_insert) inserted++;
  }
  return inserted;
}

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('Maat — detector pago_duplicado (doble pago)\n');
  try {
    const nPay = Number((await c.query(`SELECT count(*)::int n FROM analytics.erp_supplier_payments WHERE tenant_id=$1`, [TENANT])).rows[0].n);
    if (nPay === 0) { console.log('\n  ⚠️  SKIP — sin pagos (feed no cargado). Wiring cubierto por el build.'); await c.end(); process.exit(0); }

    // réplica EXACTA de detPagoDuplicado
    const groups = (await c.query(
      `SELECT proveedor_code, monto, metodo_pago, max(proveedor_nombre) proveedor_nombre,
              count(*)::int veces, round((count(*)-1)*monto,2) extra, (max(pago_date)-min(pago_date))::int span
         FROM analytics.erp_supplier_payments WHERE tenant_id=$1 AND monto>=$2
        GROUP BY proveedor_code, monto, metodo_pago
       HAVING count(*)>1 AND (max(pago_date)-min(pago_date))<=$3
        ORDER BY (count(*)-1)*monto DESC LIMIT 200`, [TENANT, MIN, WIN])).rows;

    const riesgo = groups.reduce((s, g) => s + Number(g.extra || 0), 0);
    console.log(`  · grupos de doble pago: ${groups.length} · $ en riesgo: ${money(riesgo)}`);
    ok(groups.length > 0, 'detPagoDuplicado devuelve grupos de posible doble pago');
    ok(groups.every((g) => Math.abs(Number(g.extra) - (Number(g.veces) - 1) * Number(g.monto)) <= 1), 'coherencia: extra == (veces-1)×monto');

    const findings = groups.map((g) => ({
      severity: Number(g.extra) >= CRIT ? 'critical' : 'warn',
      score: Math.min(0.9, 0.5 + 0.1 * (Number(g.veces) - 1)),
      titulo: `Posible pago duplicado — ${g.proveedor_nombre || g.proveedor_code}`,
      resumen: `${g.veces} pagos por ${money(Number(g.monto))} en ${g.span}d — ${money(Number(g.extra))} riesgo.`,
      entity: { proveedor_code: g.proveedor_code, monto: Number(g.monto), metodo_pago: g.metodo_pago },
      importe: Number(g.extra),
      evidencia: { veces: Number(g.veces), span_dias: Number(g.span), metodo_pago: g.metodo_pago },
      dedup_key: `${RULE}|${g.proveedor_code}|${g.monto}|${g.metodo_pago}`,
    }));

    await c.query(`DELETE FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE]);
    const i1 = await pushFindings(c, findings);
    ok(i1 === findings.length, `1ª corrida: ${i1} hallazgos nuevos == ${findings.length}`);
    const i2 = await pushFindings(c, findings);
    ok(i2 === 0, `2ª corrida idempotente: 0 nuevos (fueron ${i2})`);
    const cnt = Number((await c.query(`SELECT count(*)::int n FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2`, [TENANT, RULE])).rows[0].n);
    ok(cnt === findings.length, `finance.findings tiene ${cnt} filas del rule (esperado ${findings.length})`);
    const crit = Number((await c.query(`SELECT count(*)::int n FROM finance.findings WHERE tenant_id=$1 AND rule_key=$2 AND severity='critical'`, [TENANT, RULE])).rows[0].n);
    console.log(`  · críticos (≥${money(CRIT)}): ${crit}`);
    const top = groups[0];
    if (top) console.log(`  · top: ${top.proveedor_nombre || top.proveedor_code} — ${money(Number(top.monto))} ×${top.veces} [${top.metodo_pago}] span ${top.span}d → ${money(Number(top.extra))}`);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — doble pago detectado + en bandeja de riesgo (finance.findings)'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
