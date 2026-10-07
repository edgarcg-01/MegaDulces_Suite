/**
 * DM.4 — Auditoría humana de documentos del Diario de movimientos.
 *
 * Marca "este documento ya se auditó/verificó" sobre un doc del feed
 * analytics.stock_movements. Vive en commercial.* (RLS forzado) porque es estado
 * HUMANO persistente: el feed se borra/reinserta en cada corrida del importer y
 * perdería la marca. Identidad del doc = (warehouse, doc_code, serie, folio) —
 * la serie desambigua folios repetidos (verificado: tres "0000296" distintos).
 * Presencia de fila = auditado; des-auditar = DELETE. `audited_by` = snapshot
 * username (patrón daily_captures.captured_by_username).
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
  if (await knex.schema.withSchema('commercial').hasTable('stock_movement_audits')) return;
  await knex.raw(`
    CREATE TABLE commercial.stock_movement_audits (
      id           uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      doc_code     text NOT NULL,
      doc_serie    text NOT NULL DEFAULT '',
      folio        text NOT NULL,
      audited_by   text,
      note         text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),
      UNIQUE (tenant_id, warehouse_id, doc_code, doc_serie, folio),
      FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id) ON DELETE CASCADE
    )`);
  await knex.raw(`COMMENT ON TABLE commercial.stock_movement_audits IS 'DM.4 — marca humana "documento auditado" del Diario de movimientos. Fila presente = auditado; identidad doc = warehouse+doc_code+serie+folio.'`);
  await createTenantRls(knex, 'stock_movement_audits');
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_movement_audits');
};
