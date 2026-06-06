/**
 * `trade.catalog_aliases` — mapeo de IDs de catálogo VIEJOS → ID actual.
 *
 * El catálogo `conceptos` cambió de UUIDs entre versiones (seed legacy
 * 8d3bcc13=Exhibidor / 98e94f6e=Refrigerador / 8f870726=Vitrolero ≠ los actuales
 * ce560e85 / 5cf4cafc / ...). Clientes con el catálogo cacheado (Dexie/memoria)
 * siguieron enviando los IDs viejos → capturas con conceptoId "huérfano" que el
 * reporte volcaba como UUID crudo. Esta tabla es la red de seguridad: el reporte
 * y el resolver de capturas mapean old_id → current_id, así cualquier referencia
 * vieja (de un cliente desincronizado o de data histórica) resuelve al concepto
 * actual. Sirve para cualquier catalog_id (conceptos, ubicaciones, niveles…).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('trade').hasTable('catalog_aliases');
  if (exists) return;

  await knex.schema.withSchema('trade').createTable('catalog_aliases', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('catalog_id', 50).notNullable(); // conceptos | ubicaciones | niveles | ...
    table.uuid('old_id').notNullable(); // id muerto que envían clientes viejos / data histórica
    table.uuid('current_id').notNullable(); // id vigente en trade.catalogs
    table.string('note', 200);

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.index(['tenant_id', 'catalog_id'], 'idx_trade_catalog_aliases_type');
  });

  await knex.raw(`
    ALTER TABLE trade.catalog_aliases
      ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
  `);

  // Un old_id mapea a UN current_id entre alias vivos.
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_trade_catalog_aliases_old
      ON trade.catalog_aliases (tenant_id, old_id)
      WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    ALTER TABLE trade.catalog_aliases
      ADD CONSTRAINT fk_trade_catalog_aliases_current
      FOREIGN KEY (current_id) REFERENCES trade.catalogs(id) ON DELETE CASCADE
  `);

  await knex.raw('ALTER TABLE trade.catalog_aliases ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE trade.catalog_aliases FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_isolation ON trade.catalog_aliases
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON trade.catalog_aliases;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON trade.catalog_aliases
      FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON trade.catalog_aliases TO app_runtime');

  await knex.raw(`
    COMMENT ON TABLE trade.catalog_aliases IS
      'Mapeo id de catálogo viejo (old_id) → id vigente (current_id en trade.catalogs). '
      'Red de seguridad para referencias huérfanas de clientes con catálogo cacheado '
      'desactualizado o data histórica. Consultada por el reporte y el resolver de capturas.'
  `);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('trade').dropTableIfExists('catalog_aliases');
};
