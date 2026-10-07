/**
 * commercial.customers: dos columnas comerciales nuevas.
 *
 *  - whatsapp varchar(20): numero de WhatsApp del cliente, normalizado a E.164
 *    (+52...). Distinto de `phone` (display generico, datos legacy heterogeneos).
 *    Indice UNIQUE PARCIAL (tenant_id, whatsapp) para que el bot rutee un numero
 *    a UN solo cliente por tenant.
 *  - sales_route varchar(50): ruta de VENTA del cliente (territorio comercial,
 *    ej. "RUTA 21"). Hoy vive como texto en `notes` ("Ruta: RUTA 21") en ~97% de
 *    los clientes ERP; se backfillea con un script aparte. NO es la ruta logistica
 *    de reparto (esa vive en route_id -> logistics.routes, hoy vacia).
 *
 * Idempotente (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS).
 * Aplica a local Y prod via el flujo normal de migrate (start.sh en el deploy).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS whatsapp varchar(20)');
  await knex.raw('ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS sales_route varchar(50)');

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_customers_whatsapp
      ON commercial.customers (tenant_id, whatsapp)
      WHERE whatsapp IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_customers_sales_route
      ON commercial.customers (tenant_id, sales_route)
      WHERE sales_route IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.uq_commercial_customers_whatsapp');
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_commercial_customers_sales_route');
  await knex.raw('ALTER TABLE commercial.customers DROP COLUMN IF EXISTS whatsapp');
  await knex.raw('ALTER TABLE commercial.customers DROP COLUMN IF EXISTS sales_route');
};
