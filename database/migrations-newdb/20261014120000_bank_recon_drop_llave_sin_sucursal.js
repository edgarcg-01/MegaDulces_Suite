/**
 * `[CB.50]` **Retira el índice único que no lleva la sucursal.** Es el segundo tiempo que
 * `[CC.13]` (mig 20260925120100) dejó declarado: aquella agregó
 * `bank_recon_matches_doc_suc_key` (5 columnas, con `kepler_sucursal`) y **a propósito no borró
 * la vieja de 4**, porque el código en vivo podía depender de ella.
 *
 * Hoy ya no: ningún lugar del repo usa `ON CONFLICT` sobre `finance.bank_recon_matches`
 * (verificado por grep sobre `libs/` y `apps/`), el motor hace `DELETE` por `bank_movement_id`
 * y luego `INSERT` simple. Lo único que la llave corta produce ahora es **bloquear filas
 * legítimas**: dos documentos de plazas distintas que comparten `doc_tipo`+`folio` son
 * documentos DISTINTOS, y con la llave de 4 el segundo violaba la restricción.
 *
 * ⛔ **Esta migración RELAJA** (una llave más larga admite todo lo que admitía la corta), así que
 * es segura de aplicar ANTES del deploy y el código viejo sigue funcionando sin cambios.
 *
 * ⚠️ Medido el 2026-10-14 antes de tocar nada: `kepler_sucursal` estaba poblada en **0 de 20,926
 * filas** — o sea que la llave de 5 columnas que `[CC.13]` creó venía comportándose **igual que
 * la de 4**, porque Postgres trata los NULL como distintos. El commit de `[CB.50]` empieza a
 * escribir la columna; las filas históricas se corrigen solas conforme cada periodo se
 * re-concilia (el motor borra y reinserta el periodo completo).
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'finance.bank_recon_matches';
const VIEJA = 'bank_recon_matches_tenant_id_bank_movement_id_kepler_doc_ti_key';
const NUEVA = 'bank_recon_matches_doc_suc_key';

exports.up = async function up(knex) {
  const hay = await knex.raw(`SELECT to_regclass('${TABLA}') t`);
  if (!hay.rows[0].t) return; // entorno sin el módulo de bancos

  // No se da por sentado el efecto de la migración anterior: si la llave larga no está, no se
  // retira la corta — quedaríamos sin ninguna y el motor podría duplicar filas en silencio.
  const nueva = await knex.raw(`SELECT 1 FROM pg_indexes WHERE schemaname='finance' AND indexname=?`, [NUEVA]);
  if (!nueva.rows.length) {
    console.log(`[CB.50] falta ${NUEVA} — no se retira ${VIEJA}. Corré antes 20260925120100.`);
    return;
  }
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${VIEJA}`);
  await knex.raw(`DROP INDEX IF EXISTS finance.${VIEJA}`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.kepler_sucursal IS
    '[CB.50] Parte de la IDENTIDAD del documento de Kepler, junto con doc_tipo+folio+cuenta: el folio reinicia por sucursal y por año. NULL = fila escrita antes de 2026-10-14, cuando nadie la poblaba; el candado anti doble-cobro cae a llave parcial para esas y lo DECLARA en el resultado de Conciliar.'`);
};

exports.down = async function down(knex) {
  const hay = await knex.raw(`SELECT to_regclass('${TABLA}') t`);
  if (!hay.rows[0].t) return;
  // Re-crear la corta puede fallar si ya hay filas que sólo difieren por sucursal: es
  // exactamente lo que esta migración vino a permitir. Se avisa en vez de romper el rollback.
  try {
    await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${VIEJA}
      UNIQUE (tenant_id, bank_movement_id, kepler_doc_tipo, kepler_doc_folio)`);
  } catch (e) {
    console.log(`[CB.50] down: no se pudo recrear ${VIEJA} (${e.message}). Hay filas que sólo difieren por sucursal.`);
  }
};
