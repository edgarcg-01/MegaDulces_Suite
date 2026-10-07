/**
 * KV.8 (ADR-026 / Fase KV) — Embarques REALES del ERP Kepler → analytics.erp_shipments.
 * Histórico de reparto/surtido (kdpord: folio PD-…, SKU, cantidad, ruta, estado
 * EMBARCADO), SEPARADO del ciclo de vida operativo de la app (logistics.shipments),
 * igual que analytics.sales_daily vs commercial.orders. Fact grano-línea.
 *
 * Sin RLS (analytics.* filtra tenant_id explícito). Aditiva, idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_shipments'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_shipments (
        tenant_id      uuid NOT NULL,
        shipment_folio text NOT NULL,
        sku            text NOT NULL,
        product_id     uuid,
        warehouse_code text,
        route          text,
        status         text,
        doc_folio      text,
        shipped_date   date,
        quantity       numeric DEFAULT 0,
        unit           text,
        computed_at    timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, shipment_folio, sku)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_erp_ship_date ON analytics.erp_shipments (tenant_id, shipped_date)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_erp_ship_route ON analytics.erp_shipments (tenant_id, route)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_erp_ship_status ON analytics.erp_shipments (tenant_id, status)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_shipments TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.erp_shipments IS 'KV.8 embarques reales Kepler (kdpord). Fact grano-linea, separado de logistics.shipments (app).'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_shipments');
};
