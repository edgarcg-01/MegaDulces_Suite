/**
 * RA.8 — Bandeja de hallazgos de reabastecimiento (Compras, ADR-030).
 *
 * El scanner nocturno (ReplenishmentScannerService) detecta situaciones críticas
 * cruzando reorder_policy ⋈ stock ⋈ abc ⋈ in_transit y persiste un hallazgo
 * idempotente por (tenant, dedup_key). El comprador lo trabaja desde la bandeja.
 *   kind: agotado_abc   = clase A con existencia ≤ 0 (severidad crítica)
 *         bajo_reorden  = existencia ≤ punto de reorden (alta si clase A, media si no)
 *
 * Patrón HITL como finance.findings / reconciliation: UPSERT por dedup_key, se
 * resuelve solo cuando la condición deja de cumplirse. RLS forzado (el scanner
 * escribe con SET LOCAL app.tenant_id; el service lee vía TenantKnexService.run).
 * @param { import("knex").Knex } knex
 */
async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('replenishment_findings')) return;
  await knex.raw(`
    CREATE TABLE commercial.replenishment_findings (
      id             uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_id   uuid NOT NULL,
      product_id     uuid NOT NULL,
      kind           varchar(24) NOT NULL CHECK (kind IN ('agotado_abc','bajo_reorden')),
      severity       varchar(8) NOT NULL CHECK (severity IN ('critica','alta','media')),
      dedup_key      text NOT NULL,
      status         varchar(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
      abc_class      varchar(1),
      on_hand        numeric(14,3) NOT NULL DEFAULT 0,
      reorder_point  numeric(14,3) NOT NULL DEFAULT 0,
      in_transit     numeric(14,3) NOT NULL DEFAULT 0,
      suggested_qty  numeric(14,3) NOT NULL DEFAULT 0,
      suggested_cost numeric(14,4) NOT NULL DEFAULT 0,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      resolved_at    timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, dedup_key),
      FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, product_id)   REFERENCES catalog.products      (tenant_id, id) ON DELETE CASCADE
    )`);
  await knex.raw(`CREATE INDEX ix_repl_findings_open ON commercial.replenishment_findings (tenant_id, status, severity, suggested_cost DESC)`);
  await knex.raw(`COMMENT ON TABLE commercial.replenishment_findings IS 'RA.8 — hallazgos de reabastecimiento (scanner nocturno). UPSERT por (tenant, dedup_key); se resuelve solo al despejarse la condición.'`);
  await createTenantRls(knex, 'replenishment_findings');
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('replenishment_findings');
};
