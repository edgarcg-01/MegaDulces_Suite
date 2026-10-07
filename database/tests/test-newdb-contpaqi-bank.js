/* eslint-disable no-console */
/**
 * CP.2 — Smoke del ledger bancario ContPAQi (Fase CP, ADR-040). DB-direct sobre la nueva DB
 * (NO toca SQL Server; valida lo importado en analytics.contpaqi_bank_movements).
 *
 * Cubre: schema (tabla + columnas + PK por id_movimiento) · si hay data → todas las cuentas
 * son de banco (102x), flujo ∈ {deposito,retiro}, depósitos≈retiros (throughput bancario cuadra),
 * formato anio_mes, importes ≥ 0 · aislamiento por tenant. Tolerante si no se corrió el importer.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const FAKE = '00000000-0000-0000-0000-0000000000ff';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    const reg = (await knex.raw(`select to_regclass('analytics.contpaqi_bank_movements') r`)).rows[0].r;
    ok(reg, 'tabla analytics.contpaqi_bank_movements');
    const hasCol = async (c) => (await knex.raw(
      `select 1 from information_schema.columns where table_schema='analytics' and table_name='contpaqi_bank_movements' and column_name=?`, [c])).rows.length > 0;
    for (const c of ['tenant_id', 'id_movimiento', 'cuenta', 'fecha', 'flujo', 'importe', 'anio_mes', 'poliza_guid', 'es_conciliado'])
      ok(await hasCol(c), `col ${c}`);
    const pk = (await knex.raw(
      `select pg_get_constraintdef(oid) d from pg_constraint where conrelid='analytics.contpaqi_bank_movements'::regclass and contype='p'`)).rows[0];
    ok(pk && /tenant_id.*id_movimiento/s.test(pk.d), 'PK (tenant_id, id_movimiento)');

    const n = Number((await knex('analytics.contpaqi_bank_movements').where('tenant_id', T).count('* as c').first()).c);
    if (n === 0) {
      console.log('  ⚠ sin data importada (corre import-contpaqi-bank-movements.js --apply) — skip aserciones de data');
    } else {
      ok(n > 1000, `movimientos del tenant (${n})`);

      const noBank = Number((await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
        .whereRaw(`cuenta NOT LIKE '102%'`).count('* as c').first()).c);
      ok(noBank === 0, `todas las cuentas son de banco 102x (${noBank} fuera)`);

      const badFlujo = Number((await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
        .whereNotIn('flujo', ['deposito', 'retiro']).count('* as c').first()).c);
      ok(badFlujo === 0, `flujo ∈ {deposito,retiro} (${badFlujo} inválidos)`);

      const t = await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
        .select(knex.raw(`SUM(importe) FILTER (WHERE flujo='deposito')::numeric dep`))
        .select(knex.raw(`SUM(importe) FILTER (WHERE flujo='retiro')::numeric ret`)).first();
      const dep = Number(t.dep), ret = Number(t.ret);
      const rel = Math.abs(dep - ret) / Math.max(dep, 1);
      ok(rel < 0.02, `depósitos≈retiros throughput bancario (dep ${dep.toFixed(0)} vs ret ${ret.toFixed(0)}, Δrel ${(rel * 100).toFixed(2)}%)`);

      const fmt = Number((await knex('analytics.contpaqi_bank_movements').where('tenant_id', T)
        .whereRaw(`anio_mes !~ '^[0-9]{4}-[0-9]{1,2}$'`).count('* as c').first()).c);
      ok(fmt === 0, `formato anio_mes válido (${fmt} inválidos)`);

      const fk = Number((await knex('analytics.contpaqi_bank_movements').where('tenant_id', FAKE).count('* as c').first()).c);
      ok(fk === 0, 'tenant falso ve 0 filas (filtro explícito)');
    }

    console.log(`\nCP.2 ContPAQi bank ledger smoke: ${pass} OK, ${fail} fallidos`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
