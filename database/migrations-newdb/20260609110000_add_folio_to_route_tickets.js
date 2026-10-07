/**
 * Agrega `folio` a commercial.route_tickets — identificador del ticket de CARGA
 * (ej. "T153142782", string alfanumérico que aparece tras "FOLIO:" en el ticket
 * de compra de mercancía). Es el equivalente para carga de corte_number (venta)
 * y reference (combustible). Único por tenant entre tickets vivos.
 *
 * Idempotente: guard hasColumn + índice IF NOT EXISTS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('commercial').hasColumn('route_tickets', 'folio');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('route_tickets', (t) => {
      t.string('folio', 40);
    });
  }
  // Unicidad parcial (igual que corte_number / reference): permite múltiples NULL
  // (venta/combustible no tienen folio).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_tickets_tenant_folio
      ON commercial.route_tickets (tenant_id, folio)
      WHERE folio IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(
    `COMMENT ON COLUMN commercial.route_tickets.folio IS 'Folio identificador del ticket de carga (ej. T153142782). Único por tenant entre tickets vivos.'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.uniq_route_tickets_tenant_folio`);
  const has = await knex.schema.withSchema('commercial').hasColumn('route_tickets', 'folio');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('route_tickets', (t) => {
      t.dropColumn('folio');
    });
  }
};
