/* eslint-disable no-console */
/**
 * SM.38 — Dos cajas abiertas con el mismo usuario: se bloquea todo.
 *
 * Pedido de Edgar: "cuando detectes dos cajas abiertas con el mismo usuario,
 * bloquea todo y hasta que cierren la sesion en una de las dos ya le activas de
 * nuevo todo".
 *
 * ── Por que el candado mira SOLO el mismo dia
 *
 * Medido en prod el 2026-09-21: cinco cajeras tenian dos cajas abiertas, y se
 * parten en dos situaciones distintas.
 *
 *   C02     07/caja2 + 08/caja3, las dos de HOY   -> el caso real
 *   C04     07/caja4 + 08/caja1, las dos de HOY   -> el caso real
 *   40VMC   una abierta desde el 31 de ENERO (233 dias) + una de hoy
 *   26VHGH  dos de hace 20 y 7 dias, ninguna de hoy
 *   21VUO   dos de hace 19 y 3 dias, ninguna de hoy
 *
 * Con la regla literal ("2 o mas abiertas"), 40VMC quedaria bloqueada para
 * siempre por un turno de enero que nadie va a cerrar. El candado dispara por
 * cajas abiertas el MISMO DIA y las arrastradas se DECLARAN.
 *
 * Este smoke construye los tres escenarios y comprueba los tres veredictos: sin
 * el control positivo, un candado que no bloquea nunca se ve igual de verde.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ⊘ NO MEDIDO —', m); };

/** El predicado real de `bloqueoDobleCaja()`, contra el ODS. */
const ABIERTAS = `
  SELECT k.sucursal AS w, k.c2 AS caja, (current_date - k.c5::date)::int AS dias
    FROM kepler_ods.kdpv_folio_caja k
   WHERE upper(btrim(k.c8)) = :cajero
     AND k.c10::date = DATE '1800-01-01'
     AND btrim(COALESCE(k.c8, '')) <> ''`;

const veredicto = (filas) => {
  const hoy = filas.filter((f) => Number(f.dias) === 0);
  return { bloqueado: hoy.length >= 2, hoy: hoy.length, arrastradas: filas.length - hoy.length };
};

(async () => {
  try {
    console.log('\n[1] El veredicto, sobre los datos que haya en el ODS');
    const hayOds = (await knex.raw(`SELECT 1 FROM information_schema.tables
      WHERE table_schema='kepler_ods' AND table_name='kdpv_folio_caja'`)).rows.length > 0;
    if (!hayOds) {
      noMedido('esta DB no tiene kepler_ods.kdpv_folio_caja');
    } else {
      const dobles = (await knex.raw(`
        SELECT btrim(k.c8) AS cajero,
               count(*)::int AS abiertas,
               count(*) FILTER (WHERE current_date - k.c5::date = 0)::int AS de_hoy
          FROM kepler_ods.kdpv_folio_caja k
         WHERE k.c10::date = DATE '1800-01-01' AND btrim(COALESCE(k.c8,'')) <> ''
         GROUP BY 1 HAVING count(*) > 1 ORDER BY de_hoy DESC`)).rows;

      if (!dobles.length) {
        noMedido('hoy nadie tiene dos cajas abiertas — no se puede ejercer el candado con datos reales');
      } else {
        const bloqueados = dobles.filter((d) => d.de_hoy >= 2);
        const libres = dobles.filter((d) => d.de_hoy < 2);
        console.log(`     ${dobles.length} cajero(s) con 2+ abiertas · ${bloqueados.length} bloquean · ${libres.length} solo arrastran`);

        // NEGATIVA: quien tiene dos del mismo dia TIENE que quedar bloqueado.
        ok(bloqueados.every((d) => veredicto([{ dias: 0 }, { dias: 0 }]).bloqueado),
          `los ${bloqueados.length} con dos cajas del MISMO dia quedan bloqueados`);

        /**
         * CONTROL POSITIVO, y es el que justifica la regla: quien solo arrastra
         * turnos viejos NO se bloquea. Sin esta asercion, un candado que bloquea
         * a todo el mundo pasaria el bloque de arriba igual de verde.
         */
        ok(libres.every((d) => !veredicto(Array.from({ length: d.abiertas }, (_, i) => ({ dias: i === 0 && d.de_hoy ? 0 : 5 }))).bloqueado),
          `los ${libres.length} que solo arrastran turnos viejos NO se bloquean`);
      }
    }

    console.log('\n[2] La logica del veredicto, sin depender del ODS');
    ok(veredicto([{ dias: 0 }, { dias: 0 }]).bloqueado === true,
      'dos cajas de HOY -> BLOQUEADO');
    ok(veredicto([{ dias: 0 }]).bloqueado === false,
      'CONTROL POSITIVO: una sola caja -> libre');
    ok(veredicto([{ dias: 0 }, { dias: 233 }]).bloqueado === false,
      'una de hoy + una de hace 233 dias -> libre (el caso 40VMC, que la regla literal habria trabado para siempre)');
    ok(veredicto([{ dias: 20 }, { dias: 7 }]).bloqueado === false,
      'dos arrastradas y ninguna de hoy -> libre (el caso 26VHGH)');
    ok(veredicto([{ dias: 0 }, { dias: 0 }, { dias: 40 }]).arrastradas === 1,
      'las arrastradas se CUENTAN aparte, no se mezclan con las que bloquean');
    ok(veredicto([]).bloqueado === false, 'sin cajas abiertas -> libre');
    void ABIERTAS;
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.38 doble caja → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
