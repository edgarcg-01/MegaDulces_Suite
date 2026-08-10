/**
 * Fase P2.6 (FEFO / caducidad) — Control de Caducidades digital.
 *
 * Digitaliza la hoja manual "CONTROL DE CADUCIDADES": una inspección de anaquel
 * donde personal de tienda recorre el estante y anota código, descripción,
 * cantidad, fecha de caducidad, ESTADO físico (bueno/regular/malo),
 * observaciones y ACCIÓN de seguimiento — datos que el sub-ledger FEFO
 * (commercial.stock_lots) no captura.
 *
 * Dos tablas:
 *   - commercial.expiry_reviews       → encabezado (una hoja): almacén, fecha, responsable, estado.
 *   - commercial.expiry_review_lines  → renglones: producto (opcional match al catálogo) + raw,
 *       cantidad, caducidad, condición, observación, acción, foto de evidencia (files jsonb).
 *
 * Al enviar la hoja (submit), cada renglón con producto + caducidad + cantidad
 * ALIMENTA FEFO reclasificando cantidad del lote 'NA' a un lote fechado (mismo
 * commercial.stock, sin tocar el total → invariante SUM(lotes)=stock intacto);
 * así aparece en /commercial/inventory/expiring y dispara las alertas existentes.
 *
 * Aditivo e idempotente (guard hasTable). RLS forzado + policy tenant_isolation +
 * grants app_runtime. FKs compuestas a tablas REALES (identity.tenants,
 * commercial.warehouses, catalog.products) — public.* son vistas, no FK-ables.
 * product_id es NULLABLE: FK MATCH SIMPLE no valida si product_id es NULL (renglón
 * sin match al catálogo se guarda igual con su código/nombre crudo).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ───── encabezado ─────
  if (!(await knex.schema.withSchema('commercial').hasTable('expiry_reviews'))) {
    await knex.schema.withSchema('commercial').createTable('expiry_reviews', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.date('review_date').notNullable().defaultTo(knex.raw('CURRENT_DATE'));
      t.uuid('responsible_user_id');
      t.string('responsible_name', 160); // snapshot denormalizado (como daily_captures.captured_by_username)
      t.string('status', 20).notNullable().defaultTo('draft');
      t.text('notes');
      t.timestamp('submitted_at');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_expiry_reviews_tenant_id_composite' });
      t.check("?? in ('draft','submitted')", ['status'], 'commercial_expiry_reviews_status_chk');
      t.index(['tenant_id', 'warehouse_id', 'review_date'], 'idx_commercial_expiry_reviews_wh_date');
    });

    await knex.raw(`
      ALTER TABLE commercial.expiry_reviews
        ADD CONSTRAINT fk_commercial_expiry_reviews_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.expiry_reviews
        ADD CONSTRAINT fk_commercial_expiry_reviews_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);

    await knex.raw(`ALTER TABLE commercial.expiry_reviews ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.expiry_reviews FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.expiry_reviews`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.expiry_reviews
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.expiry_reviews TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.expiry_reviews IS 'P2.6 — encabezado del Control de Caducidades (inspección de anaquel). ADR-022.'`);
  }

  // ───── renglones ─────
  if (!(await knex.schema.withSchema('commercial').hasTable('expiry_review_lines'))) {
    await knex.schema.withSchema('commercial').createTable('expiry_review_lines', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('review_id').notNullable();
      t.uuid('product_id'); // NULL = no se resolvió al catálogo (se guarda el raw igual)
      t.string('product_code_raw', 60);
      t.string('product_name_raw', 240);
      t.decimal('quantity', 14, 3).notNullable().defaultTo(0);
      t.date('expiry_date'); // null = sin fecha / ilegible
      t.string('condition', 12); // bueno | regular | malo
      t.text('observations');
      t.text('action');
      t.jsonb('files').notNullable().defaultTo('[]'); // [{role,url,public_id,kind,name}] — foto de evidencia
      t.boolean('fed_to_fefo').notNullable().defaultTo(false);
      t.decimal('fefo_qty', 14, 3).notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_expiry_review_lines_tenant_id_composite' });
      t.check("?? is null or ?? in ('bueno','regular','malo')", ['condition', 'condition'], 'commercial_expiry_review_lines_condition_chk');
      t.check('?? >= 0', ['quantity'], 'commercial_expiry_review_lines_qty_nonneg');
      t.index(['tenant_id', 'review_id'], 'idx_commercial_expiry_review_lines_review');
      t.index(['tenant_id', 'product_id'], 'idx_commercial_expiry_review_lines_product');
    });

    await knex.raw(`
      ALTER TABLE commercial.expiry_review_lines
        ADD CONSTRAINT fk_commercial_expiry_review_lines_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.expiry_review_lines
        ADD CONSTRAINT fk_commercial_expiry_review_lines_review
        FOREIGN KEY (tenant_id, review_id)
        REFERENCES commercial.expiry_reviews(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE commercial.expiry_review_lines
        ADD CONSTRAINT fk_commercial_expiry_review_lines_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);

    await knex.raw(`ALTER TABLE commercial.expiry_review_lines ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.expiry_review_lines FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.expiry_review_lines`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.expiry_review_lines
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.expiry_review_lines TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.expiry_review_lines IS 'P2.6 — renglones del Control de Caducidades: producto + estado físico + observación + acción + foto. Alimenta FEFO al submit. ADR-022.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('expiry_review_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('expiry_reviews');
};
