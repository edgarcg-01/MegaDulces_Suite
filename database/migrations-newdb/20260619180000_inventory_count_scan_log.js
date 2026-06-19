/**
 * OFF.0 — Conteo offline-first, cimiento replay-safe.
 *
 * commercial.inventory_count_scan_log = idempotency store: cada escaneo del
 * cliente lleva un scan_uuid; al sincronizar la cola offline, si el scan_uuid ya
 * se aplicó, submitCount devuelve no-op (cero duplicados aunque se reintente o
 * llegue fuera de orden). Patrón outbox + idempotency key (estándar offline-first;
 * "last-write-wins NO sirve para inventario/auditado").
 *
 * Append-only (GRANT solo SELECT/INSERT). Ver FASE_INVENTARIO_OFFLINE.md / ADR.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_scan_log'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_scan_log', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('count_id').notNullable();
      t.uuid('scan_uuid').notNullable(); // idempotency key generado en el cliente
      t.uuid('item_id');
      t.string('slot', 10); // count_1 | count_2 | count_3
      t.uuid('applied_by');
      t.timestamp('applied_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'count_id', 'scan_uuid']);
      t.index(['tenant_id', 'count_id'], 'idx_commercial_inv_scanlog_count');
    });
    await knex.raw(`ALTER TABLE commercial.inventory_count_scan_log ADD CONSTRAINT fk_inv_scanlog_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_scan_log ADD CONSTRAINT fk_inv_scanlog_count FOREIGN KEY (tenant_id, count_id) REFERENCES commercial.inventory_counts(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_scan_log ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_scan_log FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_count_scan_log`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.inventory_count_scan_log USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT ON commercial.inventory_count_scan_log TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.inventory_count_scan_log IS 'OFF.0 idempotency store del conteo offline: scan_uuid del cliente -> resultado aplicado. Replay = no-op. Append-only.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_scan_log');
};
