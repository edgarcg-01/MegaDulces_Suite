/**
 * Sprint orden DB — refactor del dominio ERP.
 *
 * Reorganiza tablas relacionadas al ERP Mega_Dulces en un schema dedicado `erp`:
 *
 *   ANTES                                          DESPUÉS
 *   analytics_external.ventas_legacy            → erp.ventas
 *   analytics_external.ranking_legacy           → erp.ranking_productos
 *   analytics_external.productos_activos_legacy → erp.productos_activos
 *   public.vendedores_erp                       → erp.staff
 *
 * Razones:
 *   1. `analytics_external` era nombre ambiguo (suena a "analytics externo")
 *      cuando realmente es data del ERP.
 *   2. `vendedores_erp` mezcla español+inglés; `erp.staff` es claro y consistente.
 *   3. Sufijo `_legacy` era redundante dado que el schema ya da contexto.
 *
 * Backwards-compat: VIEWS en analytics_external + public para que el código
 * existente siga funcionando sin tocarse.
 *
 * Limitaciones:
 *   - ALTER FOREIGN TABLE SET SCHEMA es soportado en PG 9.1+.
 *   - VIEWs sobre foreign tables son read-only (lo que ya era el caso).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. Schema erp ──
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS erp`);
  await knex.raw(`GRANT USAGE ON SCHEMA erp TO app_runtime`);
  await knex.raw(
    `COMMENT ON SCHEMA erp IS 'Dominio ERP Mega_Dulces: foreign tables (FDW al ERP externo) + tablas locales con data sincronizada del ERP. Reemplaza el viejo schema analytics_external + tabla suelta vendedores_erp.'`,
  );

  // ── 2. Mover + renombrar foreign tables ──
  const fdwMoves = [
    ['ventas_legacy', 'ventas'],
    ['ranking_legacy', 'ranking_productos'],
    ['productos_activos_legacy', 'productos_activos'],
  ];

  for (const [oldName, newName] of fdwMoves) {
    const exists = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='analytics_external' AND c.relname=? AND c.relkind='f'`,
      [oldName],
    );
    if (exists.rows.length > 0) {
      await knex.raw(`ALTER FOREIGN TABLE analytics_external.${oldName} SET SCHEMA erp`);
      await knex.raw(`ALTER FOREIGN TABLE erp.${oldName} RENAME TO ${newName}`);
      await knex.raw(`GRANT SELECT ON erp.${newName} TO app_runtime`);
      console.log(`  ✓ analytics_external.${oldName} → erp.${newName}`);
    }
  }

  // ── 3. Mover + renombrar vendedores_erp ──
  // Hay que tener cuidado: ya existe identity.users con FK desde vendedores_erp.
  // ALTER TABLE SET SCHEMA preserva FKs automáticamente (referencias por OID).
  const vendInPublic = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='vendedores_erp' AND c.relkind='r'`,
  );
  if (vendInPublic.rows.length > 0) {
    await knex.raw(`ALTER TABLE public.vendedores_erp SET SCHEMA erp`);
    await knex.raw(`ALTER TABLE erp.vendedores_erp RENAME TO staff`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON erp.staff TO app_runtime`);
    console.log(`  ✓ public.vendedores_erp → erp.staff`);
  }

  // ── 4. Backwards-compat VIEWs ──
  // analytics_external sigue existiendo con VIEWs que apuntan a las nuevas foreign tables.
  // Esto evita tocar commercial-analytics.service.ts que usa `analytics_external.ventas_legacy`.
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ventas_legacy`);
  await knex.raw(`CREATE VIEW analytics_external.ventas_legacy AS SELECT * FROM erp.ventas`);
  await knex.raw(`GRANT SELECT ON analytics_external.ventas_legacy TO app_runtime`);

  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ranking_legacy`);
  await knex.raw(`CREATE VIEW analytics_external.ranking_legacy AS SELECT * FROM erp.ranking_productos`);
  await knex.raw(`GRANT SELECT ON analytics_external.ranking_legacy TO app_runtime`);

  await knex.raw(`DROP VIEW IF EXISTS analytics_external.productos_activos_legacy`);
  await knex.raw(`CREATE VIEW analytics_external.productos_activos_legacy AS SELECT * FROM erp.productos_activos`);
  await knex.raw(`GRANT SELECT ON analytics_external.productos_activos_legacy TO app_runtime`);

  // public.vendedores_erp backwards-compat
  await knex.raw(`DROP VIEW IF EXISTS public.vendedores_erp`);
  await knex.raw(`CREATE VIEW public.vendedores_erp AS SELECT * FROM erp.staff`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendedores_erp TO app_runtime`);
  await knex.raw(
    `COMMENT ON VIEW public.vendedores_erp IS 'Backwards-compat wrapper. Tabla real en erp.staff.'`,
  );

  console.log('  ✓ ERP domain refactor completo. backwards-compat via VIEWs.');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Drop VIEWS backwards-compat
  await knex.raw(`DROP VIEW IF EXISTS public.vendedores_erp`);
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.productos_activos_legacy`);
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ranking_legacy`);
  await knex.raw(`DROP VIEW IF EXISTS analytics_external.ventas_legacy`);

  // Mover staff de vuelta
  const staffInErp = await knex.raw(
    `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp' AND c.relname='staff' AND c.relkind='r'`,
  );
  if (staffInErp.rows.length > 0) {
    await knex.raw(`ALTER TABLE erp.staff RENAME TO vendedores_erp`);
    await knex.raw(`ALTER TABLE erp.vendedores_erp SET SCHEMA public`);
  }

  // Mover foreign tables de vuelta
  for (const [oldName, newName] of [
    ['ventas_legacy', 'ventas'],
    ['ranking_legacy', 'ranking_productos'],
    ['productos_activos_legacy', 'productos_activos'],
  ]) {
    const exists = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='erp' AND c.relname=? AND c.relkind='f'`,
      [newName],
    );
    if (exists.rows.length > 0) {
      await knex.raw(`ALTER FOREIGN TABLE erp.${newName} RENAME TO ${oldName}`);
      await knex.raw(`ALTER FOREIGN TABLE erp.${oldName} SET SCHEMA analytics_external`);
    }
  }

  // No drop schema erp — puede tener data ya migrada.
};
