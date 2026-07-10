/**
 * RA-PRO.6 — Topología de red de abasto (DRP / multi-echelon). Ver
 * FASE_RA_BENCHMARK_ENTERPRISE.md.
 *
 * Define el árbol de 2 niveles CEDIS → sucursal con UNA columna:
 *   commercial.warehouses.source_warehouse_id
 *     · NULL  → almacén de origen (CEDIS): se surte de PROVEEDORES.
 *     · set   → sucursal: se surte por TRASPASO desde ese almacén (el CEDIS).
 *
 * Con esto el motor puede planear el CEDIS sobre **demanda dependiente** (la suma de
 * lo que sus sucursales consumen), no sobre su venta directa — que es ~0 y hoy deja al
 * CEDIS sin política de reorden. FK compuesta (tenant_id, source_warehouse_id) a la
 * tabla real. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouses', 'source_warehouse_id'))) {
    await knex.raw(`ALTER TABLE commercial.warehouses ADD COLUMN source_warehouse_id uuid`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_warehouse_source') THEN
          ALTER TABLE commercial.warehouses
            ADD CONSTRAINT fk_warehouse_source
            FOREIGN KEY (tenant_id, source_warehouse_id)
            REFERENCES commercial.warehouses (tenant_id, id) ON DELETE SET NULL;
        END IF;
      END $$`);
    // Guard: un almacén no puede surtirse de sí mismo.
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_warehouse_source_not_self') THEN
          ALTER TABLE commercial.warehouses
            ADD CONSTRAINT chk_warehouse_source_not_self
            CHECK (source_warehouse_id IS NULL OR source_warehouse_id <> id);
        END IF;
      END $$`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_warehouse_source ON commercial.warehouses (tenant_id, source_warehouse_id)`);
    await knex.raw(`COMMENT ON COLUMN commercial.warehouses.source_warehouse_id IS 'RA-PRO.6 DRP — de qué almacén se surte por traspaso. NULL = CEDIS (se surte de proveedores). Define el árbol CEDIS→sucursal.'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.warehouses DROP CONSTRAINT IF EXISTS chk_warehouse_source_not_self`);
  await knex.raw(`ALTER TABLE commercial.warehouses DROP CONSTRAINT IF EXISTS fk_warehouse_source`);
  if (await knex.schema.withSchema('commercial').hasColumn('warehouses', 'source_warehouse_id')) {
    await knex.raw(`ALTER TABLE commercial.warehouses DROP COLUMN source_warehouse_id`);
  }
};
