/**
 * `[ID.21]` — Permisos POR USUARIO, encima del estándar del puesto.
 *
 * Lo que faltaba: el permiso sólo existía a nivel rol. Dos personas con el mismo
 * puesto tenían forzosamente el mismo acceso, así que cada excepción real ("la
 * encargada de Zamora sí ve costos, las otras no") terminaba en una de tres
 * salidas malas: inflar el rol de todos, clonar el rol para una persona, o darle
 * una segunda cuenta. El catálogo de 30 perfiles se llenó de roles-de-una-persona
 * justamente por eso.
 *
 * Modelo (el de Postgres / AD / IAM, no inventamos otro):
 *
 *     efectivos = unión(perfil base + complementos)  ±  overrides del usuario
 *
 * El rol sigue siendo **el estándar del puesto**: se edita una vez y aplica a los
 * 20 que lo tienen. Esta tabla guarda sólo la DIFERENCIA de cada persona contra
 * ese estándar — `allow = true` es "de más", `allow = false` es "menos". Guardar
 * la diferencia y no el conjunto completo es lo que hace la pantalla legible: se
 * puede decir "tiene 2 permisos de más que su puesto" en vez de comparar 162
 * casillas contra las de un compañero.
 *
 * Precedencia: el override del usuario gana sobre el rol. Es la única que tiene
 * sentido — al revés el override no serviría de nada.
 *
 * OJO con `superadmin`: `buildAbility` le da `manage:all` y el guard corta ahí,
 * antes de mirar el mapa de permisos. Un `allow = false` sobre un rol de
 * plataforma sería decorativo, así que el service lo RECHAZA en vez de guardarlo
 * y dejar a alguien creyendo que revocó algo (ver `setPermissions`).
 *
 * Ver ADR-050: el permiso dice QUÉ ACCIÓN, el alcance (`identity.user_scopes`)
 * dice SOBRE QUÉ FILAS. Esta tabla es del primer eje; espeja a propósito la
 * forma de `user_scopes` (misma nota, mismo audit, misma invalidación).
 */

exports.up = async (knex) => {
  const existe = await knex.schema.withSchema('identity').hasTable('user_permissions');
  if (!existe) {
    await knex.schema.withSchema('identity').createTable('user_permissions', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      // Clave del enum `Permission` (p.ej. FINANCE_EXPENSES_VER_ALL).
      t.string('permission_key', 80).notNullable();
      // true = concedido de más · false = quitado de lo que el puesto le daba.
      t.boolean('allow').notNullable();
      // Por qué. El alcance ya tenía esta columna y resultó ser la que se lee
      // seis meses después, cuando nadie se acuerda del caso.
      t.text('nota');
      t.uuid('granted_by');
      t.string('granted_by_username', 60);
      t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'user_id', 'permission_key']);
      t.foreign(['tenant_id', 'user_id'])
        .references(['tenant_id', 'id'])
        .inTable('identity.users')
        .onDelete('CASCADE');
    });

    // Sólo claves con forma de permiso. Sin esto la tabla acepta cualquier
    // string y el override queda mudo: nunca coincide con ninguna clave real.
    await knex.raw(`
      ALTER TABLE identity.user_permissions
        ADD CONSTRAINT user_permissions_key_forma
        CHECK (permission_key ~ '^[A-Z][A-Z0-9_]*$')`);

    // "¿Quién trae este permiso por excepción?" — la pregunta de auditoría.
    await knex.raw(`
      CREATE INDEX user_permissions_por_clave
        ON identity.user_permissions (tenant_id, permission_key, allow)`);
  }

  // ── RLS forzado + grants (patrón del resto de identity.*) ─────────────────
  await knex.raw(`ALTER TABLE identity.user_permissions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE identity.user_permissions FORCE ROW LEVEL SECURITY`);
  if (
    !(
      await knex.raw(
        `SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename='user_permissions' AND policyname='tenant_isolation'`,
      )
    ).rows.length
  ) {
    await knex.raw(`
      CREATE POLICY tenant_isolation ON identity.user_permissions
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
  }
  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON identity.user_permissions TO app_runtime`,
  );
  if (
    !(
      await knex.raw(
        `SELECT 1 FROM pg_trigger WHERE tgrelid = 'identity.user_permissions'::regclass AND tgname = 'trg_auto_populate_tenant_id'`,
      )
    ).rows.length
  ) {
    await knex.raw(`
      CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON identity.user_permissions
        FOR EACH ROW EXECUTE FUNCTION auto_populate_tenant_id()`);
  }

  await knex.raw(`
    COMMENT ON TABLE identity.user_permissions IS
      '[ID.21] Diferencia de permisos de una persona contra el estandar de su puesto. allow=true concede de mas, allow=false quita. Gana sobre el rol.'`);

  // Sin backfill a propósito: hoy nadie tiene excepciones registradas porque no
  // se podían registrar. Arrancar en cero es la lectura correcta — cada fila que
  // aparezca acá de ahora en más es una decisión que alguien tomó y firmó.
};

exports.down = async (knex) => {
  await knex.schema.withSchema('identity').dropTableIfExists('user_permissions');
};
