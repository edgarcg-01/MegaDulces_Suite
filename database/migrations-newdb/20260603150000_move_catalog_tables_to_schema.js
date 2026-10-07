/**
 * Sprint orden DB — refactor REAL del dominio catalog.
 *
 * Mueve tablas y VIEWs/MV físicamente a schema `catalog`. Deja VIEWs
 * backwards-compat en `public` (cero ruptura de código existente que use
 * `public.products`, etc).
 *
 * Tablas a mover:
 *   - public.products      → catalog.products
 *   - public.brands        → catalog.brands
 *   - public.categories    → catalog.categories
 *
 * Vistas/MV existentes (en public) a mover:
 *   - public.products_active       → catalog.products_active (VIEW)
 *   - public.products_top_sellers  → catalog.products_top_sellers (MATERIALIZED VIEW)
 *
 * Preserva via ALTER SET SCHEMA:
 *   - Todas las FKs entrantes (referencias por OID)
 *   - RLS policies
 *   - Triggers
 *   - Indexes
 *   - Grants
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. Drop las VIEWS passthrough creadas en migración 120000 ──
  // Estas eran placeholders. Ahora las tablas/MV reales van a vivir directamente
  // en catalog (no necesitamos VIEWs passthrough porque las reales están ahí).
  await knex.raw(`DROP VIEW IF EXISTS catalog.products`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_active`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_top_sellers`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.brands`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.categories`);

  // ── 2. ALTER TABLE SET SCHEMA ──
  // Las VIEWs definidas con SELECT que referencian public.products siguen
  // funcionando porque Postgres re-resuelve por OID al re-bind, y porque vamos
  // a crear públic.products como VIEW backwards-compat en el paso 4.
  for (const tbl of ['products', 'brands', 'categories']) {
    const inPublic = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inPublic.rows.length > 0) {
      await knex.raw(`ALTER TABLE public.${tbl} SET SCHEMA catalog`);
      console.log(`  ✓ moved public.${tbl} → catalog.${tbl}`);
    }
  }

  // ── 3. Mover VIEW y MATERIALIZED VIEW ──
  // public.products_active está definida como SELECT FROM public.products + analytics_external...
  // Al moverla a catalog, su definición se mantiene literal. Como vamos a crear
  // public.products como VIEW backwards-compat → catalog.products, la cadena resuelve.
  const viewInPublic = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='products_active' AND c.relkind='v'`,
  );
  if (viewInPublic.rows.length > 0) {
    await knex.raw(`ALTER VIEW public.products_active SET SCHEMA catalog`);
    console.log(`  ✓ moved public.products_active → catalog.products_active (VIEW)`);
  }

  const mvInPublic = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='products_top_sellers' AND c.relkind='m'`,
  );
  if (mvInPublic.rows.length > 0) {
    await knex.raw(`ALTER MATERIALIZED VIEW public.products_top_sellers SET SCHEMA catalog`);
    console.log(`  ✓ moved public.products_top_sellers → catalog.products_top_sellers (MV)`);
  }

  // ── 4. Backwards-compat VIEWs en public ──
  for (const tbl of ['products', 'brands', 'categories']) {
    await knex.raw(`DROP VIEW IF EXISTS public.${tbl}`);
    await knex.raw(`CREATE VIEW public.${tbl} AS SELECT * FROM catalog.${tbl}`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tbl} TO app_runtime`);
    await knex.raw(
      `COMMENT ON VIEW public.${tbl} IS 'Backwards-compat wrapper. Tabla real en catalog.${tbl}. Eliminar cuando todo el código migre a catalog.${tbl}.'`,
    );
  }

  // VIEW + MV: solo read-only wrappers
  await knex.raw(`DROP VIEW IF EXISTS public.products_active`);
  await knex.raw(`CREATE VIEW public.products_active AS SELECT * FROM catalog.products_active`);
  await knex.raw(`GRANT SELECT ON public.products_active TO app_runtime`);

  await knex.raw(`DROP VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`CREATE VIEW public.products_top_sellers AS SELECT * FROM catalog.products_top_sellers`);
  await knex.raw(`GRANT SELECT ON public.products_top_sellers TO app_runtime`);

  // ── 5. Grants en catalog ──
  await knex.raw(`GRANT USAGE ON SCHEMA catalog TO app_runtime`);
  for (const tbl of ['products', 'brands', 'categories']) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.${tbl} TO app_runtime`);
  }
  await knex.raw(`GRANT SELECT ON catalog.products_active TO app_runtime`);
  await knex.raw(`GRANT SELECT ON catalog.products_top_sellers TO app_runtime`);

  console.log('  ✓ catalog domain refactor completo. backwards-compat via VIEWs en public.*');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS public.products_top_sellers`);
  await knex.raw(`DROP VIEW IF EXISTS public.products_active`);
  for (const tbl of ['products', 'brands', 'categories']) {
    await knex.raw(`DROP VIEW IF EXISTS public.${tbl}`);
  }

  const mvInCatalog = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='catalog' AND c.relname='products_top_sellers' AND c.relkind='m'`,
  );
  if (mvInCatalog.rows.length > 0) {
    await knex.raw(`ALTER MATERIALIZED VIEW catalog.products_top_sellers SET SCHEMA public`);
  }
  const viewInCatalog = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='catalog' AND c.relname='products_active' AND c.relkind='v'`,
  );
  if (viewInCatalog.rows.length > 0) {
    await knex.raw(`ALTER VIEW catalog.products_active SET SCHEMA public`);
  }

  for (const tbl of ['products', 'brands', 'categories']) {
    const inCatalog = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='catalog' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inCatalog.rows.length > 0) {
      await knex.raw(`ALTER TABLE catalog.${tbl} SET SCHEMA public`);
    }
  }

  // Restore passthrough VIEWs en catalog (migración 120000)
  await knex.raw(`CREATE VIEW catalog.products AS SELECT * FROM public.products WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE VIEW catalog.products_active AS SELECT * FROM public.products_active`);
  await knex.raw(`CREATE VIEW catalog.products_top_sellers AS SELECT * FROM public.products_top_sellers`);
  await knex.raw(`CREATE VIEW catalog.brands AS SELECT * FROM public.brands WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE VIEW catalog.categories AS SELECT * FROM public.categories WHERE deleted_at IS NULL`);
  for (const v of ['products', 'brands', 'categories', 'products_active', 'products_top_sellers']) {
    await knex.raw(`GRANT SELECT ON catalog.${v} TO app_runtime`);
  }
};
