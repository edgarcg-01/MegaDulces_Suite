/**
 * V.7 Modo Vendedor — resultado/cierre de visita.
 *
 * "Terminar visita" deja de ser un check-in puntual: ahora la visita registra su
 * desenlace. Agrega a commercial.vendor_visits:
 *   - ended_at        cuándo se cerró la visita (NULL = abierta)
 *   - had_order       se tomó un pedido (preventa) en la visita
 *   - had_ticket      se capturó un ticket de venta directa
 *   - no_sale_reason  motivo si no hubo venta (NULL si sí hubo)
 *
 * Aditiva + idempotente (hasColumn). RLS y grants ya viven en la tabla base.
 *
 * @param { import("knex").Knex } knex
 */
const REASONS = ['cerrado', 'no_atendio', 'con_inventario', 'sin_recursos', 'no_interesado', 'otro'];

exports.up = async function (knex) {
  const hasTable = await knex.schema.withSchema('commercial').hasTable('vendor_visits');
  if (!hasTable) return; // la base se crea en 20260610120000

  const ensure = async (col, cb) => {
    const has = await knex.schema.withSchema('commercial').hasColumn('vendor_visits', col);
    if (!has) await knex.schema.withSchema('commercial').alterTable('vendor_visits', cb);
  };
  await ensure('ended_at', (t) => t.timestamp('ended_at', { useTz: true }));
  await ensure('had_order', (t) => t.boolean('had_order').notNullable().defaultTo(false));
  await ensure('had_ticket', (t) => t.boolean('had_ticket').notNullable().defaultTo(false));
  await ensure('no_sale_reason', (t) => t.string('no_sale_reason', 40));

  await knex.raw(
    `ALTER TABLE commercial.vendor_visits
       DROP CONSTRAINT IF EXISTS chk_vendor_visits_no_sale_reason`,
  );
  await knex.raw(
    `ALTER TABLE commercial.vendor_visits
       ADD CONSTRAINT chk_vendor_visits_no_sale_reason
       CHECK (no_sale_reason IS NULL OR no_sale_reason IN (${REASONS.map((r) => `'${r}'`).join(', ')}))`,
  );
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.withSchema('commercial').hasTable('vendor_visits');
  if (!hasTable) return;
  await knex.raw(
    `ALTER TABLE commercial.vendor_visits DROP CONSTRAINT IF EXISTS chk_vendor_visits_no_sale_reason`,
  );
  await knex.schema.withSchema('commercial').alterTable('vendor_visits', (t) => {
    t.dropColumn('ended_at');
    t.dropColumn('had_order');
    t.dropColumn('had_ticket');
    t.dropColumn('no_sale_reason');
  });
};
