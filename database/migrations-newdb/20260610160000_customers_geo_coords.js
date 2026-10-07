/**
 * Geo de clientes — autodetección de llegada del vendedor (Modo Vendedor v2).
 *
 * commercial.customers gana latitude/longitude (DECIMAL 9,6 ~ 11 cm, igual que
 * commercial.vendor_visits). Nullable: se pueblan "capture-on-visit" desde el
 * GPS del vendedor al hacer check-in / tomar pedido (con guard anti-traslape en
 * el backend para no asignar coords que colisionen con otro cliente ya registrado).
 *
 * Idempotente (hasColumn). RLS/grants ya existen en la tabla; no se tocan.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasLat = await knex.schema.withSchema('commercial').hasColumn('customers', 'latitude');
  if (!hasLat) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => {
      t.decimal('latitude', 9, 6);
      t.decimal('longitude', 9, 6);
    });
  }
  // Índice parcial: solo clientes geolocalizados entran a la detección de cercanía.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_customers_geo
      ON commercial.customers (tenant_id)
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_customers_geo`);
  const hasLat = await knex.schema.withSchema('commercial').hasColumn('customers', 'latitude');
  if (hasLat) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => {
      t.dropColumn('latitude');
      t.dropColumn('longitude');
    });
  }
};
