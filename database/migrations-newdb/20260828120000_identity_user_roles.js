'use strict';
/**
 * `[ID.13]` — Un usuario puede tener VARIOS roles (Fase ID / CRM-ERP).
 *
 * El problema medido (ver `FASE_ID_ESQUEMA_USUARIOS_ERP.md` §H5/H6):
 * `identity.users.role_name` es UNA columna, así que una persona = un rol. La
 * consecuencia real en prod:
 *   - **6 personas con 2 cuentas** — la encargada de sucursal que además cobra
 *     en caja abrió `04`/`cajera` aparte de `monica_mejia`/`encargado_sucursal`.
 *     Una de esas segundas cuentas es **superadmin con username ilegible**.
 *   - **`captura_gastos`: 22 usuarios, 1 permiso.** No es un rol, es una tarea;
 *     y como el rol venía pegado al departamento, los 22 quedaron en
 *     `administracion` incluyendo gente de Logística y de una sucursal.
 *
 * Solución: `identity.user_roles` (N:M) con **un perfil base** (`is_primary`) y
 * **N complementos**. Los permisos efectivos son la UNIÓN.
 *
 * Compatibilidad — esto es lo que hace la migración segura:
 *   `users.role_name` NO se va. Sigue siendo el perfil base y se mantiene
 *   sincronizado por trigger en las dos direcciones, igual que el par
 *   `status ↔ activo` de `[ID.8]`. Los ~200 archivos que leen `role_name`, el
 *   JWT, `role_scopes` y `PermissionsCacheService` siguen funcionando sin tocar
 *   una línea. Quien quiera la unión pide `getPermissionsForUser`.
 *
 * También agrega dos columnas que el modelo de ERP necesita y no existían:
 *   - `users.kind` — interno | cliente | proveedor | externo | servicio. Hoy no
 *     hay forma de distinguir un empleado de un cliente del portal salvo por su
 *     rol, y menos de una **cuenta de servicio** (los feeds escriben sin
 *     identidad: `created_by` está vacío en los 117 usuarios).
 *   - `users.expires_at` — cuentas con vencimiento (contador/auditor externo).
 *     Sin esto, "acceso temporal" significa acordarse de borrarlo a mano.
 *
 * Aditiva e idempotente. No cambia permisos de nadie: el backfill copia el rol
 * que cada usuario ya tiene. Verificable con
 * `database/tests/test-newdb-user-roles.js`.
 *
 * @param { import("knex").Knex } knex
 */

const KINDS = ['interno', 'cliente', 'proveedor', 'externo', 'servicio'];

