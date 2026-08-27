'use strict';
/**
 * `[ID.8]` — Ciclo de vida del usuario y bitácora de cambios (Fase ID).
 *
 * Dos huecos medidos en prod (117 usuarios) que esto cierra:
 *
 *  1. **No hay ciclo de vida.** `activo = true` en los 117, `deleted_at` en
 *     NINGUNO: nunca se desactivó ni se dio de baja a nadie, incluidas las 9
 *     cuentas POS muertas. Un booleano no distingue "recién creado y sin
 *     estrenar" de "suspendido por vacaciones" de "ya no trabaja acá", y esas
 *     tres cosas se tratan distinto (la última conserva historial, la segunda
 *     vuelve, la primera hay que empujarla a entrar).
 *  2. **No hay rastro de quién cambió qué.** `created_by` está vacío en los 117
 *     — no sabemos quién dio de alta a nadie. Y hay **10 usuarios compartiendo
 *     2 hashes bcrypt** (`[UN.7]`) sin flujo para forzar el cambio.
 *
 * ── Por qué `activo` NO se vuelve GENERATED (todavía) ────────────────────────
 * El patrón probado en `[K-debt]` es `activo BOOLEAN GENERATED ALWAYS AS (...)`,
 * y sería el final correcto acá. Pero Postgres **no permite ALTER de una columna
 * existente a GENERATED**: hay que DROP + ADD, y borrar una columna necesita
 * autorización explícita (regla del proyecto) además de romper los 3 writers que
 * hoy la escriben — dos de ellos **a través de la vista `public.users`**, que
 * quedaría no-actualizable en esa columna.
 *
 * Así que acá va un **shim de transición**: un trigger BIDIRECCIONAL mantiene
 * `status` y `activo` de acuerdo, con `status` como fuente de verdad cuando los
 * dos cambian a la vez. Los 124 archivos que LEEN `activo` siguen andando sin
 * tocarse, y los writers legacy siguen funcionando correctamente mientras se
 * migran de a uno. Cuando ninguno escriba `activo`, se convierte a GENERATED con
 * el OK de Edgar.
 *
 * Aditiva e idempotente. No toca permisos ni alcance. No requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */

const ESTADOS = ['invited', 'active', 'suspended', 'terminated'];

