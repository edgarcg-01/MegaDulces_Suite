/* eslint-disable no-console */
/**
 * Smoke DB-directo — Índice de riesgo de inventario (Fase PREV.3, Apéndice B §14-15).
 *
 *   1. Tabla existe con RLS forzado
 *   2. computeScore: niveles bajo/medio/alto/crítico (mirror del servicio)
 *   3. Agregación (mismo SQL del servicio): expedientes + monitoreo por (almacén,producto)
 *   4. Reincidencia + PNI → crítico; CHECK risk_level
 *   5. Idempotente (recálculo reemplaza el scope)
 *
 * Almacén dedicado (RISK-TEST-WH). NO por persona: el eje es SKU/almacén.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW_RUNTIME });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
async function expectFail(fn) { try { await fn(); return false; } catch { return true; } }

// Mirror EXACTO de InventoryRiskService.computeScore.
function computeScore(i) {
  const s = i.investigations * 10 + i.pni * 25 + i.monitoringLosses * 8 + Math.min(i.shrinkValue / 1000, 50);
  const r = Math.round(s * 100) / 100;
  let level;
  if (r >= 60 || (i.pni >= 1 && i.investigations >= 2)) level = 'critico';
  else if (r >= 30 || i.investigations >= 2 || i.pni >= 1) level = 'alto';
  else if (r >= 10 || i.monitoringLosses >= 1 || i.investigations >= 1) level = 'medio';
  else level = 'bajo';
  return { score: r, level };
}

(async () => {
  let whId, prod, monId;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    const reg = await knex.raw(`SELECT to_regclass('commercial.inventory_risk_index') AS r`);
    check(reg.rows[0].r, 'commercial.inventory_risk_index existe');
    const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.inventory_risk_index'::regclass`);
    check(rls.rows[0]?.relforcerowsecurity === true, 'RLS forzado');

    // ── 2. computeScore niveles ──
    console.log('\n2) computeScore niveles');
    check(computeScore({ investigations: 0, pni: 0, monitoringLosses: 0, shrinkValue: 0 }).level === 'bajo', 'sin eventos → bajo');
    check(computeScore({ investigations: 1, pni: 0, monitoringLosses: 0, shrinkValue: 0 }).level === 'medio', '1 expediente → medio');
    check(computeScore({ investigations: 2, pni: 0, monitoringLosses: 0, shrinkValue: 0 }).level === 'alto', '2 expedientes → alto');
    check(computeScore({ investigations: 2, pni: 1, monitoringLosses: 0, shrinkValue: 0 }).level === 'critico', '2 expedientes + 1 PNI → crítico (reincidencia+no-identificada)');
    check(computeScore({ investigations: 0, pni: 0, monitoringLosses: 1, shrinkValue: 0 }).level === 'medio', '1 pérdida en monitoreo → medio');

    // Setup + seed
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ code: 'RISK-TEST-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'RISK-TEST-WH', name: 'Riesgo Test WH' }).returning('id'))[0].id;
      prod = (await trx('catalog.products').where({ tenant_id: TENANT }).first('id')).id;
      await trx('commercial.inventory_risk_index').where({ warehouse_id: whId }).del();
      await trx('commercial.inventory_investigations').where({ warehouse_id: whId }).del();
      await trx('commercial.inventory_monitoring').where({ warehouse_id: whId }).del();
      // 2 expedientes (uno PNI) para el mismo SKU
      await trx('commercial.inventory_investigations').insert([
        { tenant_id: TENANT, folio: 'RISK-TEST-1', warehouse_id: whId, product_id: prod, expected_qty: 100, physical_qty: 95, difference: -5, unit_cost: 10, value_at_cost: -50, status: 'resolved', root_cause: 'MR' },
        { tenant_id: TENANT, folio: 'RISK-TEST-2', warehouse_id: whId, product_id: prod, expected_qty: 50, physical_qty: 47, difference: -3, unit_cost: 10, value_at_cost: -30, status: 'open', root_cause: 'PNI' },
      ]);
      // 1 monitoreo con 1 conteo con faltante
      const [m] = await trx('commercial.inventory_monitoring').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, status: 'active' }).returning('id');
      monId = m.id;
      await trx('commercial.inventory_monitoring_counts').insert({ tenant_id: TENANT, monitoring_id: monId, expected_qty: 47, physical_qty: 45, difference: -2 });
    });
    check(!!whId && !!prod, 'setup + seed (2 expedientes + 1 monitoreo con faltante)');

    // ── 3+4. Agregación + nivel ──
    console.log('\n3) Agregación (SQL del servicio) · 4) nivel');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const inv = (await trx.raw(
        `SELECT COUNT(*)::int AS investigations_count,
                COUNT(*) FILTER (WHERE root_cause = 'PNI' OR status = 'monitoring')::int AS pni_count,
                COALESCE(SUM(ABS(value_at_cost)) FILTER (WHERE difference < 0), 0)::numeric AS shrink_value
           FROM commercial.inventory_investigations
          WHERE opened_at >= now() - interval '90 days' AND warehouse_id = ? AND product_id = ?`, [whId, prod])).rows[0];
      const mon = (await trx.raw(
        `SELECT COUNT(c.*) FILTER (WHERE c.difference < 0)::int AS monitoring_losses
           FROM commercial.inventory_monitoring m
           JOIN commercial.inventory_monitoring_counts c ON c.tenant_id = m.tenant_id AND c.monitoring_id = m.id
          WHERE m.warehouse_id = ? AND m.product_id = ?`, [whId, prod])).rows[0];

      check(Number(inv.investigations_count) === 2, `investigations_count = 2 (fue ${inv.investigations_count})`);
      check(Number(inv.pni_count) === 1, `pni_count = 1 (fue ${inv.pni_count})`);
      check(Number(inv.shrink_value) === 80, `shrink_value = |−50|+|−30| = 80 (fue ${inv.shrink_value})`);
      check(Number(mon.monitoring_losses) === 1, `monitoring_losses = 1 (fue ${mon.monitoring_losses})`);

      const { score, level } = computeScore({
        investigations: Number(inv.investigations_count), pni: Number(inv.pni_count),
        monitoringLosses: Number(mon.monitoring_losses), shrinkValue: Number(inv.shrink_value),
      });
      check(level === 'critico', `nivel = crítico (2 exp + 1 PNI; score ${score})`);

      // Insert al índice
      await trx('commercial.inventory_risk_index').insert({
        tenant_id: TENANT, warehouse_id: whId, product_id: prod,
        investigations_count: 2, pni_count: 1, monitoring_losses: 1, shrink_value: 80, risk_score: score, risk_level: level,
      });
      const row = await trx('commercial.inventory_risk_index').where({ warehouse_id: whId, product_id: prod }).first();
      check(row && row.risk_level === 'critico', 'fila del índice persistida (crítico)');
    });

    // CHECK nivel inválido
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_risk_index').where({ warehouse_id: whId, product_id: prod }).update({ risk_level: 'extremo' });
    })), "risk_level inválido ('extremo') rechazado");

    // ── 5. Idempotencia (único por almacén,producto) ──
    console.log('\n5) Idempotencia');
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_risk_index').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, risk_level: 'bajo' });
    })), '2ª fila para el mismo (almacén,producto) rechazada (único)');

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_risk_index').where({ warehouse_id: whId }).del();
      await trx('commercial.inventory_monitoring').where({ warehouse_id: whId }).del();
      await trx('commercial.inventory_investigations').where({ warehouse_id: whId }).del();
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Índice de riesgo: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
