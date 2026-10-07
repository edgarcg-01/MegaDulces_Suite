/**
 * RA.1 — Fase Reabastecimiento (ADR-030). Schema del reorden/compras.
 *
 * 4 tablas en `commercial.*` + 1 columna en `catalog.suppliers`:
 *   commercial.reorder_policy            = umbrales mín/reorden/máx por producto×almacén
 *                                          (source kepler/computed/manual). Grano = commercial.stock.
 *   commercial.purchase_requisitions     = requisición de compra (HITL) generada del sugerido.
 *   commercial.purchase_requisition_lines= líneas con snapshot (existencia/umbrales/sugerido/final).
 *   commercial.requisition_sequences     = folio RQ-YYYY-NNNNN atómico por tenant×año.
 *   catalog.suppliers.lead_time_days     = lead time (Kepler NO lo trae) → cómputo del reorden.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; services vía
 * TenantKnexService.run(). FKs compuestas a catalog.products / commercial.warehouses
 * (public.products es VISTA → se apunta a la tabla real catalog.products). Sin FK a
 * `tenants` (el tenant se ancla por los composite FK). Idempotente (hasTable/hasColumn).
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON commercial.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  // ── catalog.suppliers.lead_time_days ──────────────────────────────────
  if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', 'lead_time_days'))) {
    await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN lead_time_days integer`);
    await knex.raw(`COMMENT ON COLUMN catalog.suppliers.lead_time_days IS 'RA — días de entrega del proveedor. Kepler no lo trae; se captura o se asume default para el cómputo del punto de reorden.'`);
  }

  // ── commercial.reorder_policy ─────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('reorder_policy'))) {
    await knex.raw(`
      CREATE TABLE commercial.reorder_policy (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        warehouse_id   uuid NOT NULL,
        product_id     uuid NOT NULL,
        min_stock      numeric(14,3) NOT NULL DEFAULT 0,
        reorder_point  numeric(14,3) NOT NULL DEFAULT 0,
        max_stock      numeric(14,3) NOT NULL DEFAULT 0,
        source         varchar(12) NOT NULL DEFAULT 'manual' CHECK (source IN ('kepler','computed','manual')),
        lead_time_days integer,
        safety_stock   numeric(14,3),
        computed_at    timestamptz,
        updated_by     uuid,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, warehouse_id, product_id),
        UNIQUE (tenant_id, id),
        CHECK (min_stock >= 0 AND reorder_point >= 0 AND max_stock >= 0),
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, product_id)   REFERENCES catalog.products    (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_reorder_policy_wh ON commercial.reorder_policy (tenant_id, warehouse_id)`);
    await knex.raw(`CREATE INDEX ix_reorder_policy_source ON commercial.reorder_policy (tenant_id, source)`);
    await knex.raw(`COMMENT ON TABLE commercial.reorder_policy IS 'RA/ADR-030 — política de reorden por producto×almacén. source: kepler (kdii.c33/34/35) | computed (demanda) | manual (override, no lo pisa el importer).'`);
    await createTenantRls(knex, 'reorder_policy');
  }

  // ── commercial.requisition_sequences (folio atómico) ──────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('requisition_sequences'))) {
    await knex.raw(`
      CREATE TABLE commercial.requisition_sequences (
        tenant_id uuid NOT NULL,
        year      integer NOT NULL,
        last_seq  integer NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, year)
      )`);
    await createTenantRls(knex, 'requisition_sequences');
  }

  // ── commercial.purchase_requisitions ──────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_requisitions'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_requisitions (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        warehouse_id  uuid NOT NULL,
        supplier_id   uuid,
        folio         varchar(20) NOT NULL,
        estado        varchar(16) NOT NULL DEFAULT 'pending_approval'
                        CHECK (estado IN ('draft','pending_approval','approved','ordered','cancelled')),
        target_basis  varchar(12) NOT NULL DEFAULT 'max' CHECK (target_basis IN ('min','reorder','max')),
        total_lines   integer NOT NULL DEFAULT 0,
        total_units   numeric(14,3) NOT NULL DEFAULT 0,
        total_cost    numeric(14,4) NOT NULL DEFAULT 0,
        notes         text,
        created_by    uuid,
        approved_by   uuid,
        approved_at   timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, folio),
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, supplier_id)  REFERENCES catalog.suppliers     (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_purch_req_estado ON commercial.purchase_requisitions (tenant_id, estado, created_at)`);
    await createTenantRls(knex, 'purchase_requisitions');
  }

  // ── commercial.purchase_requisition_lines ─────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('purchase_requisition_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.purchase_requisition_lines (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        requisition_id uuid NOT NULL,
        product_id     uuid NOT NULL,
        supplier_id    uuid,
        on_hand        numeric(14,3) NOT NULL DEFAULT 0,
        in_transit     numeric(14,3) NOT NULL DEFAULT 0,
        min_stock      numeric(14,3) NOT NULL DEFAULT 0,
        reorder_point  numeric(14,3) NOT NULL DEFAULT 0,
        max_stock      numeric(14,3) NOT NULL DEFAULT 0,
        suggested_qty  numeric(14,3) NOT NULL DEFAULT 0,
        final_qty      numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost      numeric(14,4) NOT NULL DEFAULT 0,
        line_cost      numeric(14,4) NOT NULL DEFAULT 0,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        FOREIGN KEY (tenant_id, requisition_id) REFERENCES commercial.purchase_requisitions (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, product_id)     REFERENCES catalog.products                 (tenant_id, id) ON DELETE RESTRICT
      )`);
    await knex.raw(`CREATE INDEX ix_purch_req_lines_req ON commercial.purchase_requisition_lines (tenant_id, requisition_id)`);
    await createTenantRls(knex, 'purchase_requisition_lines');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_requisition_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('purchase_requisitions');
  await knex.schema.withSchema('commercial').dropTableIfExists('requisition_sequences');
  await knex.schema.withSchema('commercial').dropTableIfExists('reorder_policy');
  if (await knex.schema.withSchema('catalog').hasColumn('suppliers', 'lead_time_days')) {
    await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN lead_time_days`);
  }
};
