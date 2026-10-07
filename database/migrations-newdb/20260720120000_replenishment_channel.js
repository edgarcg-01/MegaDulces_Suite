/**
 * RA-PRO.8 — Ciclos de reabasto (ADR-030). Ver reference_kepler_supply_network_topology.
 *
 * Modela CÓMO y CADA CUÁNTO se reabastece cada (almacén × proveedor):
 *   commercial.replenishment_channel
 *     · via='purchase'  → compra directa al proveedor (puntos de compra: CEDIS/PH/Abastos/Canindo).
 *                          cadence_days = ciclo del proveedor derivado de X-A-40 (Orden de entrada).
 *     · via='transfer'  → traspaso desde un hub (source_warehouse_id). Spokes 02/03/04←PH, 05←Canindo.
 *                          cadence_days = ritmo de traspaso del hub a esa tienda (~3d, a nivel tienda).
 *
 * El canal se decide POR (almacén × proveedor) — un mismo almacén compra unas líneas directo y
 * recibe otras por traspaso ("cuando el proveedor es Morelia Abastos = traspaso"). El job
 * `import-replenishment-cadence.js` deriva canal+cadencia del histórico `analytics.stock_movements`
 * y hace UPSERT; NUNCA pisa filas cadence_source='manual' (override de la coordinadora/analistas).
 * next_due_date = last_delivery_date + cadence → alimenta el worklist "qué toca hoy" y el horizonte
 * del sugerido (cadencia + lead + colchón).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; FKs compuestas
 * (tenant_id, x) a las tablas reales. Idempotente (hasTable). NO puebla datos (eso lo hace el job).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('replenishment_channel'))) {
    await knex.raw(`
      CREATE TABLE commercial.replenishment_channel (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        warehouse_id        uuid NOT NULL,
        supplier_id         uuid NOT NULL,
        via                 varchar(10) NOT NULL DEFAULT 'purchase' CHECK (via IN ('purchase','transfer')),
        source_warehouse_id uuid,
        cadence_days        numeric(6,1),
        cadence_source      varchar(10) NOT NULL DEFAULT 'derived' CHECK (cadence_source IN ('derived','manual')),
        avg_gap_days        numeric(6,1),
        min_gap_days        integer,
        max_gap_days        integer,
        n_deliveries        integer NOT NULL DEFAULT 0,
        last_delivery_date  date,
        next_due_date       date,
        lead_time_days      integer,
        health_band         varchar(12) CHECK (health_band IN ('rapida','promedio','mal_abasto')),
        computed_at         timestamptz,
        updated_by          uuid,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, warehouse_id, supplier_id),
        UNIQUE (tenant_id, id),
        CHECK (cadence_days IS NULL OR cadence_days >= 0),
        FOREIGN KEY (tenant_id, warehouse_id)        REFERENCES commercial.warehouses (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, supplier_id)         REFERENCES catalog.suppliers     (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_replen_channel_wh ON commercial.replenishment_channel (tenant_id, warehouse_id)`);
    await knex.raw(`CREATE INDEX ix_replen_channel_due ON commercial.replenishment_channel (tenant_id, next_due_date)`);
    await knex.raw(`CREATE INDEX ix_replen_channel_sup ON commercial.replenishment_channel (tenant_id, supplier_id)`);
    await knex.raw(`COMMENT ON TABLE commercial.replenishment_channel IS 'RA-PRO.8 — canal (compra/traspaso) + cadencia por almacén×proveedor. Derivado de X-A-40/TrsfRcv; cadence_source=manual lo protege del job.'`);

    await knex.raw(`ALTER TABLE commercial.replenishment_channel ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.replenishment_channel FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='replenishment_channel' AND policyname='tenant_isolation'
        ) THEN
          CREATE POLICY tenant_isolation ON commercial.replenishment_channel
            USING (tenant_id = public.current_tenant_id())
            WITH CHECK (tenant_id = public.current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.replenishment_channel TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('replenishment_channel');
};
