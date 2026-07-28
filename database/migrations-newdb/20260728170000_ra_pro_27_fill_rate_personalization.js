/**
 * RA-PRO.27 — Personalización del pedido sugerido (fill rate + colchón + cobertura).
 *
 * El sugerido = necesidad_neta ÷ fill_rate del proveedor (inflado por surtido incompleto).
 * Esta migración lo hace CONFIGURABLE en 2 niveles:
 *
 *   1) Por PROVEEDOR (catalog.suppliers):
 *        - fill_rate_override    : gana sobre el fill rate calculado (0..1). Manual.
 *        - safety_pct            : colchón adicional % sobre el sugerido (0..100).
 *        - coverage_days_override: días de cobertura propios (reemplaza el global del filtro).
 *   2) GLOBAL por tenant (commercial.replenishment_settings): los 3 parámetros del cálculo
 *        del fill rate (ventana, mínimo de recepciones para confiar, tope de inflado) +
 *        cobertura default — antes hardcodeados en el service.
 *
 * Precedencia del fill rate: override proveedor → historia SKU×proveedor → historia proveedor → 100%.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

async function addCol(knex, schema, table, col, ddl) {
  if (!(await knex.schema.withSchema(schema).hasColumn(table, col))) {
    await knex.raw(`ALTER TABLE ${schema}.${table} ADD COLUMN ${col} ${ddl}`);
  }
}

exports.up = async function (knex) {
  // ── 1. Columnas por proveedor ──────────────────────────────────────────
  await addCol(knex, 'catalog', 'suppliers', 'fill_rate_override', 'numeric');
  await addCol(knex, 'catalog', 'suppliers', 'safety_pct', 'numeric');
  await addCol(knex, 'catalog', 'suppliers', 'coverage_days_override', 'integer');
  await knex.raw(`COMMENT ON COLUMN catalog.suppliers.fill_rate_override IS 'RA-PRO.27 — fill rate manual (0..1) que gana sobre el calculado por historia.'`);
  await knex.raw(`COMMENT ON COLUMN catalog.suppliers.safety_pct IS 'RA-PRO.27 — colchón adicional % sobre el sugerido (independiente del fill rate).'`);
  await knex.raw(`COMMENT ON COLUMN catalog.suppliers.coverage_days_override IS 'RA-PRO.27 — días de cobertura propios del proveedor (reemplazan el global del filtro).'`);

  // ── 2. Settings globales por tenant ────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('replenishment_settings'))) {
    await knex.raw(`
      CREATE TABLE commercial.replenishment_settings (
        tenant_id            uuid PRIMARY KEY,
        fill_window_days     integer NOT NULL DEFAULT 180,   -- ventana de historia para el fill rate
        fill_min_lines       integer NOT NULL DEFAULT 3,     -- mínimo de líneas recibidas para confiar
        fill_max_inflate     numeric NOT NULL DEFAULT 1.30,  -- tope de inflado (piso del fill = 1/tope)
        default_coverage_days integer NOT NULL DEFAULT 30,   -- cobertura default del pedido
        updated_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        CONSTRAINT chk_fill_inflate CHECK (fill_max_inflate >= 1.0 AND fill_max_inflate <= 3.0)
      )`);
    await knex.raw(`ALTER TABLE commercial.replenishment_settings ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.replenishment_settings FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.replenishment_settings USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON commercial.replenishment_settings;
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON commercial.replenishment_settings
        FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id()`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.replenishment_settings TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.replenishment_settings IS 'RA-PRO.27 — parámetros globales del pedido sugerido (fill rate + cobertura) por tenant.'`);
  }

  // Seed default para Mega Dulces (idempotente).
  await knex.raw(
    `INSERT INTO commercial.replenishment_settings (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING`,
    [MEGA]);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.replenishment_settings`);
  for (const c of ['fill_rate_override', 'safety_pct', 'coverage_days_override']) {
    if (await knex.schema.withSchema('catalog').hasColumn('suppliers', c)) {
      await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN ${c}`);
    }
  }
};
