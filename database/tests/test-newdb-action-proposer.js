/**
 * CxP — Smoke del MaatActionProposerService (hallazgo accionable → acción HITL).
 *
 * Verifica el lazo "hallazgo → acción": los hallazgos `descuento_no_capturado`
 * (oportunidad) y `pago_duplicado` (riesgo) por encima de su umbral se convierten en
 * `finance.proposed_actions` (kind=revisar_hallazgo, origen=motor), ligadas por
 * finding_id, idempotentes (una sola acción por hallazgo). Al aprobar, el hallazgo
 * pasa a `en_revision`. Replica FIELMENTE la SQL del service, ACOTADA a filas de
 * prueba (titulo '__SMOKE__%') para no tocar hallazgos reales. Auto-limpia.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-action-proposer.js
 */
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const MARK = '__SMOKE__PROPOSER';
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

async function ensureRule(c, rule_key, clase) {
  await c.query(
    `INSERT INTO finance.rule_registry (tenant_id, rule_key, nombre, descripcion, clase, params)
     VALUES ($1,$2,$3,'smoke',$4,'{}'::jsonb)
     ON CONFLICT (tenant_id, rule_key) DO NOTHING`,
    [TENANT, rule_key, rule_key, clase]);
}

async function seedFinding(c, rule_key, clase, severity, status, importe, tag) {
  const { rows } = await c.query(
    `INSERT INTO finance.findings (tenant_id, rule_key, clase, severity, status, score, titulo, resumen, entity, importe, evidencia, dedup_key, first_seen, last_seen, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,0.7,$6,'resumen de prueba',$7::jsonb,$8,'{}'::jsonb,$9, now(),now(),now(),now())
     ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET status=EXCLUDED.status, importe=EXCLUDED.importe, titulo=EXCLUDED.titulo
     RETURNING id`,
    [TENANT, rule_key, clase, severity, status, `${MARK} ${tag}`, JSON.stringify({ proveedor_code: 'SMOKE-01', proveedor_nombre: 'PROVEEDOR SMOKE' }), importe, `${rule_key}|${MARK}|${tag}`]);
  return rows[0].id;
}

// INSERT…SELECT que replica proposeForTenant, ACOTADO a filas de prueba
async function runProposer(c, rule_key, minImporte) {
  const { rowCount } = await c.query(
    `INSERT INTO finance.proposed_actions (tenant_id, kind, titulo, descripcion, efecto, payload, finding_id, importe, origen, created_by)
     SELECT $1, 'revisar_hallazgo', $4 || ' — ' || f.titulo, f.resumen, 'efecto de prueba',
            jsonb_build_object('finding_id', f.id, 'rule_key', f.rule_key), f.id, f.importe, 'motor', 'maat_motor'
       FROM finance.findings f
      WHERE f.tenant_id=$1 AND f.rule_key=$2 AND f.status IN ('nuevo','confirmado') AND f.importe >= $3
        AND f.titulo LIKE $5
        AND NOT EXISTS (SELECT 1 FROM finance.proposed_actions pa WHERE pa.finding_id = f.id)`,
    [TENANT, rule_key, minImporte, rule_key, `${MARK}%`]);
  return rowCount;
}

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('CxP — MaatActionProposerService (hallazgo → acción HITL)\n');
  try {
    await ensureRule(c, 'descuento_no_capturado', 'oportunidad');
    await ensureRule(c, 'pago_duplicado', 'riesgo');

    // limpia corridas previas
    await c.query(`DELETE FROM finance.proposed_actions WHERE tenant_id=$1 AND finding_id IN (SELECT id FROM finance.findings WHERE tenant_id=$1 AND titulo LIKE $2)`, [TENANT, `${MARK}%`]);
    await c.query(`DELETE FROM finance.findings WHERE tenant_id=$1 AND titulo LIKE $2`, [TENANT, `${MARK}%`]);

    const f1 = await seedFinding(c, 'descuento_no_capturado', 'oportunidad', 'warn', 'nuevo', 8000, 'desc-ok');       // → acción
    const f2 = await seedFinding(c, 'pago_duplicado', 'riesgo', 'critical', 'nuevo', 50000, 'pago-ok');              // → acción
    await seedFinding(c, 'descuento_no_capturado', 'oportunidad', 'info', 'nuevo', 2000, 'desc-bajo');               // skip (< 5000)
    await seedFinding(c, 'pago_duplicado', 'riesgo', 'critical', 'descartado', 90000, 'pago-descartado');            // skip (status)

    const c1 = (await runProposer(c, 'descuento_no_capturado', 5000)) + (await runProposer(c, 'pago_duplicado', 10000));
    ok(c1 === 2, `1ª corrida: ${c1} acciones creadas (esperado 2 — respeta umbral y status)`);

    const acts = (await c.query(
      `SELECT kind, origen, finding_id, importe FROM finance.proposed_actions
        WHERE tenant_id=$1 AND finding_id IN ($2,$3) ORDER BY importe DESC`, [TENANT, f1, f2])).rows;
    ok(acts.length === 2, `2 acciones ligadas a los hallazgos por finding_id`);
    ok(acts.every((a) => a.kind === 'revisar_hallazgo' && a.origen === 'motor'), `kind=revisar_hallazgo · origen=motor`);
    ok(acts.some((a) => a.finding_id === f2 && Number(a.importe) === 50000), `importe del hallazgo se copia a la acción`);

    const c2 = (await runProposer(c, 'descuento_no_capturado', 5000)) + (await runProposer(c, 'pago_duplicado', 10000));
    ok(c2 === 0, `2ª corrida idempotente: 0 acciones nuevas (fueron ${c2})`);

    // approve() del hallazgo de descuento → finding a en_revision
    await c.query(`UPDATE finance.findings SET status='en_revision', updated_at=now() WHERE id=$1`, [f1]);
    const st = (await c.query(`SELECT status FROM finance.findings WHERE id=$1`, [f1])).rows[0].status;
    ok(st === 'en_revision', `al aprobar (kind=revisar_hallazgo), el hallazgo pasa a "en_revision"`);

    // cleanup
    await c.query(`DELETE FROM finance.proposed_actions WHERE tenant_id=$1 AND finding_id IN (SELECT id FROM finance.findings WHERE tenant_id=$1 AND titulo LIKE $2)`, [TENANT, `${MARK}%`]);
    await c.query(`DELETE FROM finance.findings WHERE tenant_id=$1 AND titulo LIKE $2`, [TENANT, `${MARK}%`]);

    console.log(`\n${failed ? '❌ ' + failed + ' fallo(s)' : '✅ PASS — hallazgo accionable → acción HITL (ligada, idempotente, aprobable)'}`);
  } catch (e) {
    console.error('  ❌ ERROR:', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed ? 1 : 0);
})();
