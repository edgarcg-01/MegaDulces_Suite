/**
 * GX.8 scoping — Normalización del ÁREA (departamento) de gastos + mapeo usuario→áreas.
 *
 * Regla del proyecto: toda tabla ligada a Kepler debe estar NORMALIZADA. El `area` de
 * los gastos (Kepler XA1001) hoy es texto libre repetido en `analytics.expense_documents`
 * y `finance.expense_comprobaciones`. Creamos la DIMENSIÓN CANÓNICA `finance.expense_areas`
 * (una fila por área, id estable) y ligamos por `id`, no por string.
 *
 * `norm_key` (GENERATED = upper(btrim(name))) es la llave determinista que cruza el nombre
 * crudo de Kepler con la dimensión (mismo origen → match exacto, sin depender de unaccent).
 *
 * Además: `public.users.finance_expense_area_ids uuid[]` = las áreas que un usuario puede
 * ver. Sin el permiso FINANCE_EXPENSES_VER_ALL, el backend acota los gastos/comprobaciones
 * a estas áreas (default seguro: sin áreas → no ve nada).
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // 1) Dimensión canónica de áreas/departamentos de gasto.
  if (!(await knex.schema.withSchema('finance').hasTable('expense_areas'))) {
    await knex.raw(`
      CREATE TABLE finance.expense_areas (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        name        text NOT NULL,                                   -- nombre canónico (= area cruda de Kepler, btrim)
        norm_key    text GENERATED ALWAYS AS (upper(btrim(name))) STORED,  -- llave determinista de cruce
        code        text,                                            -- código dpto Kepler (1-RR-SS-XX) si se conoce
        sucursal    text,                                            -- plaza derivada (opcional)
        active      boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, norm_key)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_area_tenant ON finance.expense_areas (tenant_id, active)`);
    await knex.raw(`ALTER TABLE finance.expense_areas ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.expense_areas FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='expense_areas' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.expense_areas
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expense_areas TO app_runtime`);
  }

  // 2) Seed inicial: distintas áreas de los gastos (XA1001) + las ya usadas en comprobaciones.
  //    (Corre como superuser → bypass RLS; UPSERT idempotente por norm_key generada.)
  await knex.raw(`
    INSERT INTO finance.expense_areas (tenant_id, name)
    SELECT DISTINCT tenant_id, btrim(area)
      FROM analytics.expense_documents
     WHERE doc_tipo = 'XA1001' AND area IS NOT NULL AND btrim(area) <> ''
    ON CONFLICT (tenant_id, norm_key) DO NOTHING`);
  await knex.raw(`
    INSERT INTO finance.expense_areas (tenant_id, name)
    SELECT DISTINCT tenant_id, btrim(departamento)
      FROM finance.expense_comprobaciones
     WHERE departamento IS NOT NULL AND btrim(departamento) <> ''
    ON CONFLICT (tenant_id, norm_key) DO NOTHING`);

  // 3) Normaliza NUESTRA tabla: expense_comprobaciones.area_id → dimensión.
  if (!(await knex.schema.withSchema('finance').hasColumn('expense_comprobaciones', 'area_id'))) {
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones ADD COLUMN area_id uuid`);
    await knex.raw(`CREATE INDEX ix_fin_ec_area ON finance.expense_comprobaciones (tenant_id, area_id)`);
    await knex.raw(`
      UPDATE finance.expense_comprobaciones ec
         SET area_id = ea.id
        FROM finance.expense_areas ea
       WHERE ea.tenant_id = ec.tenant_id
         AND ea.norm_key = upper(btrim(ec.departamento))
         AND ec.area_id IS NULL`);
  }

  // 4) Mapeo usuario → áreas visibles.
  //    public.users es una VISTA passthrough sobre identity.users → la columna va en la
  //    TABLA real + se recrea la vista para exponerla (patrón feedback_fieldops_passthrough_views;
  //    ver 20260730130000_users_view_warehouse_code). ALTER directo sobre la vista falla en prod.
  if (!(await knex.schema.withSchema('identity').hasColumn('users', 'finance_expense_area_ids'))) {
    await knex.raw(`ALTER TABLE identity.users ADD COLUMN finance_expense_area_ids uuid[]`);
  }
  const exposed = await knex.raw(
    `SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname='users'
        AND a.attname='finance_expense_area_ids' AND a.attnum>0 AND NOT a.attisdropped`,
  );
  if (!exposed.rows.length) {
    await knex.raw(`
      CREATE OR REPLACE VIEW public.users AS
      SELECT
        id, tenant_id, username, password_hash, nombre, zona_id, role_name,
        supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
        updated_by, deleted_at, deleted_by, customer_id, last_login_at,
        last_login_ip, last_login_user_agent, warehouse_code, finance_expense_area_ids
      FROM identity.users
    `);
  }
};

exports.down = async function (knex) {
  // Quitar la exposición en la vista (CREATE OR REPLACE no puede quitar columnas → DROP+CREATE),
  // luego la columna de la tabla real. Re-grant defensivo (DROP+CREATE pierde grants).
  await knex.raw(`DROP VIEW IF EXISTS public.users`);
  await knex.raw(`
    CREATE VIEW public.users AS
    SELECT
      id, tenant_id, username, password_hash, nombre, zona_id, role_name,
      supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
      updated_by, deleted_at, deleted_by, customer_id, last_login_at,
      last_login_ip, last_login_user_agent, warehouse_code
    FROM identity.users
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO app_runtime`);
  if (await knex.schema.withSchema('identity').hasColumn('users', 'finance_expense_area_ids')) {
    await knex.raw(`ALTER TABLE identity.users DROP COLUMN finance_expense_area_ids`);
  }
  if (await knex.schema.withSchema('finance').hasColumn('expense_comprobaciones', 'area_id')) {
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP COLUMN area_id`);
  }
  await knex.schema.withSchema('finance').dropTableIfExists('expense_areas');
};
