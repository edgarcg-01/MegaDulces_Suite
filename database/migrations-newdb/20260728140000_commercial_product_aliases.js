/**
 * RA-PRO.23 — Alias de producto (SKUs "in-and-out" → producto base canónico).
 *
 * Problema: un mismo producto se vende bajo varios SKUs (ej. Kinder Delice 10P
 * permanente + su pack promocional 9+1P "in-and-out", EAN distinto pero es el mismo
 * chocolate). Para el REORDEN eso parte la existencia y la demanda en dos → un SKU sale
 * "agotado" (la venta se timbra ahí) y el otro "sobrestockeado" (el stock vive ahí),
 * generando un pedido fantasma. Planeación los debe tratar como UNO.
 *
 * `commercial.product_aliases`: alias_product_id → canonical_product_id. El motor
 * (compra sugerida / traspaso / sobrestock) pliega la demanda/existencia/velocidad del
 * alias en el canónico y NO lista el alias por separado. Mapea por product_id (estable
 * entre re-imports de Kepler → sobrevive el nightly). Reversible: borrar la fila.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('product_aliases');
  if (!exists) {
    await knex.raw(`
      CREATE TABLE commercial.product_aliases (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        alias_product_id     uuid NOT NULL,
        canonical_product_id uuid NOT NULL,
        note                 text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        created_by           uuid,
        deleted_at           timestamptz,
        CONSTRAINT chk_alias_not_self CHECK (alias_product_id <> canonical_product_id)
      )`);
    // Un alias mapea a UN canónico entre filas vivas.
    await knex.raw(`CREATE UNIQUE INDEX uq_product_alias ON commercial.product_aliases (tenant_id, alias_product_id) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_product_alias_canon ON commercial.product_aliases (tenant_id, canonical_product_id)`);
    await knex.raw(`ALTER TABLE commercial.product_aliases ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.product_aliases FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.product_aliases USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON commercial.product_aliases;
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON commercial.product_aliases
        FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id()`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.product_aliases TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.product_aliases IS 'RA-PRO.23 — alias de producto (SKU in-and-out → base canónico). El motor de reorden pliega demanda/existencia/velocidad del alias en el canónico.'`);
  }

  // Seed: Kinder Delice 9+1P (42073, in-and-out) → 10P (42029, permanente). Idempotente,
  // resuelve por sku, solo si ambos existen en el tenant Mega Dulces.
  const canon = await knex('catalog.products').where({ tenant_id: MEGA, sku: '42029' }).first('id');
  const alias = await knex('catalog.products').where({ tenant_id: MEGA, sku: '42073' }).first('id');
  if (canon && alias) {
    const already = await knex('commercial.product_aliases')
      .where({ tenant_id: MEGA, alias_product_id: alias.id }).whereNull('deleted_at').first('id');
    if (!already) {
      await knex('commercial.product_aliases').insert({
        tenant_id: MEGA, alias_product_id: alias.id, canonical_product_id: canon.id,
        note: 'Kinder Delice 9+1P (in-and-out promo) → 10P base',
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.product_aliases`);
};
