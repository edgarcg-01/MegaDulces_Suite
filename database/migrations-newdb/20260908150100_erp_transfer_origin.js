/**
 * WMS-REC.8 — Crosswalk `TI###` → almacén de ORIGEN (quién embarcó el traspaso).
 *
 * En un traspaso interno el "proveedor" del documento es el ORIGEN (`TI001`…`TI008`,
 * `TI000` = CEDIS) y el almacén del vale es el DESTINO. Para reclamarle a alguien un
 * faltante de traspaso hace falta saber quién embarcó — y **eso no se puede deducir**:
 * el ERP se contradice consigo mismo (`TI001` aparece con dos nombres, `TI005` sale como
 * "ZAMORA CANINDO" y también como "ABASTOS LP" mientras `analytics.transfer_dest_map`
 * dice que Canindo es `TI006`).
 *
 * Decisión 2026-09-08 (ADR-053): **se captura a mano**, mismo patrón que
 * `commercial.erp_sucursal_warehouse` (WMS-REC.1). Una fila = una decisión humana de
 * operaciones, no un heurístico. Mientras la tabla esté vacía el reclamo de traspaso
 * se **mide** (código + nombre del documento, que son hechos) pero queda **sin dueño
 * concreto**; el reclamo lo dice así en la bandeja en vez de inventar una sucursal.
 *
 * Se captura desde la propia bandeja de reclamos: donde duele es donde se pregunta.
 *
 * Aditiva e idempotente. RLS forzado + grant app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('erp_transfer_origin')) return;

  await knex.schema.withSchema('commercial').createTable('erp_transfer_origin', (t) => {
    // Código tal cual lo trae `receiving_sessions.supplier_code` en un traspaso (TI###).
    t.uuid('tenant_id').notNullable();
    t.string('code', 60).notNullable();
    // El almacén que embarcó = el responsable del faltante de traspaso.
    t.uuid('warehouse_id').notNullable();
    // Nota de quien lo capturó (por qué ese código es esa sucursal). Auditoría de la
    // decisión: el ERP no la respalda, así que la respalda la persona.
    t.text('note');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by');

    t.primary(['tenant_id', 'code']);
    t.index(['tenant_id', 'warehouse_id'], 'idx_commercial_erptransorig_wh');
  });

  await knex.raw(`
    ALTER TABLE commercial.erp_transfer_origin
      ADD CONSTRAINT fk_commercial_erptransorig_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.erp_transfer_origin
      ADD CONSTRAINT fk_commercial_erptransorig_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.erp_transfer_origin ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.erp_transfer_origin FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.erp_transfer_origin`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.erp_transfer_origin
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.erp_transfer_origin TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.erp_transfer_origin IS 'WMS-REC.8 (ADR-053) — crosswalk CAPTURADO A MANO TI### → almacén que embarcó. El ERP no permite deducirlo (TI001/TI005 con nombres contradictorios); vacío = el reclamo de traspaso se mide sin dueño.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('erp_transfer_origin');
};
