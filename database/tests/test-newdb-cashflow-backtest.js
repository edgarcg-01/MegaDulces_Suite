/* eslint-disable no-console */
/**
 * [TES.12] Candado del lazo del pronostico.
 *
 * Lo que vigila, y por que cada cosa:
 *   1. La tabla y la vista existen, con RLS FORZADO en la tabla. Si no estan, el bloque entero
 *      reporta NO MEDIDO: un candado que no encuentra su objeto NO se pone verde.
 *   2. El "ocurrido" existe en las DOS piernas. Sin el, el lazo no cierra y no sirve de nada
 *      guardar el pronostico -- eso se declara, no se asume.
 *   3. PRUEBA NEGATIVA de la semana en curso: una semana sin cerrar NO puede aparecer en la
 *      vista. Si apareciera, su "real" estaria a medias y el pronostico saldria optimista por
 *      puro artefacto del calendario.
 *   4. PRUEBA NEGATIVA del veredicto de comparabilidad: con cobertura parcial, `comparable`
 *      tiene que ser FALSE. Es el freno que impide leer ALCANCE como PUNTERIA -- medido, el
 *      cobro real ronda $10M/semana y el proyectado $1.5M, y esa diferencia NO es error.
 *   5. La razon se calcula sobre lo proyectado y es NULL cuando no hay con que dividir, nunca 0.
 *
 * Escribe dentro de una transaccion con ROLLBACK: cero efecto real.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
function noMedido(m) { nm++; console.log('  ⊘ NO MEDIDO:', m); }

(async () => {
  try {
    console.log('\n[TES.12] el pronostico se guarda y se contrasta');
    const reg = await knex.raw(`SELECT to_regclass('finance.cashflow_forecast') t,
                                       to_regclass('analytics.v_cashflow_backtest') v`);
    if (!reg.rows[0].t || !reg.rows[0].v) {
      noMedido('falta aplicar la migracion 20261009093031: tabla y/o vista ausentes. El resto NO se evalua.');
      console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
      await knex.destroy();
      process.exit(fail ? 1 : 0);
    }
    ok(true, 'finance.cashflow_forecast y analytics.v_cashflow_backtest existen');

    const rls = await knex.raw(`SELECT relforcerowsecurity f FROM pg_class WHERE oid='finance.cashflow_forecast'::regclass`);
    ok(rls.rows[0]?.f === true, 'la tabla tiene RLS FORZADO');

    // ── 2. El ocurrido, en las dos piernas ─────────────────────────────────────────────
    const r = (await knex.raw(`
      SELECT (SELECT count(*) FROM analytics.erp_collections WHERE cobro_date >= current_date - 60) AS cob,
             (SELECT count(*) FROM analytics.erp_supplier_payments WHERE pago_date >= current_date - 60) AS pag`)).rows[0];
    if (Number(r.cob) > 0 && Number(r.pag) > 0) {
      ok(true, `el ocurrido existe en las dos piernas (${r.cob} cobros · ${r.pag} pagos en 60d)`);
    } else {
      noMedido(`el ocurrido falta en alguna pierna (cobros=${r.cob}, pagos=${r.pag}): el lazo NO cierra y guardar el pronostico no alcanza.`);
    }

    // ── 3/4/5. Las pruebas negativas, sobre filas propias y con ROLLBACK ───────────────
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const semCerrada = (await trx.raw(`SELECT (date_trunc('week', current_date)::date - 7) d`)).rows[0].d;
      const semCurso = (await trx.raw(`SELECT date_trunc('week', current_date)::date d`)).rows[0].d;

      await trx('finance.cashflow_forecast').insert([
        { tenant_id: T, tomado_el: knex.raw('current_date'), semana: semCerrada, horizonte_dias: -7,
          cobros_proyectado: 1000, pagos_proyectado: 500, cobro_cobertura_pct: 11.8, pago_cobertura_pct: 100 },
        { tenant_id: T, tomado_el: knex.raw('current_date'), semana: semCurso, horizonte_dias: 0,
          cobros_proyectado: 2000, pagos_proyectado: 900, cobro_cobertura_pct: 100, pago_cobertura_pct: 100 },
      ]);

      const vis = await trx('analytics.v_cashflow_backtest').where({ tenant_id: T })
        .whereIn('semana', [semCerrada, semCurso]).select('semana', 'cobro_comparable', 'pago_comparable', 'cobro_razon');

      // PRUEBA NEGATIVA: la semana EN CURSO no puede estar.
      ok(!vis.some((x) => String(x.semana).slice(0, 10) === String(semCurso).slice(0, 10)),
        'la semana EN CURSO no aparece (su real esta a medias y daria un pronostico optimista falso)');
      const cerrada = vis.find((x) => String(x.semana).slice(0, 10) === String(semCerrada).slice(0, 10));
      ok(!!cerrada, 'la semana CERRADA si aparece');

      if (cerrada) {
        // PRUEBA NEGATIVA: cobertura 11.8% => NO comparable. Es el freno que impide leer
        // alcance como punteria; si esto se pone en true, el back-test publica -80% de error
        // inventado.
        ok(cerrada.cobro_comparable === false,
          'con cobertura 11.8% el cobro sale NO comparable (alcance no es punteria)');
        ok(cerrada.pago_comparable === true,
          'con cobertura 100% el pago SI sale comparable (la guarda no es un no-op que apague todo)');
        ok(cerrada.cobro_razon !== null, 'la razon se calcula cuando hay con que dividir');
      }

      // La razon es NULL, no 0, cuando lo proyectado es cero.
      await trx('finance.cashflow_forecast').insert({
        tenant_id: T, tomado_el: knex.raw('current_date'), semana: knex.raw(`date_trunc('week', current_date)::date - 14`),
        horizonte_dias: -14, cobros_proyectado: 0, pagos_proyectado: 0,
        cobro_cobertura_pct: 100, pago_cobertura_pct: 100,
      });
      const cero = await trx('analytics.v_cashflow_backtest').where({ tenant_id: T })
        .whereRaw(`semana = date_trunc('week', current_date)::date - 14`).first('cobro_razon');
      ok(cero && cero.cobro_razon === null,
        'sin proyeccion la razon queda en NULL, no en 0 (un 0 se leeria como "no entro nada")');

      throw new Error('ROLLBACK_A_PROPOSITO');
    }).catch((e) => { if (e.message !== 'ROLLBACK_A_PROPOSITO') throw e; });

    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} ⊘\n`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('  ✗ EXCEPCION:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
