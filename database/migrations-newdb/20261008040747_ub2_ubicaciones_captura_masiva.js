'use strict';
/**
 * `[UB.2]` — Captura masiva de ubicaciones (Fase UB, ADR-090): el LOTE de captura.
 *
 * Generar 180 ubicaciones por rango (o subir un Excel) tiene que poder deshacerse de una vez si se
 * equivocó el rango. Para eso cada ubicación recuerda el lote que la creó, y el lote recuerda quién,
 * cuándo, qué pidió y cuántas creó.
 *
 *   · `commercial.location_capture_batches` — una fila por captura (rango o archivo).
 *   · `commercial.warehouse_bins.capture_batch_id` — el lote que creó la ubicación (NULL = alta
 *     suelta: Mapa, Andén, o anterior a UB.2).
 *
 * Deshacer sólo procede si NINGUNA ubicación del lote se usó todavía (sin renglones en
 * `stock_lot_locations`): entonces nunca existió en la operación y se retira. Si alguna ya se usó,
 * el lote no se deshace y se dice cuáles (el servicio lo valida; ver `[UB.4]` para bajas).
 *
 * Tabla nueva con tenant_id + audit + RLS forzado + grant app_runtime. Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('location_capture_batches'))) {
    await knex.schema.withSchema('commercial').createTable('location_capture_batches', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.string('kind', 12).notNullable(); // 'rango' | 'archivo'
      t.jsonb('params').notNullable().defaultTo('{}'); // el rango pedido o el nombre del archivo
      t.integer('created_count').notNullable().defaultTo(0);
      t.integer('skipped_count').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('undone_at');
      t.uuid('undone_by');
      t.integer('undone_count');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_loc_capture_batches_tenant_id_composite' });
      t.index(['tenant_id', 'warehouse_id', 'created_at'], 'idx_commercial_loc_capture_batches_wh');
      t.check(`?? IN ('rango', 'archivo')`, ['kind'], 'ck_loc_capture_batches_kind');
      t.check('?? >= 0 AND ?? >= 0', ['created_count', 'skipped_count'], 'ck_loc_capture_batches_counts');
      // Deshecho = las tres juntas, o ninguna.
      t.check(
        '(?? IS NULL AND ?? IS NULL AND ?? IS NULL) OR (?? IS NOT NULL AND ?? IS NOT NULL)',
        ['undone_at', 'undone_by', 'undone_count', 'undone_at', 'undone_count'],
        'ck_loc_capture_batches_undone',
      );
    });
    await knex.raw(`
      ALTER TABLE commercial.location_capture_batches
        ADD CONSTRAINT fk_loc_capture_batches_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`
      ALTER TABLE commercial.location_capture_batches
        ADD CONSTRAINT fk_loc_capture_batches_warehouse
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.location_capture_batches ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.location_capture_batches FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.location_capture_batches`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.location_capture_batches
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Sin DELETE: un lote no se borra, se marca deshecho.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.location_capture_batches TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.location_capture_batches IS
      'Lotes de captura masiva de ubicaciones (Fase UB.2, ADR-090): rango o archivo. Se deshacen, no se borran.'`);
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', 'capture_batch_id'))) {
    await knex.schema.withSchema('commercial').alterTable('warehouse_bins', (t) => t.uuid('capture_batch_id'));
    await knex.raw(`
      ALTER TABLE commercial.warehouse_bins
        ADD CONSTRAINT fk_wh_bins_capture_batch
        FOREIGN KEY (tenant_id, capture_batch_id)
        REFERENCES commercial.location_capture_batches(tenant_id, id) ON DELETE RESTRICT`);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_commercial_wh_bins_capture_batch
        ON commercial.warehouse_bins (tenant_id, capture_batch_id) WHERE capture_batch_id IS NOT NULL`);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('warehouse_bins', 'capture_batch_id')) {
    await knex.raw(`ALTER TABLE commercial.warehouse_bins DROP CONSTRAINT IF EXISTS fk_wh_bins_capture_batch`);
    await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commercial_wh_bins_capture_batch`);
    await knex.schema.withSchema('commercial').alterTable('warehouse_bins', (t) => t.dropColumn('capture_batch_id'));
  }
  await knex.schema.withSchema('commercial').dropTableIfExists('location_capture_batches');
};
