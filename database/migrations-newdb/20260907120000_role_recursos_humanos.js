'use strict';
/**
 * `[IDG.8]` — Un rol de RH, para que el padrón no dependa de 9 personas de Sistemas.
 *
 * Medido en prod (2026-09-05, después de retirar los `retirado_*`):
 * `USUARIOS_GESTIONAR` y `USUARIOS_PASSWORDS` los concede **sólo `superadmin`**
 * — 9 cuentas, todas del departamento `sistemas`. Cada alta, cada baja y cada
 * reseteo de contraseña de las 120 cuentas del padrón pasa por ahí. El único rol
 * que además los tenía era `retirado_rh`, sin gente (y ya vaciado).
 *
 * Consecuencia observada: **41 de 123 cuentas nunca entraron** y **cero** están
 * en `suspended`/`terminated`. Las bajas de personal no llegan al padrón porque
 * quien conoce las bajas no puede aplicarlas.
 *
 * ── Por qué es seguro dar `USUARIOS_GESTIONAR` fuera de Sistemas ─────────────
 * Ese permiso habilita también `setRoles` (complementos), `setPermissions`
 * (overrides por persona) y `setScope`, que en principio serían una vía de
 * escalada. Los frenos de `[AUTHZ-HARD.0]` en `UsersService` ya la cierran, y se
 * revisaron uno por uno antes de crear este rol:
 *   (a) `superadmin`/`admin` sólo los asigna un superadmin (`assertCanAssignRole`);
 *   (b) nadie se edita sus propios roles, permisos ni alcance;
 *   (c) **techo**: no se puede otorgar un rol cuyo mapa tenga claves que el que
 *       otorga NO tiene.
 * Por (c), un RH cuyo mapa son cuatro claves `USUARIOS_*` no puede conceder nada
 * más que esas cuatro. El techo es lo que hace que este rol no sea un god-mode
 * de segunda.
 *
 * ── Qué NO lleva ─────────────────────────────────────────────────────────────
 * `ROLES_CONFIGURAR` queda fuera a propósito: editar el mapa de permisos de un
 * rol es cambiar el modelo de autorización, no administrar personal. `ROLES_VER`
 * sí, porque para asignar un puesto hay que poder ver el catálogo de roles.
 *
 * ── El alcance hay que escribirlo ────────────────────────────────────────────
 * `ScopeService` es fail-CLOSED: sin filas en `role_scopes` el rol resuelve
 * `none` en las 6 dimensiones y no ve NADA — el modo de fallar más confuso que
 * hay (permisos correctos, pantallas vacías). Se escriben las 6 explícitas:
 *   · `warehouse` / `zone` / `route` = `all` — RH administra a toda la empresa, y
 *     los selectores de sucursal, zona y ruta del alta tienen que ofrecer todo.
 *   · `brand` / `customer` / `expense_area` = `none` — no son asunto de RH.
 *
 * Nadie queda asignado a este rol: eso lo hace un superadmin desde
 * `/admin/usuarios`, que es donde el dato operativo se administra.
 *
 * Idempotente (UPSERT por `(tenant_id, role_name)` y por dimensión).
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'recursos_humanos';

/** Las cuatro claves de personal, más la lectura del catálogo de roles. */
const PERMISOS = {
  USUARIOS_VER: true,
  USUARIOS_GESTIONAR: true,
  USUARIOS_PASSWORDS: true,
  USUARIOS_ASIGNAR_RUTA: true,
  ROLES_VER: true,
};

/** `all` donde RH necesita ver a toda la empresa; `none` en lo que no le toca. */
const ALCANCE = {
  warehouse: 'all',
  zone: 'all',
  route: 'all',
  brand: 'none',
  customer: 'none',
  expense_area: 'none',
};

exports.up = async function up(knex) {
  const { rows: tenants } = await knex.raw(
    'SELECT id, slug FROM identity.tenants WHERE activo IS NOT FALSE ORDER BY slug',
  );
  if (!tenants.length) {
    console.log('  No hay tenants activos — nada que hacer.');
    return;
  }

  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions, kind)
       VALUES (?, ?, ?::jsonb, 'perfil')
       ON CONFLICT (tenant_id, role_name)
       DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()`,
      [t.id, ROL, JSON.stringify(PERMISOS)],
    );

    for (const [dimension, mode] of Object.entries(ALCANCE)) {
      await knex.raw(
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, mode, nota)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, role_name, dimension)
         DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
        [
          t.id,
          ROL,
          dimension,
          mode,
          '[IDG.8] alcance explícito: ScopeService es fail-closed y sin fila el rol no ve nada.',
        ],
      );
    }
    console.log(`  ✓ ${t.slug}: rol "${ROL}" con ${Object.keys(PERMISOS).length} permisos y 6 dimensiones de alcance.`);
  }

  // ── Gate: que el rol quede realmente utilizable ───────────────────────────
  const { rows: chk } = await knex.raw(
    `SELECT count(*)::int roles,
            (SELECT count(*)::int FROM identity.role_scopes WHERE role_name = ?) reglas
       FROM identity.role_permissions
      WHERE role_name = ?
        AND permissions->>'USUARIOS_GESTIONAR' = 'true'`,
    [ROL, ROL],
  );
  if (chk[0].roles !== tenants.length || chk[0].reglas !== tenants.length * 6) {
    throw new Error(
      `Quedó a medias: ${chk[0].roles}/${tenants.length} roles y ${chk[0].reglas}/${tenants.length * 6} reglas de alcance.`,
    );
  }
  console.log(
    `  Nadie está asignado todavía — la asignación se hace desde /admin/usuarios, no por migración.`,
  );
};

exports.down = async function down(knex) {
  // El orden importa: `role_scopes` tiene FK compuesta a `role_permissions`.
  await knex.raw('DELETE FROM identity.role_scopes WHERE role_name = ?', [ROL]);
  await knex.raw('DELETE FROM identity.role_permissions WHERE role_name = ?', [ROL]);
  console.log(`  Rol "${ROL}" retirado. Si alguien lo tenía asignado, la FK RESTRICT lo impide.`);
};
