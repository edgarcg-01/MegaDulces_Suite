/**
 * RS.12b — Optimizar el path EN VIVO de sell-out (v_sales_lines) que tumbó el pool.
 *
 * Diagnóstico (EXPLAIN 2026-08-05): la vista filtra por `(fecha)::date`, y el cast INUTILIZA
 * el índice `ix_wcj_maestro_fecha (…, fecha)` → **Seq Scan de 1.44M filas** de
 * `maestro_mov_almacen` en CADA consulta (costo ~46k). Además el CTE `conc_dates` hace un
 * DISTINCT sobre TODA la maestra 'concentrada' en cada query (costo fijo ~48k, no escala).
 *
 * Fix = dos índices por EXPRESIÓN sobre `((fecha)::date)` (matchean exactamente lo que hace
 * la vista → el planner los usa sin tocar la vista):
 *   1) date-range: filtro business_date pasa de Seq Scan a Index Scan (escala con el rango).
 *   2) parcial 'concentrada': el DISTINCT de conc_dates se vuelve index-only → mata el tax fijo.
 *
 * CONCURRENTLY (sin lock de escritura) → la migración NO corre en transacción.
 * Junto con statement_timeout='45s' (RS.12) el path en vivo deja de poder tumbar el pool.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_wcj_maestro_fecha_date
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, ((fecha)::date))`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_wcj_maestro_concdates
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, ((fecha)::date))
      WHERE source_dataset = 'concentrada'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.ix_wcj_maestro_fecha_date`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.ix_wcj_maestro_concdates`);
};
