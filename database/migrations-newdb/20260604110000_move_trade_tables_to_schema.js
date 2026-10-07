/**
 * Fase L.2 — Mover las 14 tablas trade marketing de `public.*` a `trade.*`.
 *
 * Estrategia (mismo patrón que `20260603140000_move_identity_tables_to_schema.js`):
 *   1. Drop VIEWs muertas en `field_ops.*` y `scoring.*` (apuntan a public.*
 *      desde un intento previo de namespacing al revés — se reemplazan por
 *      tablas reales en trade.* mediante este move).
 *   2. ALTER TABLE x SET SCHEMA trade — mueve cada tabla. Postgres actualiza
 *      automáticamente: indexes, RLS policies, triggers, FKs (por OID).
 *   3. CREATE VIEW public.X como wrapper backwards-compat. El código existente
 *      con `knex('stores')` (resuelve via search_path a public.stores) sigue
 *      funcionando — la VIEW updatable delega INSERT/UPDATE/DELETE a la tabla
 *      real en trade.*.
 *   4. Re-grant explícitos en el schema nuevo.
 *   5. Update search_path para incluir `trade` antes que public.
 *
 * Backwards-compat: cero código de app rompe inmediatamente. Migración gradual
 * a `trade.X` puede hacerse después en L.5; cuando esté completa, DROP VIEW
 * en L.8.
 *
 * Idempotente.
 *
 * ADR-015 — Schema reorg.
 *
 * @param { import("knex").Knex } knex
 */
const TRADE_TABLES = [
  // Orden no es crítico — Postgres maneja las FKs internas por OID dentro de
  // la transacción. Lo listamos en orden topológico solo para legibilidad.
  'zones',
  'catalogs',
  'stores',
  'scoring_config',
  'scoring_config_versions',
  'scoring_weights',
  'rubric_criteria',
  'rubric_levels',
  'valid_exhibition_combinations',
  'daily_assignments',
  'daily_captures',
  'visits',
  'exhibitions',
  'exhibition_photos',
];

exports.up = async function (knex) {
  // ── 1. Drop VIEWs muertas en field_ops.* y scoring.* ──
  // Eran intentos previos de namespacing que dejaron las tablas en public.
  const fieldOpsViews = [
    'stores',
    'zones',
    'daily_captures',
    'daily_assignments',
    'visits',
    'exhibitions',
    'exhibition_photos',
  ];
  for (const v of fieldOpsViews) {
    await knex.raw(`DROP VIEW IF EXISTS field_ops.${v}`);
  }
  const scoringViews = [
    'catalogs',
    'scoring_config',
    'scoring_config_versions',
    'scoring_weights',
    'rubric_criteria',
    'rubric_levels',
    'valid_exhibition_combinations',
  ];
  for (const v of scoringViews) {
    await knex.raw(`DROP VIEW IF EXISTS scoring.${v}`);
  }

  // ── 2. ALTER TABLE SET SCHEMA ──
  for (const tbl of TRADE_TABLES) {
    const inPublic = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inPublic.rows.length > 0) {
      await knex.raw(`ALTER TABLE public.${tbl} SET SCHEMA trade`);
      console.log(`  ✓ moved public.${tbl} → trade.${tbl}`);
    } else {
      console.log(`  - skipped ${tbl} (no en public)`);
    }
  }

  // ── 3. CREATE VIEW public.X como wrapper backwards-compat ──
  // Las VIEWS son automáticamente updatable porque son SELECT * sin transform.
  for (const tbl of TRADE_TABLES) {
    await knex.raw(`DROP VIEW IF EXISTS public.${tbl}`);
    await knex.raw(`CREATE VIEW public.${tbl} AS SELECT * FROM trade.${tbl}`);
    await knex.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.${tbl} TO app_runtime`,
    );
    await knex.raw(
      `COMMENT ON VIEW public.${tbl} IS 'Backwards-compat wrapper. Tabla real en trade.${tbl}. Eliminar en Fase L.8 cuando todo el código use trade.${tbl} directo.'`,
    );
  }

  // ── 4. Grants en trade.* ──
  for (const tbl of TRADE_TABLES) {
    await knex.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON trade.${tbl} TO app_runtime`,
    );
  }

  // ── 5. Update search_path: incluir trade antes que public ──
  // La migración 20260603140000 dejó: identity, catalog, field_ops, scoring,
  // commercial, logistics, public
  // Ahora agregamos `trade` después de logistics y antes de public (legacy
  // resolution). `field_ops` y `scoring` se dropearán en L.8 después de verificar
  // que nada los usa más.
  await knex.raw(`
    ALTER ROLE app_runtime SET search_path = identity, catalog, trade, field_ops, scoring, commercial, logistics, public
  `);
  await knex.raw(`
    ALTER ROLE postgres SET search_path = identity, catalog, trade, field_ops, scoring, commercial, logistics, public, "$user"
  `);

  console.log(
    '  ✓ 14 tablas trade marketing movidas a schema trade.* + VIEWs backward-compat en public.*',
  );
};

