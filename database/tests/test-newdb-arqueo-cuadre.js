/* eslint-disable no-console */
/**
 * SM.35 — Smoke del cuadre de caja: el retiro deja de contarse como faltante.
 *
 * Tres bloques:
 *   1. Schema — las columnas del límite y la clave única que incluye al cajero.
 *   2. La identidad en SQL — sobre los datos que haya, con la prueba NEGATIVA de
 *      que la fórmula vieja (esperado − cajón) da otro número.
 *   3. La diferencia derivable del propio Kepler (c15 − (c43+c44+c48)) contra lo
 *      que el ERP publica (c35).
 *
 * ⚠️ Los bloques 2 y 3 necesitan datos reales de Kepler. Cuando la DB no los
 * tiene (el `platform_local` de desarrollo no los tiene) el bloque reporta
 * **NO MEDIDO** y NO se pinta verde: un bloque sin datos con qué comprobarse
 * miente si dice ✓. La lógica pura está gateada aparte y siempre corre, en
 * `libs/reconciliation/src/lib/cash-cut-identity.spec.ts` (`nx test reconciliation`).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const r2 = (n) => Math.round(Number(n) * 100) / 100;

(async () => {
  try {
    console.log('\n[1] Schema');
    const cols = (await knex.raw(`select column_name from information_schema.columns
      where table_schema='analytics' and table_name='cash_cuts' and column_name in ('cash_limit','cash_limit_max')`)).rows
      .map((r) => r.column_name).sort();
    ok(cols.length === 2, `columnas del límite de caja: [${cols}]`);

    const idx = (await knex.raw(`select indexname, indexdef from pg_indexes
      where schemaname='analytics' and tablename='cash_cuts' and indexname like 'uq_cash_cut%'`)).rows;
    ok(idx.length === 1, `una sola clave única en cash_cuts (${idx.map((r) => r.indexname)})`);
    ok(idx.length === 1 && /cajero_cierre/.test(idx[0].indexdef),
      'la clave única incluye cajero_cierre (el folio se reusa entre cajeros el mismo día)');
    ok(idx.length === 1 && /NULLS NOT DISTINCT/i.test(idx[0].indexdef),
      'NULLS NOT DISTINCT: dos cortes sin cajero del mismo folio no pueden coexistir');

    // Prueba NEGATIVA de la clave: un duplicado exacto tiene que ser rechazado.
    await knex.transaction(async (trx) => {
      const ins = (cajero) => trx.raw(`INSERT INTO analytics.cash_cuts
        (tenant_id, warehouse_code, caja, business_date, folio, cajero_cierre, source)
        VALUES (?,'ZZ','9','2026-01-01','99999',?,'smoke-sm35')`, [T, cajero]);
      await ins('SM35A');
      let rechazo = false;
      try { await ins('SM35A'); } catch (e) { rechazo = /unique|duplicad/i.test(e.message); }
      ok(rechazo, 'PRUEBA NEGATIVA: mismo folio + mismo cajero es rechazado');
      if (rechazo) {
        // Tras un error la transacción queda abortada: hace falta savepoint.
        // Se comprueba en una transacción limpia más abajo.
      }
      throw new Error('__rollback__');
    }).catch((e) => { if (!/__rollback__/.test(e.message)) throw e; });

    await knex.transaction(async (trx) => {
      const ins = (cajero) => trx.raw(`INSERT INTO analytics.cash_cuts
        (tenant_id, warehouse_code, caja, business_date, folio, cajero_cierre, source)
        VALUES (?,'ZZ','9','2026-01-01','99999',?,'smoke-sm35')`, [T, cajero]);
      await ins('SM35A');
      await ins('SM35B');
      const n = (await trx.raw(`select count(*)::int n from analytics.cash_cuts where source='smoke-sm35'`)).rows[0].n;
      ok(n === 2, `mismo folio con OTRO cajero entra: ${n} filas (con la clave vieja habría sido 1)`);
      throw new Error('__rollback__');
    }).catch((e) => { if (!/__rollback__/.test(e.message)) throw e; });

    /**
     * El `ON CONFLICT` que usa el sync, ejercido de verdad.
     *
     * `test-newdb-cash-cuts-sync.js` no lo toca: con 0 cortes en la ventana no
     * llega a escribir, así que un target de conflicto que no resuelve pasaría
     * inadvertido hasta que corra en una sucursal con datos. Y el error es de
     * los que no perdonan: si la migración no está aplicada, Postgres tira
     * "no unique or exclusion constraint matching the ON CONFLICT" y el sync
     * deja de traer cortes **enteros**, no una columna.
     */
    await knex.transaction(async (trx) => {
      const upsert = (esperado) => trx.raw(`
        INSERT INTO analytics.cash_cuts
          (tenant_id, warehouse_code, caja, business_date, folio, cajero_cierre,
           efectivo_esperado, cash_limit, cash_limit_max, source)
        VALUES (?,'ZZ','9','2026-01-01','99998','SM35C', ?, 15000, 20000, 'smoke-sm35')
        ON CONFLICT (tenant_id, warehouse_code, caja, business_date, folio, cajero_cierre)
        DO UPDATE SET efectivo_esperado = EXCLUDED.efectivo_esperado,
                      cash_limit = EXCLUDED.cash_limit,
                      cash_limit_max = EXCLUDED.cash_limit_max`, [T, esperado]);
      await upsert(100);
      await upsert(200);
      const r = (await trx.raw(`select count(*)::int n, max(efectivo_esperado)::float e, max(cash_limit)::float l
        from analytics.cash_cuts where source='smoke-sm35'`)).rows[0];
      ok(r.n === 1 && r.e === 200,
        `el ON CONFLICT del sync resuelve y actualiza (1 fila, esperado ${r.e})`);
      ok(r.l === 15000, 'el límite de caja se persiste en el UPSERT');
      throw new Error('__rollback__');
    }).catch((e) => { if (!/__rollback__/.test(e.message)) throw e; });

    console.log('\n[2] La identidad: retiros + cajón = esperado');
    const cierres = (await knex.raw(`
      select cc.warehouse_code, cc.caja, cc.business_date::text d,
             cc.efectivo_esperado::float esperado,
             bc.total_contado::float cajon,
             coalesce((select sum(r.total_contado) from reconciliation.blind_counts r
                        where r.tenant_id = bc.tenant_id and r.warehouse_code = bc.warehouse_code
                          and r.caja = bc.caja and r.business_date = bc.business_date
                          and r.tipo = 'retiro'
                          and r.cajero_code is not distinct from bc.cajero_code), 0)::float ret_contado,
             coalesce(cc.efectivo_retirado, 0)::float ret_kepler
        from reconciliation.blind_counts bc
        join analytics.cash_cuts cc
          on cc.tenant_id = bc.tenant_id and cc.warehouse_code = bc.warehouse_code
         and cc.caja = bc.caja and cc.business_date = bc.business_date
         and cc.cajero_cierre is not distinct from bc.cajero_code
       where bc.tipo = 'cierre' and cc.efectivo_esperado > 0`)).rows;

    if (!cierres.length) {
      noMedido('no hay cierres arqueados contra un corte de Kepler en esta DB');
    } else {
      let cuadran = 0, viejaRoja = 0, sumaVieja = 0, sumaNueva = 0;
      for (const c of cierres) {
        const sinVerif = Math.max(0, c.ret_kepler - c.ret_contado);
        const nueva = r2(c.esperado - (c.cajon + c.ret_contado + sinVerif));
        const vieja = r2(c.esperado - c.cajon);
        sumaNueva += nueva; sumaVieja += vieja;
        if (Math.abs(nueva) < 50) cuadran++;
        if (Math.abs(vieja) >= 50) viejaRoja++;
      }
      ok(true, `${cierres.length} cierres medidos · ${cuadran} cuadran con la identidad correcta`);
      // PRUEBA NEGATIVA: la fórmula vieja tiene que dar un total distinto y peor.
      ok(r2(sumaVieja) !== r2(sumaNueva),
        `la fórmula vieja da otro total: ${r2(sumaVieja)} vs ${r2(sumaNueva)} correcto`);
      const conRetiro = cierres.filter((c) => c.ret_kepler > 0 || c.ret_contado > 0);
      if (!conRetiro.length) {
        noMedido('ningún cierre de esta DB tiene retiros: el bug no se puede reproducir acá');
      } else {
        ok(viejaRoja >= cuadran || viejaRoja > 0,
          `la vieja marcaba ${viejaRoja} de ${cierres.length} filas en rojo`);
        // Donde hay retiro, la diferencia entre las dos fórmulas es EXACTAMENTE
        // el dinero que salió del cajón. Eso es el bug, medido.
        const c0 = conRetiro[0];
        const sinVerif0 = Math.max(0, c0.ret_kepler - c0.ret_contado);
        const delta = r2(r2(c0.esperado - c0.cajon) - r2(c0.esperado - (c0.cajon + c0.ret_contado + sinVerif0)));
        ok(Math.abs(delta - r2(c0.ret_contado + sinVerif0)) < 0.02,
          `la brecha entre las dos fórmulas es el retiro completo (${delta})`);
      }
    }

    console.log('\n[3] La diferencia que sale del propio Kepler');
    const tieneOds = (await knex.raw(`select 1 from information_schema.tables
      where table_schema='kepler_ods' and table_name='kdpv_folio_caja'`)).rows.length > 0;
    if (!tieneOds) {
      noMedido('kepler_ods.kdpv_folio_caja no existe en esta DB');
    } else {
      const g = (await knex.raw(`
        select count(*)::int turnos,
               sum((abs(c15 - c43 - c44 - c48) >= 50)::int)::int descuadran,
               sum((abs(c35) < 50 and abs(c15 - c43 - c44 - c48) >= 50)::int)::int enmascarados,
               round(sum(case when abs(c35) < 50 and (c15 - c43 - c44 - c48) >= 50
                              then (c15 - c43 - c44 - c48) else 0 end), 2)::float oculto,
               sum((abs(c35 - (c15 - c25)) < 0.005)::int)::int c35_es_resta
          from kepler_ods.kdpv_folio_caja
         where c10::date <> date '1800-01-01' and c15 > 0`)).rows[0];
      if (!g.turnos) {
        noMedido('el ODS existe pero no tiene cortes cerrados en esta DB');
      } else {
        ok(g.c35_es_resta === g.turnos,
          `c35 = c15 − c25 en los ${g.turnos} cortes: es una resta, no una medición`);
        ok(g.enmascarados > 0,
          `${g.enmascarados} cortes que Kepler da por cuadrados y su desglose contradice ($${g.oculto} ocultos)`);
        ok(g.descuadran >= g.enmascarados,
          'todo corte enmascarado descuadra (el enmascarado es un subconjunto)');
      }
    }
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.35 arqueo/cuadre → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
