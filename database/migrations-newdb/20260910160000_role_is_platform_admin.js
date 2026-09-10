'use strict';
/**
 * `[ID.33]` — El god-mode deja de vivir SÓLO en un literal, y la deriva entre
 * sus cinco copias pasa a ser detectable.
 *
 * ── Lo que hay hoy, medido ───────────────────────────────────────────────────
 * El god-mode de plataforma es `new Set(['superadmin', 'admin'])`, escrito a
 * mano en **CINCO** lugares:
 *   · `libs/platform-core/.../platform-admin.ts`   (el backend, 16 call sites)
 *   · `libs/trade/.../users.service.ts`            (como `ELEVATED_ROLES`)
 *   · `apps/view` / `apps/vendor` / `apps/portal`  (`PermissionsService.isAdmin`)
 * Y lo único que los mantiene sincronizados es un comentario que dice
 * *«Este listado se espeja en los 3 frontends. Si cambia acá, cambia allá.»* —
 * una instrucción para humanos, sin nada que la haga cumplir.
 *
 * ── Qué hace esta migración, y qué NO ────────────────────────────────────────
 * Agrega `identity.role_permissions.is_platform_admin` y lo **materializa desde
 * el comportamiento en vigor** (no desde una idea nueva): `true` exactamente
 * para los roles que el literal ya trata como god-mode.
 *
 * ⚠️ **Todavía NO es la fuente en runtime.** `isPlatformAdminRole(roleName)` es
 * una función SÍNCRONA con 16 call sites, y varios están en gateways de
 * WebSocket que sólo tienen el `role_name` del handshake — sin conexión a DB y
 * sin request. Cambiarla a lectura de base exige un cargador con TTL como
 * `PermissionsCacheService`, y eso es un refactor de autorización que no se hace
 * a ciegas: se declara y se hace aparte.
 *
 * Lo que SÍ cambia hoy: la columna es el ancla contra la que el smoke
 * `test-newdb-role-rename` compara las cinco copias. La deriva deja de ser
 * invisible — que es el modo de falla real, porque el día que un tenant llame
 * `admin` a un rol suyo, hereda god-mode en los 5 lugares a la vez y nadie se
 * entera.
 *
 * A nivel producto y no por tenant: quién es operador de plataforma es una
 * propiedad del rol como concepto. Pero la columna vive en `role_permissions`,
 * que **sí** es por tenant — o sea que un tenant podría marcar el suyo. Es
 * deliberado: es justamente lo que el literal no puede expresar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** El literal en vigor, materializado. No se agrega ni se quita nadie acá. */
const GOD_MODE = ['superadmin', 'admin'];

exports.up = async function up(knex) {
  // ⚠️ `lock_timeout` ANTES de cualquier DDL sobre esta tabla, y no es teórico:
  // el primer intento de esta misma migración **encoló 11 sesiones de
  // producción** detrás suyo. `ADD COLUMN` toma ACCESS EXCLUSIVE; el lock no se
  // pudo conceder porque una `COPY kepler_ods.kdmx_26 TO stdout` de un feed
  // llevaba 12 minutos abierta, y desde ese momento **toda lectura de
  // `role_permissions` quedó atrás en la cola** — o sea el lookup de permisos
  // que la API hace en cada request. Se canceló a mano y la transacción revirtió
  // limpia (0 filas tocadas, sin registro en `knex_migrations`).
  //
  // Con 3 s, si el lock no está libre la migración **falla rápido** en vez de
  // convertirse en un incidente. Reintentar es barato; bloquear el login no.
  // El proyecto ya conocía la trampa —`[LC]` la documenta para
  // `gl_poliza_lines`— y acá no se había aplicado.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const existe = await knex.schema.withSchema('identity').hasColumn('role_permissions', 'is_platform_admin');
  if (!existe) {
    await knex.schema.withSchema('identity').alterTable('role_permissions', (t) => {
      t.boolean('is_platform_admin').notNullable().defaultTo(false);
    });
    console.log('  columna is_platform_admin agregada');
  } else {
    console.log('  columna is_platform_admin ya existía');
  }

  const COMENTARIO = [
    'Este rol es OPERADOR DE PLATAFORMA: pasa todos los gates de permiso.',
    '[ID.33] Materializa el literal new Set([superadmin, admin]) que estaba escrito a mano en CINCO',
    'lugares (platform-core, users.service como ELEVATED_ROLES, y los 3 frontends), sincronizados',
    'unicamente por un comentario. ⚠️ TODAVIA NO es la fuente en runtime: isPlatformAdminRole() es',
    'sincrona y tiene 16 call sites, varios en gateways de WebSocket sin conexion a DB. Hoy la columna',
    'es el ancla contra la que el smoke compara las copias, para que la deriva deje de ser invisible.',
  ].join(' ');
  await knex.raw(`COMMENT ON COLUMN identity.role_permissions.is_platform_admin IS '${COMENTARIO}'`);

  const on = await knex.raw(
    `UPDATE identity.role_permissions SET is_platform_admin = true, updated_at = now()
      WHERE lower(role_name) = ANY(?) AND is_platform_admin = false`,
    [GOD_MODE],
  );
  const off = await knex.raw(
    `UPDATE identity.role_permissions SET is_platform_admin = false, updated_at = now()
      WHERE NOT (lower(role_name) = ANY(?)) AND is_platform_admin = true`,
    [GOD_MODE],
  );
  console.log(`  marcados: ${on.rowCount} · desmarcados: ${off.rowCount}`);

  // ── Compuertas ─────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(
    `SELECT
       (SELECT count(*)::int FROM identity.role_permissions
         WHERE is_platform_admin AND deleted_at IS NULL) AS marcados_vivos,
       (SELECT count(*)::int FROM identity.role_permissions
         WHERE is_platform_admin AND NOT (lower(role_name) = ANY(?))) AS de_mas,
       (SELECT count(*)::int FROM identity.role_permissions
         WHERE NOT is_platform_admin AND lower(role_name) = ANY(?) AND deleted_at IS NULL) AS de_menos,
       (SELECT count(*)::int FROM identity.users u
          JOIN identity.role_permissions rp
            ON rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name
         WHERE rp.is_platform_admin AND u.activo AND u.deleted_at IS NULL) AS personas_con_godmode`,
    [GOD_MODE, GOD_MODE],
  );
  const g = rows[0];
  const fallas = [];
  if (g.de_mas !== 0) fallas.push(`${g.de_mas} rol(es) marcados que el literal NO considera god-mode`);
  if (g.de_menos !== 0) fallas.push(`${g.de_menos} rol(es) del literal quedaron sin marcar`);
  // Si nadie queda con god-mode, algo salió mal: hay 9 superadmin en prod.
  if (g.personas_con_godmode === 0) {
    fallas.push('ninguna persona activa quedó con god-mode: el backfill no puede haber sido correcto');
  }
  if (fallas.length) throw new Error(`Compuertas de [ID.33]: ${fallas.join(' · ')}`);

  console.log(
    `  ✓ ${g.marcados_vivos} rol(es) vivos marcados como operador de plataforma · ` +
      `${g.personas_con_godmode} persona(s) activa(s) lo heredan · la columna coincide con el literal`,
  );
};

exports.down = async function down(knex) {
  const existe = await knex.schema.withSchema('identity').hasColumn('role_permissions', 'is_platform_admin');
  if (existe) {
    await knex.schema.withSchema('identity').alterTable('role_permissions', (t) => {
      t.dropColumn('is_platform_admin');
    });
  }
  console.log('  Revertido: el god-mode vuelve a vivir sólo en cinco literales sin candado.');
};
