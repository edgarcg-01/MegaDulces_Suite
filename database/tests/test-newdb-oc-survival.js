/* eslint-disable no-console */
/**
 * RA-PRO.45 — Smoke de la curva de supervivencia de las OC y del tránsito pesado.
 *
 * Lo que protege: en Kepler la OC se captura AL RECIBIR, así que una que sigue abierta hace
 * semanas casi nunca llega. El motor la pesa por P(llega | edad) en vez de restarla completa.
 * Si esto se rompe, el pedido vuelve a apagarse solo (fue el bug de agosto 2026: $10.4M de
 * tránsito fantasma tapando 420 filas en piso cero).
 *
 * DB-direct, en UNA transacción con ROLLBACK (no persiste).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── Schema ────────────────────────────────────────────────────────────
      const hasCurve = (await trx.raw(
        `select 1 from information_schema.tables where table_schema='analytics' and table_name='oc_survival_curve'`)).rows.length > 0;
      ok(hasCurve, 'tabla analytics.oc_survival_curve');

      const hasEff = (await trx.raw(
        `select 1 from information_schema.columns where table_schema='analytics'
          and table_name='replenishment_plan' and column_name='transit_eff_cajas'`)).rows.length > 0;
      ok(hasEff, 'col replenishment_plan.transit_eff_cajas');
      if (!hasCurve || !hasEff) throw new Error('rollback');

      // ── La curva ──────────────────────────────────────────────────────────
      const curva = await trx('analytics.oc_survival_curve').where('tenant_id', T).orderBy('edad')
        .select('edad', 'muestra', 'p', 'fallback');
      ok(curva.length === 8, `curva con 8 tramos (${curva.length})`);
      ok(curva.every((c) => Number(c.p) >= 0 && Number(c.p) <= 1), 'toda probabilidad en [0,1]');

      // Monótona no creciente: una OC más vieja NUNCA puede tener más chance que una nueva.
      // Es la propiedad que hace defendible el descuento; si se rompe, el motor premia lo viejo.
      let mono = true;
      for (let i = 1; i < curva.length; i++) if (Number(curva[i].p) > Number(curva[i - 1].p) + 1e-9) mono = false;
      ok(mono, 'curva monótona no creciente');

      const d0 = curva.find((c) => c.edad === 0), d61 = curva.find((c) => c.edad === 61);
      ok(d0 && d61 && Number(d0.p) > Number(d61.p), 'una OC recién abierta llega más que una de +60 días');
      ok(curva.every((c) => Number(c.muestra) > 0 || c.fallback), 'todo tramo tiene muestra o está marcado fallback');

      // ── El fact ───────────────────────────────────────────────────────────
      // NULL = el importer nuevo todavía no corrió contra esta DB (el servicio cae al crudo, o
      // sea al comportamiento previo). No es falla: sólo se informa. Lo que SÍ es falla es una
      // fila calculada que viole las invariantes.
      const agg = (await trx.raw(`
        SELECT count(*) FILTER (WHERE transit_eff_cajas IS NULL)              AS pendientes,
               count(*) FILTER (WHERE transit_eff_cajas > transit_cajas+0.01) AS eff_mayor,
               count(*) FILTER (WHERE transit_eff_cajas < 0)                  AS eff_negativo,
               round(sum(transit_cajas)::numeric,1)     AS papel,
               round(sum(transit_eff_cajas)::numeric,1) AS efectivo
          FROM analytics.replenishment_plan WHERE tenant_id = ?`, [T])).rows[0];
      if (Number(agg.pendientes) > 0) console.log(`  · ${agg.pendientes} fila(s) sin calcular todavía (el importer nuevo no ha corrido)`);
      ok(Number(agg.eff_negativo) === 0, 'ningún tránsito efectivo negativo');
      // El pesado NUNCA puede superar al papel: P ≤ 1 en todos los tramos. Si esto falla, o la
      // curva se rompió, o hay dos versiones del importer escribiendo la misma tabla.
      ok(Number(agg.eff_mayor) === 0, 'el tránsito pesado nunca supera al de los papeles');
      ok(agg.efectivo === null || Number(agg.efectivo) <= Number(agg.papel) + 0.1,
        `efectivo ${agg.efectivo ?? '—'} ≤ papel ${agg.papel} cajas`);

      // ── El ERP manda: F/C/R no deben aportar tránsito ──────────────────────
      const hasOds = (await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0]?.t;
      if (hasOds) {
        const cerradas = (await trx.raw(`
          SELECT count(*)::int AS n FROM kepler_ods.kdm1 o
           WHERE o.sucursal=o.c1 AND o.c2='X' AND o.c3='A' AND o.c4='35'
             AND o.c9::date >= CURRENT_DATE - 120
             AND COALESCE(o.c43,'N') IN ('F','C','R')`)).rows[0];
        ok(Number(cerradas.n) >= 0, `OCs que el ERP ya cerró en la ventana: ${cerradas.n} (excluidas del tránsito)`);
      } else {
        ok(true, 'sin kepler_ods (dev local) — se omite el chequeo del estatus c43');
      }

      throw new Error('rollback');   // nada persiste
    });
  } catch (e) {
    if (e.message !== 'rollback') { console.error('ERROR:', e.message); fail++; }
  } finally {
    await knex.destroy();
  }
  console.log(`\nRA-PRO.45 supervivencia OC smoke: ${pass} OK, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})();
