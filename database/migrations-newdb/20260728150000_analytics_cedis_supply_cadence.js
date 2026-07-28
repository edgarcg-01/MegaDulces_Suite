/**
 * RA-PRO.25 — Cadencia de surtido del CEDIS a cada sucursal (valor agregado).
 *
 * Derivada de Wincaja Irapuato (branch '00', movimientos tipo='V' caja='99' = traspaso
 * inter-almacén; `tercero` = sucursal destino). La llena import-cedis-cadence-wincaja.js.
 * Sin RLS (patrón analytics.*: filtro tenant_id explícito). La expone /compras/red.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('cedis_supply_cadence'))) {
    await knex.raw(`
      CREATE TABLE analytics.cedis_supply_cadence (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        warehouse_id        uuid NOT NULL,        -- sucursal destino (del reorden)
        source_warehouse_id uuid,                 -- CEDIS
        tercero             text,                  -- código Wincaja destino (auditoría)
        shipments           integer NOT NULL DEFAULT 0,
        days_active         integer NOT NULL DEFAULT 0,
        first_shipment      date,
        last_shipment       date,
        cadence_days        numeric,               -- promedio de gap entre días de surtido
        avg_shipment_value  numeric,               -- $ costo promedio por envío
        window_year         integer,
        computed_at         timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE UNIQUE INDEX uq_cedis_cadence ON analytics.cedis_supply_cadence (tenant_id, warehouse_id, window_year)`);
    await knex.raw(`GRANT SELECT ON analytics.cedis_supply_cadence TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.cedis_supply_cadence IS 'RA-PRO.25 — cadencia real de surtido CEDIS→sucursal (Wincaja Irapuato caja 99).'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.cedis_supply_cadence`);
};
