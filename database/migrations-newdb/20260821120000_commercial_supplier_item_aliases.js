/**
 * RE.11.1 — Alias de ítem por proveedor (descripción del proveedor → SKU interno).
 *
 * Al conciliar una REMISIÓN/FACTURA contra la orden de entrada de Kepler
 * (`analytics.erp_goods_receipt_lines`, que ya trae el SKU interno + nombre + cantidad),
 * cada renglón resuelve `descripción-del-proveedor → SKU-interno`. Ese mapeo se APRENDE
 * aquí: la próxima remisión del MISMO proveedor con la MISMA descripción se resuelve sola
 * (match instantáneo, sin OCR-matching ni revisión humana).
 *
 * Llave = `(tenant, proveedor_rfc, descripcion_norm)`. El RFC es estable entre fuentes
 * (remisión, Kepler, ContPAQi) y sobrevive re-imports del catálogo. `descripcion_norm` es
 * la descripción del proveedor normalizada (lower + sin acentos + colapsada) para que
 * "COCA-COLA 600ML" y "coca cola 600 ml" caigan al mismo alias.
 *
 * `box_factor` guarda el factor caja→pieza aprendido en ESE match (si el proveedor factura
 * en cajas y Kepler registró en piezas) para futuras conversiones sin recalcular.
 *
 * Se aprende en HITL: el humano confirma/corrige el match → UPSERT con +1 veces_confirmado
 * y confianza recalculada. Reversible: soft-delete (deleted_at). commercial.* con RLS forzado
 * (sigue el patrón de commercial.product_aliases).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('supplier_item_aliases');
  if (exists) return;

  await knex.raw(`
    CREATE TABLE commercial.supplier_item_aliases (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         uuid NOT NULL,
      proveedor_rfc     text NOT NULL,             -- RFC del emisor (llave estable del proveedor)
      proveedor_nombre  text,                      -- razón social (informativo)
      descripcion_norm  text NOT NULL,             -- descripción del proveedor normalizada (lower+sin acentos)
      descripcion_raw   text,                      -- descripción tal cual venía en la remisión (auditar)
      sku               text NOT NULL,             -- SKU interno resuelto (Kepler kdm2.c8)
      nombre_interno    text,                      -- nombre interno del producto (Kepler kdm2.c10)
      unidad_proveedor  text,                      -- unidad en que el proveedor factura (CJA/PZA/PAQ)
      box_factor        numeric,                   -- piezas por unidad del proveedor (caja→pieza) aprendido
      veces_confirmado  integer NOT NULL DEFAULT 1,
      confianza         numeric  NOT NULL DEFAULT 0.5,  -- 0..1
      last_seen         timestamptz NOT NULL DEFAULT now(),
      created_at        timestamptz NOT NULL DEFAULT now(),
      created_by        uuid,
      updated_at        timestamptz NOT NULL DEFAULT now(),
      updated_by        uuid,
      deleted_at        timestamptz,
      CONSTRAINT chk_sia_confianza CHECK (confianza >= 0 AND confianza <= 1)
    )`);

  // Un (proveedor, descripción) mapea a UN sku entre filas vivas → UPSERT idempotente.
  await knex.raw(`
    CREATE UNIQUE INDEX uq_supplier_item_alias
      ON commercial.supplier_item_aliases (tenant_id, proveedor_rfc, descripcion_norm)
      WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX ix_supplier_item_alias_sku ON commercial.supplier_item_aliases (tenant_id, sku)`);

  await knex.raw('ALTER TABLE commercial.supplier_item_aliases ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.supplier_item_aliases FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.supplier_item_aliases
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON commercial.supplier_item_aliases;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON commercial.supplier_item_aliases
      FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id()`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supplier_item_aliases TO app_runtime');

  await knex.raw(`
    COMMENT ON TABLE commercial.supplier_item_aliases IS
      'RE.11.1 — alias de item por proveedor (descripcion del proveedor -> SKU interno). Aprendido en '
      'la conciliacion por linea de /compras/entradas (remision vs lineas Kepler). Llave (tenant, RFC, '
      'descripcion_norm); resuelve remisiones futuras del mismo proveedor sin re-matching.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.supplier_item_aliases`);
};
