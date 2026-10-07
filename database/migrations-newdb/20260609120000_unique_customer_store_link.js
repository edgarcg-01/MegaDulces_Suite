/**
 * Integridad 1:1 tienda↔cliente: un store solo puede estar vinculado a UN
 * customer activo. Refuerza el modelo "cada tienda es un cliente" — evita que
 * dos customers (alta manual + auto-provisionado al crear la tienda) apunten al
 * mismo store_id.
 *
 * Índice único PARCIAL: solo cubre vínculos vivos (store_id NOT NULL + customer
 * no soft-deleted), así un store_id se puede reusar si el customer previo fue
 * desactivado.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_customers_store_link
      ON commercial.customers (tenant_id, store_id)
      WHERE store_id IS NOT NULL AND deleted_at IS NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.uq_commercial_customers_store_link`);
};
