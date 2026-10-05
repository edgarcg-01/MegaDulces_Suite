/* eslint-disable no-console */
/**
 * El SEGUNDO retiro del dia dejaba de existir — candado.
 *
 * `uq_blind_count_ruta` era una clave unica TOTAL con `tipo` adentro pero sin
 * excluir `'retiro'`, y el `onConflict().merge()` de `submit()` reemplazaba la
 * fila: la sangria de las 15:22 pisaba a la de las 11:04 —denominaciones, nota,
 * incidencia y hora incluidas— con un toast que decia «Arqueo guardado».
 *
 * Y la migracion que introdujo el tipo afirmaba lo contrario: «Un turno tiene UN
 * cierre pero VARIOS retiros, asi que el indice unico que ordena los cierres no
 * puede aplicarles». Si les aplicaba. Este archivo existe para que esa frase no
 * vuelva a ser una intencion: ahora hay una prueba que se pone roja.
 *
 * Tres bloques:
 *   1. Schema — la columna, el CHECK que la ata a `retiro`, y la clave unica.
 *   2. La compuerta, con PRUEBA NEGATIVA y su CONTROL POSITIVO en los dos
 *      sentidos: lo que antes se pisaba ahora convive, y lo que tenia que seguir
 *      siendo unico (el cierre) sigue siendolo. Un candado que deja pasar todo se
 *      ve igual de verde que uno que discrimina.
 *   3. La identidad del turno — que `SUM(retiro)` sume de verdad las dos
 *      sangrias, que es el numero del que cuelga `retiros_sin_verificar`.
 *
 * ⚠️ Los bloques sin datos reportan NO MEDIDO y NO se pintan verdes (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const WH_TEST = 'ZZ-RETSEQ';
const FECHA = '2026-01-03';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };

(async () => {
  try {
    console.log('\n[1] Schema');

    const col = (await knex.raw(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='reconciliation' AND table_name='blind_counts' AND column_name='secuencia'`)).rows;
    ok(col.length === 1, 'existe la columna secuencia');
    ok(col.length === 1 && col[0].is_nullable === 'NO', 'secuencia es NOT NULL — nunca es "no se sabe cual"');

    const ck = (await knex.raw(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint
      WHERE conrelid='reconciliation.blind_counts'::regclass AND conname='blind_counts_secuencia_check'`)).rows;
    ok(ck.length === 1 && /retiro/.test(ck[0].d),
      'el CHECK ata la secuencia a `retiro`: los otros cuatro tipos son unicos por definicion');

    const ix = (await knex.raw(`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='reconciliation' AND tablename='blind_counts' AND indexname LIKE 'uq_blind_count%'`)).rows;
    ok(ix.length === 1, `una sola clave unica en blind_counts (${ix.map((r) => r.indexname).join(', ')})`);
    ok(ix.length === 1 && /secuencia/.test(ix[0].indexdef),
      'la clave unica incluye secuencia — sin esto la segunda sangria del dia pisa a la primera');
    // La vieja sigue cubriendo lo que cubria: no se aflojo nada de paso.
    ok(ix.length === 1 && /route_code/.test(ix[0].indexdef),
      'y sigue incluyendo route_code (el candado de SM.36 no se aflojo)');

    console.log('\n[2] La compuerta');

    const ins = (trx, tipo, seq, caja, monto) => trx.raw(
      `INSERT INTO reconciliation.blind_counts
         (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, secuencia, denominations, total_contado)
       VALUES (?, ?, ?, ?, 'RETSEQ', ?, ?, '{}'::jsonb, ?)`,
      [T, WH_TEST, caja, FECHA, tipo, seq, monto]);

    await knex.transaction(async (trx) => {
      // CONTROL POSITIVO: la primera sangria entra, como siempre.
      await ins(trx, 'retiro', 1, '9', 15000);
      ok(true, 'CONTROL POSITIVO: la primera sangria del turno entra');

      // ⭐ LO QUE ESTE CAMBIO ARREGLA: la segunda convive en vez de pisar.
      await ins(trx, 'retiro', 2, '9', 15000);
      const n = (await trx.raw(
        `SELECT count(*)::int n FROM reconciliation.blind_counts
          WHERE warehouse_code = ? AND tipo = 'retiro'`, [WH_TEST])).rows[0].n;
      ok(n === 2, `dos sangrias del mismo turno conviven: ${n} filas (con la clave vieja habria sido 1)`);

      const suma = Number((await trx.raw(
        `SELECT COALESCE(SUM(total_contado),0) s FROM reconciliation.blind_counts
          WHERE warehouse_code = ? AND tipo = 'retiro'`, [WH_TEST])).rows[0].s);
      ok(suma === 30000, `y el total contado del turno suma las dos: ${suma} (antes habria sido 15000)`);

      // NEGATIVA: la MISMA sangria dos veces es la misma fila, no una nueva. Es la
      // correccion de un conteo, y tiene que seguir siendo un UPSERT.
      await trx.raw(
        `INSERT INTO reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, secuencia, denominations, total_contado)
         VALUES (?, ?, '9', ?, 'RETSEQ', 'retiro', 2, '{}'::jsonb, 777)
         ON CONFLICT (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), tipo,
                      COALESCE(route_code,''), secuencia)
         DO UPDATE SET total_contado = EXCLUDED.total_contado`,
        [T, WH_TEST, FECHA]);
      const tras = (await trx.raw(
        `SELECT count(*)::int n, COALESCE(SUM(total_contado),0) s FROM reconciliation.blind_counts
          WHERE warehouse_code = ? AND tipo = 'retiro'`, [WH_TEST])).rows[0];
      ok(Number(tras.n) === 2 && Number(tras.s) === 15777,
        `NEGATIVA: re-capturar la sangria 2 la REEMPLAZA, no la duplica (${tras.n} filas, ${tras.s})`);

      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    await knex.transaction(async (trx) => {
      // NEGATIVA: el cierre sigue siendo UNICO por turno. Es lo que la clave vieja
      // si hacia bien, y aflojarlo de paso habria sido el error simetrico.
      await ins(trx, 'cierre', 1, '9', 5000);
      let rechazoDobleCierre = false;
      try { await ins(trx, 'cierre', 1, '9', 6000); } catch (e) { rechazoDobleCierre = /unique|duplicad/i.test(e.message); }
      ok(rechazoDobleCierre, 'NEGATIVA: dos cierres del mismo turno siguen siendo RECHAZADOS');
      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    await knex.transaction(async (trx) => {
      // NEGATIVA: y no se puede colar un segundo cierre numerandolo. El CHECK es
      // lo que impide que `secuencia` se convierta en una puerta trasera.
      let rechazoCierreSeq = false;
      try { await ins(trx, 'cierre', 2, '9', 6000); } catch (e) { rechazoCierreSeq = /secuencia_check/.test(e.message); }
      ok(rechazoCierreSeq, 'NEGATIVA: un cierre con secuencia 2 es RECHAZADO por el CHECK');

      let rechazoCero = false;
      try { await ins(trx, 'retiro', 0, '9', 100); } catch (e) { rechazoCero = /secuencia_check/.test(e.message); }
      ok(rechazoCero, 'NEGATIVA: secuencia 0 es RECHAZADA — la numeracion arranca en 1');
      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    console.log('\n[3] Lo que esto vale en la data real');

    const reales = (await knex.raw(`
      SELECT count(*)::int AS turnos
        FROM (
          SELECT 1 FROM reconciliation.blind_counts
           WHERE tipo = 'retiro'
           GROUP BY tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,'')
          HAVING count(*) > 1
        ) d`)).rows[0];
    if (Number(reales.turnos) > 0) {
      ok(true, `${reales.turnos} turno(s) ya tienen mas de una sangria contada: con la clave vieja no cabian`);
    } else {
      // ⚠️ Cero NO es "esto no servia": la fila pisada no existe, asi que la tabla
      // no puede distinguir "se perdio" de "nunca se conto". Se declara.
      noMedido('todavia ningun turno tiene dos sangrias contadas — la fila pisada no deja rastro, '
        + 'asi que esto no dice si el bug ocurrio, solo que a partir de ahora no puede ocurrir');
    }

    const hueco = (await knex.raw(`
      SELECT count(*)::int AS cortes,
             round(COALESCE(SUM(cc.efectivo_retirado - b.total_contado), 0), 2) AS sin_contar
        FROM reconciliation.blind_counts b
        JOIN analytics.cash_cuts cc
          ON cc.tenant_id = b.tenant_id AND cc.warehouse_code = b.warehouse_code
         AND cc.caja = b.caja AND cc.business_date = b.business_date
       WHERE b.tipo = 'retiro' AND cc.efectivo_retirado > b.total_contado * 1.5`)).rows[0];
    if (Number(hueco.cortes) > 0) {
      console.log(`  · contexto: ${hueco.cortes} turnos donde Kepler retiro mucho mas de lo contado `
        + `($${hueco.sin_contar} sin contar). Compatible con "solo conto una de N" Y con el pisado: `
        + 'la tabla no los distingue.');
    } else {
      noMedido('sin cortes donde Kepler retire mas de lo contado — no hay contexto que medir');
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nm} no medidos`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n❌ El smoke reviento:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
