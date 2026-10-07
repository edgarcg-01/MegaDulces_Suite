/**
 * SM.8 / P6 — Cruce independiente: venta atómica de tickets vs venta del corte.
 *
 * El techo del sistema: P1 (arqueo ciego) verifica el CONTADO; P6 verifica el
 * ESPERADO. Reconstruye la venta del turno desde los tickets POS crudos (kdm1,
 * capa atómica) y la compara contra el total del corte (kdpv_folio_caja, capa
 * agregada). Divergencia = tickets cancelados/editados tras el cierre o corte
 * manipulado — algo que la cuadre propia de Kepler NO puede ver (usa la misma
 * agregación). Verificado: 672/683 cortes reconcilian a ±$100; las divergencias
 * son reales (ej. $9,624 de tickets fuera del corte; días con $0 tickets).
 *
 * analytics.* sin RLS → filtro tenant explícito. Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('pos_ticket_sales')) return;
  await knex.raw(`
    CREATE TABLE analytics.pos_ticket_sales (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_code text NOT NULL,
      cajero_code    text NOT NULL,        -- kdm1.c67
      business_date  date NOT NULL,        -- kdm1.c9::date
      ticket_count   int NOT NULL DEFAULT 0,
      ticket_total   numeric NOT NULL DEFAULT 0,   -- Σ kdm1.c16 (U/D/10 = venta real)
      source         text NOT NULL DEFAULT 'kepler',
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_ticket_sales ON analytics.pos_ticket_sales (tenant_id, warehouse_code, cajero_code, business_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_pos_ticket_sales_date ON analytics.pos_ticket_sales (tenant_id, business_date DESC)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.pos_ticket_sales TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('pos_ticket_sales');
};
