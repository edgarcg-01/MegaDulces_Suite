/**
 * Fase P2.6 — Promotores de marca propia (Canel's, De la Rosa…).
 *
 * Mapa usuario↔marca: un promotor solo ve/captura los SKUs de SUS marcas en el
 * Control de Caducidades. Multi-marca (una marca puede tener varias brand_id por
 * duplicados de catálogo → el promotor puede tener CANEL'S + CANEL´S S.A.).
 *
 * NO se pone FK a brand_id/user_id: `public.brands`/`public.users` son vistas
 * (no FK-ables) y catalog/identity varían; se valida a nivel app. tenant_id sí
 * FK a identity.tenants (patrón de commercial.stock_lots). RLS forzado.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('promoter_brands')) return;

  await knex.schema.withSchema('commercial').createTable('promoter_brands', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('user_id').notNullable();
    t.uuid('brand_id').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');

    t.primary('id');
    t.unique(['tenant_id', 'user_id', 'brand_id'], { indexName: 'commercial_promoter_brands_unique' });
    t.index(['tenant_id', 'user_id'], 'idx_commercial_promoter_brands_user');
  });

  await knex.raw(`
    ALTER TABLE commercial.promoter_brands
      ADD CONSTRAINT fk_commercial_promoter_brands_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.promoter_brands ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.promoter_brands FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.promoter_brands`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.promoter_brands
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.promoter_brands TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.promoter_brands IS 'P2.6 — mapa promotor(usuario)↔marca: el promotor solo ve sus SKUs en Control de Caducidades. Multi-marca. ADR-022.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('promoter_brands');
};
