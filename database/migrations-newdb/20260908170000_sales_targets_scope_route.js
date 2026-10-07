/**
 * RD.7 — `commercial.sales_targets` acepta `scope = 'route'`.
 *
 * BI.9 nació con tres alcances: `total`, `branch` y `channel`. La Ruta Directa se mide por
 * RUTA —es la unidad con la que se opera, se paga la comisión y se mide el $/km—, y el canal
 * `'ruta'` agregado no sirve: junta las 13 rutas en un solo número.
 *
 * `scope_key` = el `route_code` (`'21'`…`'505'`), el mismo vocabulario que
 * `analytics.v_rd_route_daily` y `commercial.commission_route_config`. Sin traducción de
 * códigos en el medio: el proyecto ya tiene cuatro convenciones de nombre de ruta
 * (`UDxxxx`, `WIN-NN`, `ruta_NN`, `R00NN`) y ésta no agrega una quinta.
 *
 * El real de una ruta NO puede salir de `v_sellout_daily`: esa vista mete la venta de ruta
 * como `warehouse_code LIKE 'RUTA-%'` y no distingue las 13. Sale de
 * `analytics.v_rd_route_daily`, que es la vista de RD.2.
 *
 * ⚠️ Esto NO migra las hojas `HOJA DE LLENADO OBJETIVO MENSUA` / `OBJETIVO MENSUAL RD`: son
 * de **2021**, con calendario de 13 periodos de 28 días, supervisores que ya no existen, y
 * bloques con el cumplimiento **hardcodeado** (`AL5="CUMPLIDO"` literal) que pagaban $500 por
 * ruta sobre un dato inventado. Lo que se habilita acá es un objetivo de MONTO por ruta y
 * mes, que es cosa distinta y verificable.
 *
 * @param { import("knex").Knex } knex
 */
const CHECK = 'commercial_sales_targets_scope_valid';

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('sales_targets'))) {
    console.log('[sales_targets_scope_route] commercial.sales_targets no existe todavía (BI.9 pendiente) — nada que hacer');
    return;
  }
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ?`, [CHECK]);
  if (rows.length && /'route'/.test(rows[0].def)) return; // idempotente

  await knex.raw(`ALTER TABLE commercial.sales_targets DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`
    ALTER TABLE commercial.sales_targets
      ADD CONSTRAINT ${CHECK}
      CHECK (scope IN ('total','branch','channel','route'))`);
  await knex.raw(`
    COMMENT ON COLUMN commercial.sales_targets.scope IS
      'total (scope_key='''') | branch (warehouse_code) | channel (canal) | route (route_code de RD, ej. 21 o 505 — RD.7). El real de una ruta sale de analytics.v_rd_route_daily: v_sellout_daily mete la venta de ruta como warehouse_code LIKE RUTA-% y no distingue las 13.'`);
  console.log(`[sales_targets_scope_route] up: scope ahora acepta 'route'`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('sales_targets'))) return;
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM commercial.sales_targets WHERE scope = 'route'`);
  if (rows[0].n) {
    throw new Error(`Hay ${rows[0].n} metas con scope='route': borralas antes de revertir, o se quedarían violando el CHECK`);
  }
  await knex.raw(`ALTER TABLE commercial.sales_targets DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`
    ALTER TABLE commercial.sales_targets
      ADD CONSTRAINT ${CHECK}
      CHECK (scope IN ('total','branch','channel'))`);
};
