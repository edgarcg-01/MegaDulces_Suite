/**
 * commercial.customers.visit_days smallint[] (cada elemento ISO 1=lun..7=dom).
 *
 * Días en que el vendedor visita a ESTE cliente. Es un ARRAY porque un cliente
 * puede visitarse varios días (ej. abarrote lopez se atiende lunes Y martes).
 * Una ruta (~199 clientes) se reparte en la semana; cada cliente lleva sus días.
 * El modo vendedor muestra los clientes de la ruta asignada hoy (daily_assignments)
 * cuyo visit_days contiene el ISODOW de hoy. NULL/{} = sin días todavía (no aparece).
 *
 * Índice GIN para el contains (`visit_days @> ARRAY[hoy]`). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS visit_days smallint[]');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_customers_visit_days
      ON commercial.customers USING GIN (visit_days)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_commercial_customers_visit_days');
  await knex.raw('ALTER TABLE commercial.customers DROP COLUMN IF EXISTS visit_days');
};