exports.up = async function up(knex) {
  // ── 1. Columnas de ciclo de vida ──────────────────────────────────────────
  const nuevas = [
    ['status', (t) => t.string('status', 20).notNullable().defaultTo('active')],
    ['must_change_password', (t) => t.boolean('must_change_password').notNullable().defaultTo(false)],
    ['password_changed_at', (t) => t.timestamp('password_changed_at', { useTz: true })],
    ['terminated_at', (t) => t.timestamp('terminated_at', { useTz: true })],
  ];
  for (const [col, def] of nuevas) {
    if (!(await knex.schema.withSchema('identity').hasColumn('users', col))) {
      await knex.schema.withSchema('identity').alterTable('users', (t) => def(t));
      console.log(`[users_lifecycle] + identity.users.${col}`);
    }
  }

  await knex.raw(`COMMENT ON COLUMN identity.users.status IS
    'ADR-050 / [ID.8]. invited = creado, nunca entró · active · suspended = baja temporal, vuelve · terminated = ya no trabaja acá (conserva historial). FUENTE DE VERDAD; `+"`activo`"+` se deriva por trigger.'`);
  await knex.raw(`COMMENT ON COLUMN identity.users.must_change_password IS
    'Fuerza cambio de contraseña en el próximo login. Nace true en las altas y en los resets.'`);

  // ── 2. Backfill del estado desde lo que hay ───────────────────────────────
  // Sólo sobre filas que todavía tienen el default, para no pisar un estado ya
  // curado a mano si esta migración se re-corre.
  const bf = await knex.raw(`
    UPDATE identity.users
       SET status = CASE
             WHEN deleted_at IS NOT NULL THEN 'terminated'
             WHEN activo IS TRUE THEN 'active'
             ELSE 'suspended' END,
           terminated_at = CASE WHEN deleted_at IS NOT NULL THEN deleted_at ELSE terminated_at END
     WHERE status = 'active'`);
  console.log(`[users_lifecycle] status backfilleado desde activo/deleted_at: ${bf.rowCount ?? 0} filas`);

  const chk = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'users_status_valido'`);
  if (!chk.rows.length) {
    await knex.raw(`
      ALTER TABLE identity.users
        ADD CONSTRAINT users_status_valido CHECK (status = ANY (ARRAY['${ESTADOS.join("','")}']))`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON identity.users (tenant_id, status)`);

  // ── 3. Shim bidireccional status ↔ activo ─────────────────────────────────
  // Si cambia `status`, se deriva `activo`. Si un writer legacy cambia sólo
  // `activo`, se deriva `status` (conservando 'invited'/'terminated' cuando el
  // booleano no alcanza para distinguirlos). Si cambian los dos, gana `status`.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION identity.sync_user_status_activo() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'active' THEN
          NEW.activo := (NEW.status = 'active');
        ELSE
          NEW.status := CASE WHEN NEW.activo THEN 'active' ELSE 'suspended' END;
        END IF;
        RETURN NEW;
      END IF;

      IF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.activo := (NEW.status = 'active');
      ELSIF NEW.activo IS DISTINCT FROM OLD.activo THEN
        -- Writer legacy: sólo tocó el booleano. 'invited' y 'terminated' no se
        -- pisan — un booleano no puede expresarlos y perderíamos información.
        IF NEW.activo THEN
          NEW.status := 'active';
        ELSIF OLD.status NOT IN ('terminated', 'invited') THEN
          NEW.status := 'suspended';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);

  const trg = await knex.raw(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.users'::regclass AND tgname = 'trg_sync_user_status_activo'`,
  );
  if (!trg.rows.length) {
    await knex.raw(`
      CREATE TRIGGER trg_sync_user_status_activo
        BEFORE INSERT OR UPDATE ON identity.users
        FOR EACH ROW EXECUTE FUNCTION identity.sync_user_status_activo()`);
    console.log('[users_lifecycle] trigger status ↔ activo creado');
  }

  // ── 4. Bitácora de cambios ────────────────────────────────────────────────
  // Lo que hoy no existe: quién dio de alta, quién cambió un rol, quién amplió
  // un alcance. `created_by` está vacío en los 117 usuarios de prod.
  if (!(await knex.schema.withSchema('identity').hasTable('user_events'))) {
    await knex.schema.withSchema('identity').createTable('user_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable(); // a quién le pasó
      t.string('event', 40).notNullable();
      t.jsonb('detalle').notNullable().defaultTo('{}');
      t.uuid('actor_user_id'); // quién lo hizo (NULL = sistema/importer)
      t.string('actor_username', 64);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['tenant_id', 'id']);
      t.foreign(['tenant_id', 'user_id'])
        .references(['tenant_id', 'id'])
        .inTable('identity.users')
        .onDelete('CASCADE');
      t.index(['tenant_id', 'user_id', 'created_at']);
      t.index(['tenant_id', 'event']);
    });
    await knex.raw(`COMMENT ON TABLE identity.user_events IS
      '[ID.8] Bitácora de cambios de usuario: alta, baja, cambio de rol/alcance/contraseña. Append-only; nadie la edita.'`);

    await knex.raw(`ALTER TABLE identity.user_events ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE identity.user_events FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON identity.user_events
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Sin DELETE ni UPDATE para app_runtime: es append-only por diseño.
    await knex.raw(`GRANT SELECT, INSERT ON identity.user_events TO app_runtime`);
    await knex.raw(`
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON identity.user_events
        FOR EACH ROW EXECUTE FUNCTION auto_populate_tenant_id()`);
    console.log('[users_lifecycle] identity.user_events creada (RLS forzado, append-only)');
  }

  // ── 5. `public.users` expone lo nuevo ─────────────────────────────────────
  // Vista PASSTHROUGH con lista explícita, leída por `auth-mt` SIN contexto de
  // tenant: nada de JOINs, y `CREATE OR REPLACE` sólo permite AGREGAR al final.
  const v = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='users' AND column_name='status'`);
  if (!v.rows.length) {
    await knex.raw(`
      CREATE OR REPLACE VIEW public.users AS
        SELECT id, tenant_id, username, password_hash, nombre, zona_id, role_name,
               supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
               updated_by, deleted_at, deleted_by, customer_id, last_login_at,
               last_login_ip, last_login_user_agent, warehouse_code,
               finance_expense_area_ids, department_code, position_code,
               warehouse_id,
               status, must_change_password, password_changed_at, terminated_at
          FROM identity.users`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO app_runtime`);
    console.log('[users_lifecycle] public.users: + status, must_change_password, password_changed_at, terminated_at');
  }

  // ── 6. Foto de lo que quedó ───────────────────────────────────────────────
  const dist = await knex.raw(
    `SELECT status, count(*) n FROM identity.users WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`);
  dist.rows.forEach((r) => console.log(`  status=${String(r.status).padEnd(11)} ${r.n}`));
  const dup = await knex.raw(`
    SELECT count(*) grupos, COALESCE(sum(n), 0) usuarios FROM (
      SELECT count(*) n FROM identity.users WHERE deleted_at IS NULL
       GROUP BY password_hash HAVING count(*) > 1) t`);
  console.log(
    `[users_lifecycle] hashes compartidos: ${dup.rows[0].grupos} grupo(s) / ${dup.rows[0].usuarios} usuarios ` +
      `— marcarlos con must_change_password es decisión de Edgar (no se fuerza acá)`,
  );
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_sync_user_status_activo ON identity.users`);
  await knex.raw(`DROP FUNCTION IF EXISTS identity.sync_user_status_activo()`);
  await knex.schema.withSchema('identity').dropTableIfExists('user_events');
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_status_valido`);
  // Las 4 columnas y las de la vista NO se tiran: son aditivas y borrar columnas
  // pide autorización explícita (regla del proyecto).
  console.log('[users_lifecycle] down: trigger + user_events + CHECK. Columnas conservadas.');
};
