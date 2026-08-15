/**
 * NORMALIZACIÓN — ALMACÉN (clase B, dimensión-crosswalk). Paso 1: columnas crosswalk.
 *
 * `commercial.warehouses` (uuid, RLS FORCE) YA es la dim canónica de almacén. El problema
 * es que las N representaciones (kepler `sucursal` 00-05, wincaja `source_branch` 30/32/50/00,
 * `warehouse_code` tipo MD-NN o RUTA-NN) se mapean HOY con `STOCK_BRANCH_MAP` hardcodeado y
 * duplicado en ~6 importers. Este paso mueve ese mapeo a la DB como columnas explícitas de la dim, con
 * UNIQUE por namespace → una sola fuente del crosswalk. ADITIVO: no toca ninguna lectura
 * existente (columnas nuevas, nullable). El backfill de datos va en un script aparte
 * (database/scripts/backfill-warehouse-crosswalk.js), NO acá (DDL != datos).
 *
 * Idempotente (hasColumn). down() real (dropea columnas + índices).
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('commercial').hasColumn('warehouses', col);

  if (!(await has('kepler_code'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.text('kepler_code'); // sucursal Kepler '00'..'05' (md_00..md_05)
    });
  }
  if (!(await has('wincaja_source_branch'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.text('wincaja_source_branch'); // source_branch Wincaja: '00'(Irapuato CEDIS), '30','32','50'
    });
  }
  if (!(await has('sells_to_public'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.boolean('sells_to_public'); // sucursal/PdV que vende a público (retail/ruta) vs CEDIS/mayoreo
    });
  }

  // UNIQUE por namespace (parcial: solo filas vivas con valor) — evita que dos warehouses
  // reclamen el mismo código Kepler/Wincaja dentro del mismo tenant.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS warehouses_kepler_code_uq
      ON commercial.warehouses (tenant_id, kepler_code)
      WHERE kepler_code IS NOT NULL AND deleted_at IS NULL`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS warehouses_wincaja_branch_uq
      ON commercial.warehouses (tenant_id, wincaja_source_branch)
      WHERE wincaja_source_branch IS NOT NULL AND deleted_at IS NULL`);

  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.kepler_code IS
    'Crosswalk canónico → sucursal Kepler (00-05). Reemplaza STOCK_BRANCH_MAP hardcodeado. Backfill: scripts/backfill-warehouse-crosswalk.js'`);
  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.wincaja_source_branch IS
    'Crosswalk canónico → source_branch Wincaja (00 Irapuato/30/32/50).'`);
  await knex.raw(`COMMENT ON COLUMN commercial.warehouses.sells_to_public IS
    'true = sucursal/PdV o camión de ruta (vende a público); false = CEDIS/mayoreo.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.warehouses_kepler_code_uq`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.warehouses_wincaja_branch_uq`);
  for (const col of ['kepler_code', 'wincaja_source_branch', 'sells_to_public']) {
    if (await knex.schema.withSchema('commercial').hasColumn('warehouses', col)) {
      await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => t.dropColumn(col));
    }
  }
};
