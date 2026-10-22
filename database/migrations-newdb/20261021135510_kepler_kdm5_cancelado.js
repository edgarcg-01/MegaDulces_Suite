'use strict';
/**
 * `[CSU.13]` — **La hermana de `kepler_kdm5_vigente`: sólo las aplicaciones de documentos CANCELADOS.**
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 *
 * `[CSU.11]` sacó del corte los cobros cancelados en Kepler, que inflaban el cobrado. El PM pidió
 * omitir los MONTOS, no esconder el documento: buscó en Cortes el cobro cancelado y «no aparece».
 * La respuesta correcta es mostrarlo marcado como «Cancelado en Kepler — no suma», y que el
 * buscador lo encuentre.
 *
 * Para eso hace falta leer las aplicaciones canceladas, y la regla de «qué está cancelado» ya
 * tiene casa: la vista vigente. Ésta es su COMPLEMENTO exacto, con la misma condición escrita una
 * sola vez en cada lado y verificada al crearse: vigentes + canceladas = kdm5. Si un día la regla
 * cambia en una vista y no en la otra, la cuenta deja de cerrar y la migración siguiente lo ve.
 *
 * Medido en prod (2026-10-21): 854 aplicaciones; 14 de ellas a cortes de octubre ($171,986.56),
 * por ejemplo el `UA0501-0000075` ($10,962.00) del corte `06/UD2301-0000033`.
 *
 * ⛔ **Esta vista NO se suma.** Sirve para MOSTRAR lo cancelado. `check:kdm5-vigente:db` la declara.
 *
 * Idempotente (`CREATE OR REPLACE`). Requiere `20261021102646_kepler_kdm5_vigente`.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.kepler_kdm5_cancelado';

exports.up = async function up(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm5') a, to_regclass('kepler_ods.kdm1') b, to_regclass('analytics.kepler_kdm5_vigente') v`);
  if (!ods.rows[0]?.a || !ods.rows[0]?.b) return; // dev sin ODS
  if (!ods.rows[0]?.v) throw new Error('[CSU.13] falta analytics.kepler_kdm5_vigente: aplicar antes 20261021102646');

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '120s'`);
  // La MISMA condición que la vigente, en positivo: documento dueño (sucursal = c1) con c43 = 'C'.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    SELECT a.*
      FROM kepler_ods.kdm5 a
     WHERE EXISTS (
       SELECT 1
         FROM kepler_ods.kdm1 k
        WHERE k.sucursal = a.c1 AND k.c1 = a.c1 AND k.c2 = a.c2 AND k.c3 = a.c3
          AND k.c4 = a.c4 AND k.c5 = a.c5 AND k.c6 = a.c6
          AND btrim(coalesce(k.c43, '')) = 'C')`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${VISTA} TO dev_ro'; END IF;
  END $$`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[CSU.13] Complemento de kepler_kdm5_vigente: SOLO las aplicaciones de documentos cancelados en Kepler (kdm1.c43 = C del documento dueno). Para MOSTRAR lo cancelado marcado; NUNCA se suma.'`);

  // vigentes + canceladas = kdm5, exacto: las dos vistas son complementarias.
  const { rows } = await knex.raw(`
    SELECT (SELECT count(*) FROM kepler_ods.kdm5)::bigint kdm5,
           (SELECT count(*) FROM analytics.kepler_kdm5_vigente)::bigint vigentes,
           (SELECT count(*) FROM ${VISTA})::bigint canceladas`);
  const r = rows[0];
  if (Number(r.vigentes) + Number(r.canceladas) !== Number(r.kdm5)) {
    throw new Error(`[CSU.13] vigentes ${r.vigentes} + canceladas ${r.canceladas} ≠ kdm5 ${r.kdm5}: las vistas ya no son complementarias.`);
  }
  console.log(`  [CSU.13] ${VISTA}: ${r.canceladas} aplicaciones canceladas (vigentes ${r.vigentes} + canceladas = ${r.kdm5})`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Aborta si algo ya depende de la vista. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA} RESTRICT`);
};
