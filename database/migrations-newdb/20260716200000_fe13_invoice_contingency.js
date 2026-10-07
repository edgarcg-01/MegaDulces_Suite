/**
 * FE.13 — Contingencia de facturación. Antes la auto-factura era best-effort y
 * fallaba en silencio: un pedido entregado que debía timbrarse quedaba sin CFDI y
 * sin rastro. Estas columnas dan visibilidad + backoff:
 *   - cfdi_error           último error del PAC al intentar facturar
 *   - cfdi_attempts        intentos fallidos (cap para el reintento automático)
 *   - cfdi_last_attempt_at cuándo fue el último intento
 *
 * La "cola" de pendientes se deriva de commercial.orders (fulfilled + cfdi_uuid IS
 * NULL + datos fiscales completos) — idempotente, sin tabla nueva. Aditiva.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, builder) => {
    if (!(await knex.schema.withSchema('commercial').hasColumn('orders', col))) {
      await knex.schema.withSchema('commercial').alterTable('orders', builder);
    }
  };
  await add('cfdi_error', (t) => t.text('cfdi_error'));
  await add('cfdi_attempts', (t) => t.integer('cfdi_attempts').notNullable().defaultTo(0));
  await add('cfdi_last_attempt_at', (t) => t.timestamp('cfdi_last_attempt_at', { useTz: true }));
  // Índice parcial para el reintento: pedidos entregados aún sin CFDI.
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ix_commercial_orders_cfdi_pending
       ON commercial.orders (tenant_id, fulfilled_at)
     WHERE status = 'fulfilled' AND cfdi_uuid IS NULL`,
  );
};

/** @param { import("knex").Knex } knex — down conserva las columnas (no destructivo). */
exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.ix_commercial_orders_cfdi_pending');
  // Columnas cfdi_* se conservan.
};