exports.up = async function up(knex) {
  // ── 1. users.kind + users.expires_at ──────────────────────────────────────
  const tieneKind = await knex.schema.withSchema('identity').hasColumn('users', 'kind');
  if (!tieneKind) {
    await knex.schema.withSchema('identity').alterTable('users', (t) => {
      t.string('kind', 20).notNullable().defaultTo('interno');
    });
    await knex.raw(`COMMENT ON COLUMN identity.users.kind IS
      '[ID.13] Naturaleza de la cuenta. interno=empleado · cliente=portal B2B · proveedor=portal proveedor · externo=contador/auditor · servicio=feed/cron/bot (sin persona detrás).'`);
  }
  const chkKind = 'users_kind_valido';
  if (!(await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [chkKind])).rows.length) {
    await knex.raw(`
      ALTER TABLE identity.users ADD CONSTRAINT ${chkKind}
        CHECK (kind = ANY (ARRAY['${KINDS.join("','")}']))`);
  }

  if (!(await knex.schema.withSchema('identity').hasColumn('users', 'expires_at'))) {
    await knex.schema.withSchema('identity').alterTable('users', (t) => {
      t.timestamp('expires_at', { useTz: true });
    });
    await knex.raw(`COMMENT ON COLUMN identity.users.expires_at IS
      '[ID.13] Cuenta con vencimiento (auditor/contador externo). NULL = sin vencimiento. Lo hace cumplir el login (auth-mt), no un cron.'`);
  }

  // Backfill de kind. Precedencia: cliente del portal primero (un
  // `customer_b2b` está en department_code='externo', y lo que manda es que
  // tiene un cliente atado), después el resto de externos.
  await knex.raw(`
    UPDATE identity.users
       SET kind = 'cliente'
     WHERE kind = 'interno'
       AND (customer_id IS NOT NULL OR LOWER(role_name) = 'customer_b2b')`);
  await knex.raw(`
    UPDATE identity.users
       SET kind = 'externo'
     WHERE kind = 'interno' AND department_code = 'externo'`);

  // ── 2. identity.user_roles ────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('user_roles'))) {
    await knex.schema.withSchema('identity').createTable('user_roles', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.string('role_name', 100).notNullable();
      // Exactamente uno por usuario. El perfil base viene del puesto; los
      // complementos son tareas (captura_gastos, arqueo_caja, etiquetas…).
      t.boolean('is_primary').notNullable().defaultTo(false);
      t.text('nota'); // por qué se le dio el complemento: por escrito, no de palabra
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'user_id', 'role_name']);
      t.unique(['tenant_id', 'id']);
      t.foreign(['tenant_id', 'user_id'])
        .references(['tenant_id', 'id'])
        .inTable('identity.users')
        .onDelete('CASCADE');
      // Igual que `role_scopes`: si el rol desaparece del catálogo, se va con él.
      t.foreign(['tenant_id', 'role_name'])
        .references(['tenant_id', 'role_name'])
        .inTable('identity.role_permissions')
        .onDelete('CASCADE');
      t.index(['tenant_id', 'role_name']);
    });
    await knex.raw(`COMMENT ON TABLE identity.user_roles IS
      '[ID.13] Roles de un usuario. is_primary = perfil base (espejo de users.role_name, sincronizado por trigger); el resto = complementos. Los permisos efectivos son la UNIÓN.'`);
  }

  // Un solo perfil base por usuario. Índice parcial: los complementos no
  // compiten por la unicidad.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS user_roles_un_primario
      ON identity.user_roles (tenant_id, user_id) WHERE is_primary`);

  // ── 3. RLS forzado + grants (patrón del resto de identity.*) ──────────────
  await knex.raw(`ALTER TABLE identity.user_roles ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE identity.user_roles FORCE ROW LEVEL SECURITY`);
  if (
    !(
      await knex.raw(
        `SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename='user_roles' AND policyname='tenant_isolation'`,
      )
    ).rows.length
  ) {
    await knex.raw(`
      CREATE POLICY tenant_isolation ON identity.user_roles
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
  }
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_roles TO app_runtime`);
  if (
    !(
      await knex.raw(
        `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.user_roles'::regclass AND tgname = 'trg_auto_populate_tenant_id'`,
      )
    ).rows.length
  ) {
    await knex.raw(`
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON identity.user_roles
        FOR EACH ROW EXECUTE FUNCTION auto_populate_tenant_id()`);
  }

  // ── 4. Backfill: el rol actual de cada usuario pasa a ser su perfil base ──
  // El JOIN es por LOWER(): `users.role_name` puede diferir en mayúsculas de
  // `role_permissions.role_name` (data legacy — es la misma razón por la que
  // `PermissionsCacheService` normaliza a minúscula). Se inserta el nombre
  // CANÓNICO del catálogo para que la FK compuesta cierre.
  const ins = await knex.raw(`
    INSERT INTO identity.user_roles (tenant_id, user_id, role_name, is_primary, nota)
    SELECT u.tenant_id, u.id, rp.role_name, TRUE, '[ID.13] backfill del perfil base'
      FROM identity.users u
      JOIN identity.role_permissions rp
        ON rp.tenant_id = u.tenant_id
       AND LOWER(rp.role_name) = LOWER(u.role_name)
       AND rp.deleted_at IS NULL
     WHERE u.deleted_at IS NULL AND u.role_name IS NOT NULL
    ON CONFLICT (tenant_id, user_id, role_name) DO NOTHING`);
  console.log(`  [ID.13] perfiles base migrados a user_roles: ${ins.rowCount}`);

  // Gate de calidad: un usuario cuyo rol NO existe en el catálogo hoy tiene 0
  // permisos efectivos (el lookup no encuentra fila) y nadie lo nota. Se avisa
  // acá, que es donde se puede arreglar.
  const huerf = await knex.raw(`
    SELECT u.username, u.role_name
      FROM identity.users u
     WHERE u.deleted_at IS NULL AND u.role_name IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM identity.role_permissions rp
          WHERE rp.tenant_id = u.tenant_id AND LOWER(rp.role_name) = LOWER(u.role_name))
     ORDER BY 1`);
  if (huerf.rows.length) {
    console.log(`  ⚠ ${huerf.rows.length} usuario(s) con un rol que no está en el catálogo (0 permisos efectivos):`);
    huerf.rows.forEach((r) => console.log(`      ${r.username} → rol "${r.role_name}"`));
  }

  // ── 5. Sincronía bidireccional role_name ↔ perfil base ────────────────────
  // Misma estrategia que `identity.sync_user_status_activo()` de `[ID.8]`: la
  // columna vieja se queda como shim vivo para no romper a los que la leen, y
  // un trigger garantiza que las dos caras nunca se separen. Sin esto, cambiar
  // el rol desde `/admin/usuarios` (que escribe `role_name`) dejaría el perfil
  // base viejo en `user_roles` — y los permisos efectivos serían los de antes.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.sync_primary_role_from_user() RETURNS trigger AS $$
    DECLARE canonico text;
    BEGIN
      IF NEW.role_name IS NULL THEN RETURN NEW; END IF;
      -- Nombre canónico del catálogo (case-insensitive), o NULL si el rol no existe.
      SELECT rp.role_name INTO canonico
        FROM identity.role_permissions rp
       WHERE rp.tenant_id = NEW.tenant_id
         AND LOWER(rp.role_name) = LOWER(NEW.role_name)
         AND rp.deleted_at IS NULL
       LIMIT 1;
      IF canonico IS NULL THEN RETURN NEW; END IF;

      -- El perfil base anterior deja de serlo (si sigue siendo un rol asignado,
      -- se degrada a complemento en vez de borrarse: quitarle un permiso a
      -- alguien tiene que ser una decisión explícita, no un efecto secundario).
      UPDATE identity.user_roles
         SET is_primary = FALSE, updated_at = now()
       WHERE tenant_id = NEW.tenant_id AND user_id = NEW.id
         AND is_primary AND role_name <> canonico;

      INSERT INTO identity.user_roles (tenant_id, user_id, role_name, is_primary, nota)
           VALUES (NEW.tenant_id, NEW.id, canonico, TRUE, '[ID.13] sync desde users.role_name')
      ON CONFLICT (tenant_id, user_id, role_name)
        DO UPDATE SET is_primary = TRUE, updated_at = now();
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);

  // Promover un rol a perfil base tiene que DEGRADAR al anterior, y tiene que
  // pasar ANTES de que Postgres valide `user_roles_un_primario` — o sea en un
  // BEFORE. Sin esto, insertar el perfil base nuevo choca con el viejo y la
  // operación revienta con "llave duplicada" (lo encontró el smoke de `[ID.13]`).
  // Con esto, "cambiale el perfil base" es idempotente: la UI manda el nuevo y
  // el anterior queda como complemento, sin pedirle a nadie que ordene los pasos.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.demote_other_primary_role() RETURNS trigger AS $$
    BEGIN
      IF NEW.is_primary THEN
        UPDATE identity.user_roles
           SET is_primary = FALSE, updated_at = now()
         WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
           AND is_primary AND role_name <> NEW.role_name;
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_un_solo_primario ON identity.user_roles`);
  await knex.raw(`
    CREATE TRIGGER trg_un_solo_primario BEFORE INSERT OR UPDATE OF role_name, is_primary
      ON identity.user_roles
      FOR EACH ROW EXECUTE FUNCTION identity.demote_other_primary_role()`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.sync_user_from_primary_role() RETURNS trigger AS $$
    BEGIN
      IF NOT NEW.is_primary THEN RETURN NEW; END IF;
      -- El IS DISTINCT FROM corta la recursión: el UPDATE de abajo dispara el
      -- trigger de users, que hace un upsert que ya no cambia nada y para acá.
      UPDATE identity.users
         SET role_name = NEW.role_name
       WHERE tenant_id = NEW.tenant_id AND id = NEW.user_id
         AND role_name IS DISTINCT FROM NEW.role_name;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_sync_primary_role ON identity.users`);
  await knex.raw(`
    CREATE TRIGGER trg_sync_primary_role AFTER INSERT OR UPDATE OF role_name ON identity.users
      FOR EACH ROW EXECUTE FUNCTION identity.sync_primary_role_from_user()`);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_sync_user_role_name ON identity.user_roles`);
  await knex.raw(`
    CREATE TRIGGER trg_sync_user_role_name AFTER INSERT OR UPDATE OF role_name, is_primary
      ON identity.user_roles
      FOR EACH ROW EXECUTE FUNCTION identity.sync_user_from_primary_role()`);

  const n = await knex.raw(`
    SELECT count(*) FILTER (WHERE is_primary) base, count(*) FILTER (WHERE NOT is_primary) complementos
      FROM identity.user_roles`);
  console.log(`  [ID.13] user_roles: ${n.rows[0].base} perfiles base · ${n.rows[0].complementos} complementos`);
  const k = await knex.raw(`SELECT kind, count(*) n FROM identity.users WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  k.rows.forEach((r) => console.log(`  [ID.13] kind=${String(r.kind).padEnd(10)} ${r.n}`));
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_un_solo_primario ON identity.user_roles`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.demote_other_primary_role()`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_sync_user_role_name ON identity.user_roles`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_sync_primary_role ON identity.users`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.sync_user_from_primary_role()`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.sync_primary_role_from_user()`);
  await knex.schema.withSchema('identity').dropTableIfExists('user_roles');
  // `kind` y `expires_at` NO se borran en el down: son columnas de datos y la
  // regla del proyecto es no quitar columnas sin autorización explícita.
  console.log('  [ID.13] down: user_roles y triggers eliminados. kind/expires_at se conservan.');
};
