'use strict';
/**
 * `[ID.1]` — Schema del ALCANCE de datos (Fase ID / ADR-050).
 *
 * El permiso dice QUÉ ACCIÓN (`role_permissions` JSONB, no se toca acá); el
 * alcance dice SOBRE QUÉ FILAS. Hoy el alcance vive en 6 mecanismos dispersos
 * (`users.warehouse_code`, `warehouse_id`, `zona_id`, `finance_expense_area_ids`,
 * `customer_id`, `commercial.promoter_brands`) y se aplica a mano en cada
 * controller, con la convención "vacío = ve todas" — o sea fail-OPEN.
 *
 * Esta migración solo CREA las tablas. **No cambia el comportamiento de nada**:
 * la materialización del estado actual va en `[ID.3]` y el primer dominio que
 * las consume en `[ID.4]`. Se despliega inerte a propósito.
 *
 * Diseño:
 *   - `role_scopes` = default por rol · `user_scopes` = override por usuario.
 *     Resolución user → role → `none`. Con 33 roles y 117 usuarios, configurar
 *     solo por usuario garantiza que quede mal.
 *   - `mode`: `none` (default si no hay fila) · `own` (el valor de la ficha del
 *     usuario, así no se repite en cada renglón) · `listed` (`values[]`) · `all`.
 *   - `mode_write` NULL = hereda `mode`. Va desde el día 1 aunque se aplique
 *     después: es lo que permite "ve las 3 sucursales de su zona, captura solo
 *     en la suya", y agregarlo luego obliga a re-migrar.
 *   - `values` es `text[]`, NO uuid[]: las dimensiones no comparten tipo de
 *     llave (`warehouse` es code '03', `zone`/`brand`/`customer` son uuid). El
 *     tipo real de cada una vive en `scope_dimensions.ref_key`.
 *
 * Sin FK a los valores de `values[]` (Postgres no soporta FK de array). La
 * validación de existencia es del `ScopeService` de `[ID.2]`, igual que
 * `assertOrgCodes` valida `department_code` para devolver 400 y no 500.
 *
 * Aditiva e idempotente. No toca permisos. No requiere re-login (el alcance NO
 * viaja en el JWT — ver ADR-050 punto 6).
 *
 * @param { import("knex").Knex } knex
 */

const DIMENSIONS = [
  // [code, label, ref_table, ref_key, orden, soporta_own]
  ['warehouse', 'Sucursal / almacén', 'commercial.warehouses', 'code', 10, true],
  ['zone', 'Zona', 'trade.zones', 'id', 20, true],
  ['route', 'Ruta', 'trade.catalogs', 'id', 30, false],
  ['brand', 'Marca', 'catalog.brands', 'id', 40, false],
  ['expense_area', 'Área de gasto', 'finance.expense_areas', 'id', 50, false],
  ['customer', 'Cliente', 'commercial.customers', 'id', 60, true],
];

const MODES = ['none', 'own', 'listed', 'all'];

