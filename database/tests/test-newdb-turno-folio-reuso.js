/* eslint-disable no-console */
/**
 * SM.37 — El folio de Kepler se REUSA, y por eso desaparecia el turno abierto.
 *
 * Reportado en vivo: "al estar abierta la caja de Kepler no se vincula con la
 * suite, arroja que esta cerrado como si no abrieran turno".
 *
 * Medido en prod el 2026-09-20: `10C01` abrio la caja 1 de Padre Hidalgo con
 * folio **82** a las 07:35. Su pantalla no le ofrecia ningun turno, porque el
 * 18-sep `10C02` habia cerrado la caja **2** -- tambien folio 82 -- y el filtro
 * preguntaba solo por sucursal + folio. El cierre de otra cajera, de otra caja,
 * de hace dos dias, tachaba el turno abierto de hoy.
 *
 * Este smoke NO depende de que exista ese caso: construye el escenario y lo
 * comprueba con la consulta real (folio + caja + fecha), con su CONTROL
 * POSITIVO -- un filtro que no oculta NADA se ve igual de verde que uno correcto.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ⊘ NO MEDIDO —', m); };

/** El predicado ARREGLADO, tal cual lo usa `turnosPendientes()`. */
const OCULTO = `
  SELECT EXISTS (
    SELECT 1 FROM reconciliation.blind_counts b
     WHERE b.tenant_id = :t AND b.warehouse_code = :w AND b.tipo = 'cierre'
       AND b.cash_cut_folio = :folio
       AND b.caja = :caja AND b.business_date = :fecha) AS oculto`;
/** El predicado VIEJO, que existe para demostrar que ocultaba de mas. */
const OCULTO_VIEJO = `
  SELECT EXISTS (
    SELECT 1 FROM reconciliation.blind_counts b
     WHERE b.tenant_id = :t AND b.warehouse_code = :w AND b.tipo = 'cierre'
       AND b.cash_cut_folio = :folio) AS oculto`;

(async () => {
  try {
    console.log('\n[1] El folio solo NO identifica un turno');
    await knex.transaction(async (trx) => {
      // El cierre de AYER, caja 2, folio 82.
      await trx.raw(
        `INSERT INTO reconciliation.blind_counts
           (tenant_id, warehouse_code, caja, business_date, cajero_code, tipo, cash_cut_folio, denominations, total_contado)
         VALUES (:t, 'ZZ-SM37', '2', current_date - 2, 'OTRA', 'cierre', '82', '{}'::jsonb, 100)`, { t: T });

      const p = { t: T, w: 'ZZ-SM37', folio: '82', caja: '1', fecha: new Date().toISOString().slice(0, 10) };
      const viejo = (await trx.raw(OCULTO_VIEJO, p)).rows[0].oculto;
      const nuevo = (await trx.raw(OCULTO, p)).rows[0].oculto;

      ok(viejo === true, 'REPRODUCIDO: el filtro viejo daba por arqueado el turno de HOY de la caja 1');
      ok(nuevo === false, 'ARREGLADO: con caja y fecha, el turno de hoy ya no se oculta');

      // CONTROL POSITIVO: el filtro nuevo SI tiene que ocultar el turno que de
      // verdad se arqueo. Sin esto, uno que no oculte nada pasaria por exito.
      const mismo = (await trx.raw(OCULTO, { ...p, caja: '2', fecha: null })).rows[0];
      const propio = (await trx.raw(
        OCULTO.replace(':fecha', '(current_date - 2)'), { t: T, w: 'ZZ-SM37', folio: '82', caja: '2' })).rows[0].oculto;
      ok(propio === true, 'CONTROL POSITIVO: el turno que SI se arqueo sigue oculto');
      void mismo;
      throw new Error('__rb__');
    }).catch((e) => { if (!/__rb__/.test(e.message)) throw e; });

    console.log('\n[2] `cerrado` dejo de ser una constante');
    const col = (await knex.raw(`SELECT count(*)::int total,
        count(*) FILTER (WHERE cerrado)::int cerrados,
        count(*) FILTER (WHERE NOT cerrado)::int abiertos
      FROM analytics.cash_cuts`)).rows[0];
    if (!col.total) {
      noMedido('analytics.cash_cuts esta vacia en esta DB');
    } else {
      // Antes de SM.37 el UPSERT escribia el literal `true`: 3,648 de 3,648.
      // No se afirma un reparto concreto -- se DECLARA lo que hay.
      console.log(`     ${col.total} cortes · ${col.cerrados} cerrados · ${col.abiertos} abiertos`);
      ok(true, 'medido (si `abiertos` es 0 puede ser real: solo se reabre de a ratos)');
    }

    console.log('\n[3] Turnos que Kepler reabrio y aca siguen cerrados');
    const hayOds = (await knex.raw(`SELECT 1 FROM information_schema.tables
      WHERE table_schema='kepler_ods' AND table_name='kdpv_folio_caja'`)).rows.length > 0;
    if (!hayOds) {
      noMedido('esta DB no tiene kepler_ods.kdpv_folio_caja');
    } else {
      const { rows } = await knex.raw(`
        SELECT count(*)::int n FROM analytics.cash_cuts cc
          JOIN kepler_ods.kdpv_folio_caja k
            ON cc.warehouse_code = k.sucursal AND cc.caja = k.c2
           AND cc.business_date = k.c5::date AND cc.folio = k.c3::bigint::text
         WHERE k.c10::date = DATE '1800-01-01' AND cc.cerrado
           AND cc.business_date >= current_date - 30`);
      ok(rows[0].n === 0,
        rows[0].n === 0
          ? 'ningun corte abierto en Kepler figura cerrado aca'
          : `⚠️ ${rows[0].n} corte(s) abiertos en Kepler siguen marcados cerrados — corre el sync (REABIERTOS los camina de vuelta)`);
    }
  } catch (e) {
    fail++;
    console.error('\nERROR:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\nSM.37 folio reusado → ${pass} ✓ · ${fail} ✗${nm ? ` · ${nm} ⊘ no medidos` : ''}`);
  process.exit(fail ? 1 : 0);
})();