/**
 * Rollback: mover tablas de vuelta a public + drop VIEWs + restore search_path.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Drop VIEWs backwards-compat
  for (const tbl of TRADE_TABLES) {
    await knex.raw(`DROP VIEW IF EXISTS public.${tbl}`);
  }

  // Mover tablas de vuelta a public
  for (const tbl of TRADE_TABLES) {
    const inTrade = await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade' AND c.relname=? AND c.relkind='r'`,
      [tbl],
    );
    if (inTrade.rows.length > 0) {
      await knex.raw(`ALTER TABLE trade.${tbl} SET SCHEMA public`);
    }
  }

  // Restore search_path al estado anterior (sin trade)
  await knex.raw(`
    ALTER ROLE app_runtime SET search_path = identity, catalog, field_ops, scoring, commercial, logistics, public
  `);
  await knex.raw(`
    ALTER ROLE postgres SET search_path = identity, catalog, field_ops, scoring, commercial, logistics, public, "$user"
  `);

  // Re-create VIEWs muertas en field_ops y scoring (las que la 130000 dejó)
  // Solo si los schemas siguen existiendo
  const fieldOpsExists = await knex.raw(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'field_ops'`,
  );
  if (fieldOpsExists.rows.length > 0) {
    // Restaurar las views con filtro deleted_at IS NULL (era el comportamiento
    // de la migración previa)
    const fieldOpsViews = {
      stores:
        'SELECT id, tenant_id, nombre, direccion, zona_id, ruta_id, latitud, longitud, activo, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by, exhibiciones_esperadas FROM public.stores WHERE deleted_at IS NULL',
      zones: 'SELECT * FROM public.zones WHERE deleted_at IS NULL',
      daily_captures: 'SELECT * FROM public.daily_captures',
      daily_assignments: 'SELECT * FROM public.daily_assignments WHERE deleted_at IS NULL',
      visits: 'SELECT * FROM public.visits',
      exhibitions: 'SELECT * FROM public.exhibitions',
      exhibition_photos: 'SELECT * FROM public.exhibition_photos',
    };
    for (const [v, def] of Object.entries(fieldOpsViews)) {
      await knex.raw(`CREATE VIEW field_ops.${v} AS ${def}`);
      await knex.raw(`GRANT SELECT ON field_ops.${v} TO app_runtime`);
    }
  }

  const scoringExists = await knex.raw(
    `SELECT 1 FROM pg_namespace WHERE nspname = 'scoring'`,
  );
  if (scoringExists.rows.length > 0) {
    for (const v of [
      'catalogs',
      'scoring_config',
      'scoring_config_versions',
      'scoring_weights',
      'rubric_criteria',
      'rubric_levels',
      'valid_exhibition_combinations',
    ]) {
      await knex.raw(`CREATE VIEW scoring.${v} AS SELECT * FROM public.${v}`);
      await knex.raw(`GRANT SELECT ON scoring.${v} TO app_runtime`);
    }
  }
};
