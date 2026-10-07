/**
 * RA-PRO.28 — Override manual de unidad de venta por producto.
 *
 * El motor deriva del ratio de precios (mayoreo $/u ÷ retail $/u) dos factores para NO inflar
 * el pedido cuando un SKU se vende en unidades distintas por canal (pieza/kg vs caja/cubeta):
 *   - SUF (pieces_per_unit): sub-unidades de demanda por UNIDAD DE STOCK. granel=ratio, normal=1.
 *   - BF  (box_factor):      unidades de stock por CAJA de pedido. granel=1, bad-fs=round(ratio), normal=factor_sale.
 *
 * Esta tabla permite CORREGIR a mano el auto-análisis por SKU (respaldo). Mapea por product_id
 * (estable entre re-imports de Kepler). Reversible: borrar la fila. RLS forzado (patrón commercial.*).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('product_unit_overrides'))) {
    await knex.raw(`
      CREATE TABLE commercial.product_unit_overrides (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        product_id      uuid NOT NULL,
        pieces_per_unit numeric,   -- SUF: sub-unidades de demanda por unidad de stock (granel). NULL = auto.
        box_factor      numeric,   -- BF: unidades de stock por caja de pedido. NULL = auto.
        sold_as         text,      -- etiqueta libre: 'piece' | 'granel' | 'box' (informativo)
        note            text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        created_by      uuid,
        updated_at      timestamptz NOT NULL DEFAULT now(),
        deleted_at      timestamptz,
        CONSTRAINT chk_uov_positive CHECK (
          (pieces_per_unit IS NULL OR pieces_per_unit > 0) AND (box_factor IS NULL OR box_factor > 0))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX uq_product_unit_override ON commercial.product_unit_overrides (tenant_id, product_id) WHERE deleted_at IS NULL`);
    await knex.raw(`ALTER TABLE commercial.product_unit_overrides ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.product_unit_overrides FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.product_unit_overrides USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_populate_tenant_id') THEN
          DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON commercial.product_unit_overrides;
          CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON commercial.product_unit_overrides
            FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
        END IF;
      END $$;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.product_unit_overrides TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.product_unit_overrides IS 'RA-PRO.28 — override manual de unidad de venta (SUF/BF) por producto para no inflar el pedido.'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.product_unit_overrides`);
};
