/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * `commercial.expiry_receiving_policy` — reglas de caducidad para la RECEPCIÓN.
 * Es el MOTOR que decide el semáforo (no el OCR): define, por ámbito en cascada
 * (producto → categoría → proveedor), la vida útil mínima exigida y si se permite
 * recibir un lote más viejo que el inventario existente.
 *
 * Resolución en el servicio: product_id > category > supplier_code > default
 * (sin política = solo aplica la regla data-driven "no más viejo que lo existente").
 *
 * Aditivo e idempotente (guard hasTable). RLS forzado + grant app_runtime.
 * FK compuesta (tenant_id, product_id) a catalog.products (MATCH SIMPLE: no se
 * enforcea cuando product_id es null, que es el caso de reglas por categoría/prov).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('expiry_receiving_policy')) return;

  await knex.schema.withSchema('commercial').createTable('expiry_receiving_policy', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    // Ámbito (exactamente uno debería venir seteado; la cascada la aplica el servicio).
    t.uuid('product_id'); // regla por SKU
    t.string('category', 120); // regla por categoría (texto libre, matchea products.category)
    t.string('supplier_code', 60); // regla por proveedor
    // Reglas
    t.integer('min_shelf_life_days'); // vida útil mínima exigida (días desde hoy). null = sin mínimo.
    t.boolean('allow_older_than_existing').notNullable().defaultTo(false); // ¿aceptar lote más viejo que lo ya almacenado?
    t.string('source', 20).notNullable().defaultTo('manual'); // manual | default
    t.text('notes');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by');

    t.primary('id');
    t.unique(['tenant_id', 'id'], { indexName: 'commercial_exp_recv_policy_tenant_id_composite' });
    t.index(['tenant_id', 'product_id'], 'idx_commercial_exp_recv_policy_product');
    t.index(['tenant_id', 'supplier_code'], 'idx_commercial_exp_recv_policy_supplier');
  });

  // Una política por ámbito exacto (NULLS NOT DISTINCT, PG15+).
  await knex.raw(`
    CREATE UNIQUE INDEX commercial_exp_recv_policy_scope_unique
      ON commercial.expiry_receiving_policy (tenant_id, product_id, category, supplier_code)
      NULLS NOT DISTINCT
  `);

  await knex.raw(`
    ALTER TABLE commercial.expiry_receiving_policy
      ADD CONSTRAINT fk_commercial_exp_recv_policy_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.expiry_receiving_policy
      ADD CONSTRAINT fk_commercial_exp_recv_policy_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.expiry_receiving_policy ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.expiry_receiving_policy FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.expiry_receiving_policy`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.expiry_receiving_policy
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.expiry_receiving_policy TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.expiry_receiving_policy IS 'Reglas de caducidad en recepción (ADR-044). Motor del semáforo 🟢🟡🔴: vida útil mínima + política de lote más viejo, por producto/categoría/proveedor.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('expiry_receiving_policy');
};
