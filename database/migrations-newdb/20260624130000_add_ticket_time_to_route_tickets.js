/**
 * Agrega `ticket_time` a commercial.route_tickets — la HORA impresa en el ticket
 * (ej. "Hora: 15:33"), wall-clock (normalmente MX). Junto con `ticket_date` forma
 * el datetime del corte/carga/combustible.
 *
 * NO confundir con `created_at` (instante en que el vendedor SUBIÓ el ticket).
 * `ticket_time` es lo que dice el papel; `created_at` es cuándo se cargó. Sirve
 * para detectar cierres tardíos y, a futuro, comparar vs la hora esperada de ruta.
 *
 * Nullable: si el OCR no logra leer la hora, queda NULL.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('commercial').hasColumn('route_tickets', 'ticket_time');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('route_tickets', (t) => {
      t.time('ticket_time');
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.route_tickets.ticket_time IS 'Hora impresa en el ticket (wall-clock, normalmente MX). Con ticket_date forma el datetime del corte. NULL si el OCR no la detecta. NO es created_at (hora de subida).'`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const has = await knex.schema.withSchema('commercial').hasColumn('route_tickets', 'ticket_time');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('route_tickets', (t) => {
      t.dropColumn('ticket_time');
    });
  }
};
