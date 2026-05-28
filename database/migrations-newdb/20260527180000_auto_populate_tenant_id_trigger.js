/**
 * Migración — Defensa en profundidad: trigger BEFORE INSERT que auto-popula
 * `tenant_id` desde `current_tenant_id()` cuando no viene explícito en el
 * INSERT.
 *
 * Contexto del problema:
 * Los services legacy (stores, visits, daily-captures, users, etc.) usan el
 * pool `KNEX_CONNECTION` directo y hacen INSERTs sin tenant_id (es código
 * single-tenant). Con la DB multi-tenant nueva, `tenant_id NOT NULL` rechaza
 * estos INSERTs.
 *
 * Esta migración + el refactor del DatabaseModule (que setea `app.tenant_id`
 * por request en el pool legacy) resuelven el problema sin parchear cada
 * service uno por uno.
 *
 * - Si `NEW.tenant_id` viene poblado → no toca nada.
 * - Si viene NULL y `current_tenant_id()` está seteado → auto-popula.
 * - Si ambos NULL → RAISE EXCEPTION explícita (mejor que "null violates").
 *
 * Aplica a TODAS las tablas legacy de `public.*` con `tenant_id NOT NULL`.
 */

const LEGACY_TABLES = [
  'brands',
  'catalogs',
  'daily_assignments',
  'daily_captures',
  'exhibition_photos',
  'exhibitions',
  'products',
  'role_permissions',
  'rubric_criteria',
  'rubric_levels',
  'scoring_config',
  'scoring_config_versions',
  'scoring_weights',
  'stores',
  'users',
  'valid_exhibition_combinations',
  'visits',
  'zones',
];

exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Función trigger compartida
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.auto_populate_tenant_id()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.tenant_id IS NULL THEN
        NEW.tenant_id := public.current_tenant_id();
        IF NEW.tenant_id IS NULL THEN
          RAISE EXCEPTION
            'tenant_id no provisto y current_tenant_id() no seteado en contexto. '
            'Verificar que el request tiene Bearer JWT válido con tenant_id, y que '
            'el TenantContextInterceptor + LegacyTenantTx están configurados.'
            USING ERRCODE = '23502', COLUMN = 'tenant_id';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION public.auto_populate_tenant_id() IS
    'Trigger function: BEFORE INSERT en tablas legacy multi-tenant. Auto-popula '
    'tenant_id desde current_tenant_id() del contexto CLS si no viene explícito.';
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Trigger en cada tabla legacy con tenant_id NOT NULL
  // ─────────────────────────────────────────────────────────────────────────
  for (const tbl of LEGACY_TABLES) {
    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON public.${tbl};
      CREATE TRIGGER trg_auto_populate_tenant_id
        BEFORE INSERT ON public.${tbl}
        FOR EACH ROW
        EXECUTE FUNCTION public.auto_populate_tenant_id();
    `);
  }
};

exports.down = async function (knex) {
  for (const tbl of LEGACY_TABLES) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON public.${tbl}`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS public.auto_populate_tenant_id()`);
};
