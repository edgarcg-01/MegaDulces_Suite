/**
 * Sprint catálogo limpio — agrega flag `is_commercial` a brands.
 *
 * Marca como no-comerciales 17 brands "fantasma" que no son fabricantes reales:
 * eliminados, promos internas, empaque, productos administrativos, abarrotes
 * genéricos, etc. Total esperado: ~2,548 productos.
 *
 * Default `true` para no romper nada — solo se marcan false los que conocemos.
 * Endpoints cliente-facing (portal/vendor/recommendations) filtran por
 * `is_commercial = true`. Admin endpoints (CRUD, analytics gerencia) muestran todo.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE brands
      ADD COLUMN IF NOT EXISTS is_commercial BOOLEAN NOT NULL DEFAULT true
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_brands_tenant_commercial
      ON brands (tenant_id, is_commercial)
      WHERE is_commercial = true AND deleted_at IS NULL
  `);

  const NON_COMMERCIAL = [
    'PRODUCTOS A ELIMINAR',
    'PROMOCIONES',
    'PRODUCTOS CON BAJA ROTACION',
    'MEGA DULCES DE LOS ALTOS',
    'G INDIVIDUALES',
    'PRODUCTOS VARIOS',
    'BOLSAS DE LOS ALTOS S. DE R.L DE C.V.',
    'BOLSAS DE LOS ALTOS',
    'POLIETILENOS DEL CENTRO S.A DE C.V.',
    'RIFA ROSI',
    'ABARROTES',
    'ABARROTES SAGITARIO',
    'ABARROTES LA VIOLETA',
    'ADMINISTRATIVO',
    'PROMOCIONES ESPECIALES',
    'JOSE IVAN VELAZQUEZ JUAREZ',
    'PRODUCTOS DE CALIDAD',
  ];

  const updated = await knex('brands')
    .whereIn('nombre', NON_COMMERCIAL)
    .update({ is_commercial: false });

  console.log(`  ✓ Marked ${updated} brands as non-commercial`);

  await knex.raw(`COMMENT ON COLUMN brands.is_commercial IS 'false = brand operativa/admin/promocional, no producto comercial real. Endpoints cliente-facing (portal/vendor/recommendations) filtran por true. Default true.'`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_brands_tenant_commercial`);
  await knex.raw(`ALTER TABLE brands DROP COLUMN IF EXISTS is_commercial`);
};
