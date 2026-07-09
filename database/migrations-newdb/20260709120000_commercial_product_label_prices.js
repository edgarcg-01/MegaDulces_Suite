/**
 * Etiquetera (proyecto Tienda) — datos de etiqueta de anaquel por producto.
 *
 * commercial.product_label_prices = 1 fila por producto con TODO lo que necesita
 * la etiqueta de precio escalonado (pieza / mayoreo / paquete / caja), tal como lo
 * imprime Kepler. Fuente (decodificada 2026-07-09):
 *   - md.kdii            → gramaje (en el nombre "…50G/8"), barcode c7, precios base
 *                          c90 (pieza) / c91 (paquete) / c92 (caja), factores c81 (pzas
 *                          por paquete) / c84 (pzas por caja).
 *   - md.kdpv_prod_util  → tiers de mayoreo: PZA (c4=umbral "desde N", c7=precio c/u),
 *                          PAQ (c7=mayoreo paquete c/u).
 *
 * Guardamos gramaje + barcode validado AQUÍ (no en catalog.products) para no tener
 * que recrear la vista public.products. `barcode_format` lo setea el importer según
 * la longitud del número (13→EAN13, 12→UPC, 8→EAN8, resto→null si es basura) para que
 * el frontend no dibuje códigos de barras inválidos.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; services
 * vía TenantKnexService.run(). FK compuesta a catalog.products (public.products es VISTA).
 * Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON commercial.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('product_label_prices'))) {
    await knex.raw(`
      CREATE TABLE commercial.product_label_prices (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        product_id              uuid NOT NULL,
        content                 varchar(40),                 -- gramaje ej. "50 g"
        barcode                 varchar(30),                 -- número a imprimir (pieza)
        barcode_format          varchar(10),                 -- EAN13 | UPC | EAN8 | null (inválido)
        piece_price             numeric(14,4),               -- precio por pieza (kdii.c90)
        wholesale_piece_min_qty integer,                     -- "mayoreo desde N pzas" (kdpv PZA c4)
        wholesale_piece_price   numeric(14,4),               -- c/u de ese mayoreo (kdpv PZA c7)
        pack_size               integer,                     -- pzas por paquete (kdii.c81)
        pack_price              numeric(14,4),               -- precio del paquete (kdii.c91)
        wholesale_pack_price    numeric(14,4),               -- mayoreo paquete c/u (kdpv PAQ c7)
        box_size                integer,                     -- pzas por caja (kdii.c84)
        box_price               numeric(14,4),               -- precio de la caja (kdii.c92)
        source                  varchar(12) NOT NULL DEFAULT 'kepler' CHECK (source IN ('kepler','manual')),
        computed_at             timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, product_id),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_product_label_prices_product ON commercial.product_label_prices (tenant_id, product_id)`);
    await knex.raw(`COMMENT ON TABLE commercial.product_label_prices IS 'Etiquetera Tienda — datos de la etiqueta de anaquel por producto (gramaje, barcode validado, matriz pieza/mayoreo/paquete/caja). source: kepler (kdii + kdpv_prod_util) | manual (override, no lo pisa el importer).'`);
    await createTenantRls(knex, 'product_label_prices');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('product_label_prices');
};