exports.up = async function up(knex) {
  // ── 1. Catálogo de dimensiones ────────────────────────────────────────────
  // Sin tenant_id: es catálogo de plataforma, no dato de negocio. Agregar una
  // dimensión nueva es un INSERT, no código.
  if (!(await knex.schema.withSchema('identity').hasTable('scope_dimensions'))) {
    await knex.schema.withSchema('identity').createTable('scope_dimensions', (t) => {
      t.string('code', 40).primary();
      t.string('label', 120).notNullable();
      t.string('ref_table', 120).notNullable();
      t.string('ref_key', 40).notNullable();
      t.integer('orden').notNullable().defaultTo(100);
      t.boolean('supports_own').notNullable().defaultTo(false);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
    await knex.raw(`COMMENT ON TABLE identity.scope_dimensions IS
      'ADR-050. Dimensiones de alcance de datos. supports_own = si mode=own tiene sentido (hay columna en users.*).'`);
  }
  for (const [code, label, refTable, refKey, orden, own] of DIMENSIONS) {
    await knex.raw(
      `INSERT INTO identity.scope_dimensions (code, label, ref_table, ref_key, orden, supports_own)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING`,
      [code, label, refTable, refKey, orden, own],
    );
  }

  // ── 2. Default por ROL ────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('role_scopes'))) {
    await knex.schema.withSchema('identity').createTable('role_scopes', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('role_name', 100).notNullable();
      t.string('dimension', 40).notNullable();
      t.string('mode', 10).notNullable();
      t.specificType('values', 'text[]');
      t.string('mode_write', 10); // NULL = hereda `mode`
      t.text('nota');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'role_name', 'dimension']);
      t.unique(['tenant_id', 'id']); // para FK compuesta desde otras tablas
      t.foreign('dimension').references('code').inTable('identity.scope_dimensions').onDelete('RESTRICT');
      t.foreign(['tenant_id', 'role_name'])
        .references(['tenant_id', 'role_name'])
        .inTable('identity.role_permissions')
        .onDelete('CASCADE'); // si el rol se va, su alcance se va con él
      t.index(['tenant_id', 'dimension']);
    });
  }

  // ── 3. Override por USUARIO ───────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasTable('user_scopes'))) {
    await knex.schema.withSchema('identity').createTable('user_scopes', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.string('dimension', 40).notNullable();
      t.string('mode', 10).notNullable();
      t.specificType('values', 'text[]');
      t.string('mode_write', 10);
      t.text('nota'); // por qué se le dio de más: queda por escrito, no de palabra
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'user_id', 'dimension']);
      t.unique(['tenant_id', 'id']);
      t.foreign('dimension').references('code').inTable('identity.scope_dimensions').onDelete('RESTRICT');
      t.foreign(['tenant_id', 'user_id'])
        .references(['tenant_id', 'id'])
        .inTable('identity.users')
        .onDelete('CASCADE');
      t.index(['tenant_id', 'dimension']);
    });
  }

  // ── 4. CHECKs de dominio ──────────────────────────────────────────────────
  // `mode='listed'` sin valores es una trampa: se lee como "restringido" y
  // funciona como "no ve nada". Se rechaza en la DB, no en el service.
  //
  // `cardinality()` y NO `array_length(values, 1) > 0`: para un array VACÍO
  // `array_length` devuelve NULL, `NULL > 0` es NULL, y un CHECK solo rechaza
  // cuando da FALSE — así que `values = '{}'` se colaba. `cardinality('{}')` = 0.
  for (const tabla of ['role_scopes', 'user_scopes']) {
    const chk = `${tabla}_mode_valido`;
    const has = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ?`, [chk]);
    if (!has.rows.length) {
      await knex.raw(`
        ALTER TABLE identity.${tabla}
          ADD CONSTRAINT ${chk} CHECK (
            mode = ANY (ARRAY['${MODES.join("','")}'])
            AND (mode_write IS NULL OR mode_write = ANY (ARRAY['${MODES.join("','")}']))
            AND (mode <> 'listed' OR (values IS NOT NULL AND cardinality(values) > 0))
            AND (mode_write IS DISTINCT FROM 'listed' OR (values IS NOT NULL AND cardinality(values) > 0))
          )`);
    }
  }

  // ── 5. RLS forzado (patrón de todas las tablas de negocio) ────────────────
  for (const tabla of ['role_scopes', 'user_scopes']) {
    await knex.raw(`ALTER TABLE identity.${tabla} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE identity.${tabla} FORCE ROW LEVEL SECURITY`);
    const pol = await knex.raw(`SELECT 1 FROM pg_policies WHERE schemaname='identity' AND tablename=? AND policyname='tenant_isolation'`, [tabla]);
    if (!pol.rows.length) {
      await knex.raw(`
        CREATE POLICY tenant_isolation ON identity.${tabla}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id())`);
    }
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON identity.${tabla} TO app_runtime`);
    // Mismo trigger que el resto: rellena tenant_id desde current_tenant_id().
    const trg = await knex.raw(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = ?::regclass AND tgname = 'trg_auto_populate_tenant_id'`,
      [`identity.${tabla}`],
    );
    if (!trg.rows.length) {
      await knex.raw(`
        CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON identity.${tabla}
          FOR EACH ROW EXECUTE FUNCTION auto_populate_tenant_id()`);
    }
  }
  await knex.raw(`GRANT SELECT ON identity.scope_dimensions TO app_runtime`);

  // ── 6. Qué es "una sucursal" para el alcance ──────────────────────────────
  // `commercial.warehouses.kind` YA EXISTE con vocabulario `central | truck`
  // (comment de la columna), así que NO se inventa uno nuevo. Pero `central` no
  // alcanza como filtro de la dimensión: en prod son 9 e incluye `MD-30`/`MD-32`
  // (almacenes de Morelia sin código Kepler) además de las 7 sucursales.
  //
  // El universo de la dimensión `warehouse` es **el código de 2 dígitos**, que
  // es exactamente lo que `users.warehouse_code` puede contener (el DTO valida
  // `^[0-9]{2}$`) y lo que Kepler usa como sucursal ('00'..'06'). Queda escrito
  // en el catálogo para que el resolver y el picker no vuelvan a discrepar.
  await knex.raw(
    `UPDATE identity.scope_dimensions
        SET ref_key = 'code'
      WHERE code = 'warehouse'`,
  );
  const inv = await knex.raw(`
    SELECT kind, count(*) FILTER (WHERE code ~ '^[0-9]{2}$') sucursales, count(*) total
      FROM commercial.warehouses WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 3 DESC`);
  inv.rows.forEach((r) => console.log(`  kind=${String(r.kind).padEnd(8)} total=${r.total} de las cuales sucursales(2 díg)=${r.sucursales}`));

  // Gate de calidad: un `warehouse_code` que no exista como sucursal viva
  // significa que ese usuario, al aplicarse el alcance, no verá NADA. Se avisa
  // ahora (en `[ID.1]`, inerte) y no cuando reviente en `[ID.4]`.
  const huerf = await knex.raw(`
    SELECT u.username, u.warehouse_code
      FROM identity.users u
     WHERE u.deleted_at IS NULL AND u.warehouse_code IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM commercial.warehouses w
          WHERE w.tenant_id = u.tenant_id AND w.deleted_at IS NULL
            AND w.code = u.warehouse_code AND w.code ~ '^[0-9]{2}$')
     ORDER BY 1`);
  if (huerf.rows.length) {
    console.log(`  ⚠ ${huerf.rows.length} usuario(s) con warehouse_code que NO es una sucursal viva:`);
    huerf.rows.forEach((r) => console.log(`      ${r.username} → '${r.warehouse_code}'`));
  } else {
    console.log('  ✓ todos los warehouse_code apuntan a una sucursal viva');
  }

  // ── 7. `public.users` le faltaba `warehouse_id` ───────────────────────────
  // La vista se agregó antes que la columna y nunca se actualizó, así que los
  // servicios legacy que leen por la vista no ven la sucursal en uuid. Es una
  // vista PASSTHROUGH con lista explícita de columnas y la lee `auth-mt` SIN
  // contexto de tenant: nada de JOINs acá, y `CREATE OR REPLACE` solo permite
  // AGREGAR columnas al final.
  const v = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='users' AND column_name='warehouse_id'`,
  );
  if (!v.rows.length) {
    await knex.raw(`
      CREATE OR REPLACE VIEW public.users AS
        SELECT id, tenant_id, username, password_hash, nombre, zona_id, role_name,
               supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
               updated_by, deleted_at, deleted_by, customer_id, last_login_at,
               last_login_ip, last_login_user_agent, warehouse_code,
               finance_expense_area_ids, department_code, position_code,
               warehouse_id
          FROM identity.users`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO app_runtime`);
    console.log('[id_scopes] public.users: + warehouse_id');
  }

  const n = await knex.raw(`SELECT count(*) c FROM identity.scope_dimensions`);
  console.log(`[id_scopes] listo — ${n.rows[0].c} dimensiones, role_scopes/user_scopes vacías (materializa [ID.3])`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.schema.withSchema('identity').dropTableIfExists('user_scopes');
  await knex.schema.withSchema('identity').dropTableIfExists('role_scopes');
  await knex.schema.withSchema('identity').dropTableIfExists('scope_dimensions');
  // La columna nueva de la vista `public.users` NO se revierte: es aditiva y
  // correcta por sí misma; tirarla rompería a quien ya la lea.
};
