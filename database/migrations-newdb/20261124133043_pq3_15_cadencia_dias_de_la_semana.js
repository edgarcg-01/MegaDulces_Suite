'use strict';
/**
 * `[PQ.3.15]` — Calendario de compras: la CADENCIA de una regla por días de la semana (DC29, anexo C §10.12).
 *
 * Pedido de los usuarios al día siguiente de salir a prod: bajo los días de la semana, «cada semana, cada 2 semanas,
 * cada 3 semanas, 1 vez al mes y cada 6 semanas». Hasta hoy un proveedor que pasa «un martes sí y otro no» sólo se
 * podía guardar como «cada 14 días», que cuenta desde la última OC o entrada de Kepler y se mueve con ella.
 *
 *   · `week_interval` — cada cuántas semanas: 2, 3 o 6 (NULL = cada semana, como hasta hoy).
 *   · `week_anchor`   — a partir de qué fecha: su semana (de lunes a domingo) es la semana 0, y no hay revisiones
 *                       antes de ella. Va con `week_interval`, ni uno sin el otro.
 *   · `month_week`    — «una vez al mes» (DC29, Francisco): el 1º, 2º, 3º o 4º de ese día en el mes, o 5 = el último.
 *                       No se mezcla con `week_interval`.
 *
 * Las tres sólo valen en `pattern = 'weekdays'`; en los otros patrones van NULL. Las mismas listas viven en el
 * contrato (`CADENCIAS_SEMANA`, `validarRegla`): la base y la pantalla dicen lo mismo.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-24) ───────────────────
 *  · 9 reglas vivas, todas capturadas el 24-nov: 6 de zona, 3 de todas las sucursales; 0 marcas. Ninguna usa
 *    cadencia (no existía): las tres columnas nacen NULL y el CHECK las deja pasar.
 *  · La hoja de las próximas semanas (anexo C §10.9): las 3 reglas quincenales de día fijo daban 0 de 7 fechas
 *    iguales con «cada 14 días».
 *
 * Columnas nuevas, sin valor por omisión (sólo metadatos) y un CHECK sobre 9 renglones. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'purchase_review_rules';
const CHECK = 'purchase_review_rules_cadence_chk';

/**
 * ⚠️ Un constructor de `knex.schema` NUEVO por pregunta: si se reusa uno, knex ACUMULA las instrucciones y el segundo
 * `hasColumn` contesta con lo de la primera (la prueba contra Postgres real lo encontró: `week_anchor` no se creaba).
 */
const tiene = (knex, columna) => knex.schema.withSchema('commercial').hasColumn(TABLA, columna);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await tiene(knex, 'week_interval'))) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN week_interval smallint`);
  if (!(await tiene(knex, 'week_anchor'))) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN week_anchor date`);
  if (!(await tiene(knex, 'month_week'))) await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN month_week smallint`);

  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'commercial.${TABLA}'::regclass`, [CHECK]);
  if (!rows.length) {
    // ⚠️ Envuelto en COALESCE(…, false) como `purchase_review_rules_pattern_chk`: un CHECK que da NULL deja pasar la fila.
    await knex.raw(`
      ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CHECK} CHECK (COALESCE(
           (pattern = 'weekdays'
              AND (week_interval IS NULL OR week_interval IN (2, 3, 6))
              AND ((week_interval IS NULL) = (week_anchor IS NULL))
              AND (month_week IS NULL OR month_week BETWEEN 1 AND 5)
              AND NOT (week_interval IS NOT NULL AND month_week IS NOT NULL))
        OR (pattern <> 'weekdays' AND week_interval IS NULL AND week_anchor IS NULL AND month_week IS NULL),
        false))`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  for (const c of ['month_week', 'week_anchor', 'week_interval']) {
    if (await tiene(knex, c)) await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN ${c}`);
  }
};
