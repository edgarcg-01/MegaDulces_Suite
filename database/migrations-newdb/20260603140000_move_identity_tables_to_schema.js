/**
 * Sprint orden DB — refactor REAL: mover tablas del dominio identity a schema
 * dedicado. Estrategia:
 *
 *   1. DROP VIEWS identity.* passthrough creadas en migración 130000 (eran
 *      placeholder — ahora las tablas reales viven ahí).
 *   2. ALTER TABLE x SET SCHEMA identity para users/tenants/role_permissions.
 *      Postgres mueve automáticamente:
 *        - Indexes (17)
 *        - RLS policies (2)
 *        - Triggers (2)
 *        - FKs entrantes (159 — referencias por OID, no por nombre)
 *   3. CREATE VIEW public.X como wrapper backwards-compat. El código existente
 *      con `trx('public.users')` sigue funcionando vía la VIEW updatable.
 *   4. ALTER ROLE app_runtime/postgres SET search_path para que `trx('users')`
 *      sin prefix encuentre `identity.users` directamente.
 *   5. Re-grant explícitos en el schema nuevo.
 *
 * Backwards compat: cero código de app rompe inmediatamente. Migración gradual
 * a `identity.X` puede hacerse después; cuando esté completa, DROP VIEW.
 *
 * Idempotente: chequea existencia antes de cada operación.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. Drop VIEWs passthrough placeholder ──
  await knex.raw(`DROP VIEW IF EXISTS identity.users`);
  await knex.raw(`DROP VIEW IF EXISTS identity.tenants`);
  await knex.raw(`DROP VIEW IF EXISTS identity.role_permissions`);

  // ── 2. ALTER TABLE SET SCHEMA ──
  // Chequear que la tabla todavía está en public (idempotencia)
  for (const tbl of ['users', 'tenants', 'role_permissions']) {
    const inPublic = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inPublic.rows.length > 0) {
      await knex.raw(`ALTER TABLE public.${tbl} SET SCHEMA identity`);
      console.log(`  ✓ moved public.${tbl} → identity.${tbl}`);
    }
  }

  // ── 3. CREATE VIEW public.X como wrapper backwards-compat ──
  // Las VIEWS son automáticamente updatable porque son SELECT * sin transform.
  // El código existente que hace trx('public.users').insert/update/delete sigue
  // funcionando a través de la VIEW (Postgres re-rutea al table subyacente).
  for (const tbl of ['users', 'tenants', 'role_permissions']) {
    await knex.raw(`DROP VIEW IF EXISTS public.${tbl}`);
    await knex.raw(`CREATE VIEW public.${tbl} AS SELECT * FROM identity.${tbl}`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tbl} TO app_runtime`);
    await knex.raw(
      `COMMENT ON VIEW public.${tbl} IS 'Backwards-compat wrapper. Tabla real en identity.${tbl}. Eliminar cuando todo el código use identity.${tbl} directo.'`,
    );
  }

  // ── 4. Grants en identity ──
  await knex.raw(`GRANT USAGE ON SCHEMA identity TO app_runtime`);
  for (const tbl of ['users', 'tenants', 'role_permissions']) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.${tbl} TO app_runtime`);
  }

  // ── 5. search_path para que trx('users') resuelva a identity.users ──
  // Incluimos todos los schemas del proyecto en orden de preferencia.
  // public queda último para que las VIEWs wrapper sigan accesibles si alguien
  // las pide explícitamente.
  await knex.raw(`
    ALTER ROLE app_runtime SET search_path = identity, catalog, field_ops, scoring, commercial, logistics, public
  `);
  // Para postgres user (superadmin de DB)
  await knex.raw(`
    ALTER ROLE postgres SET search_path = identity, catalog, field_ops, scoring, commercial, logistics, public, "$user"
  `);

  console.log('  ✓ identity domain migrado. backwards-compat via VIEWs en public.*');
};

/**
 * Rollback: mover tablas de vuelta a public + drop VIEWs.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Drop VIEWs backwards-compat
  await knex.raw(`DROP VIEW IF EXISTS public.users`);
  await knex.raw(`DROP VIEW IF EXISTS public.tenants`);
  await knex.raw(`DROP VIEW IF EXISTS public.role_permissions`);

  // Mover tablas de vuelta
  for (const tbl of ['users', 'tenants', 'role_permissions']) {
    const inIdentity = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='identity' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inIdentity.rows.length > 0) {
      await knex.raw(`ALTER TABLE identity.${tbl} SET SCHEMA public`);
    }
  }

  // Re-create VIEWs passthrough (las que creó la migración 130000)
  await knex.raw(`CREATE VIEW identity.users AS SELECT * FROM public.users WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE VIEW identity.tenants AS SELECT * FROM public.tenants WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE VIEW identity.role_permissions AS SELECT * FROM public.role_permissions`);
  for (const v of ['users', 'tenants', 'role_permissions']) {
    await knex.raw(`GRANT SELECT ON identity.${v} TO app_runtime`);
  }

  // Restore search_path original
  await knex.raw(`ALTER ROLE app_runtime RESET search_path`);
  await knex.raw(`ALTER ROLE postgres RESET search_path`);
};
