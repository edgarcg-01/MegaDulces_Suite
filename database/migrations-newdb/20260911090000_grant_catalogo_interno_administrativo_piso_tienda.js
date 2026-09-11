/**
 * CV.25 — Reparte `CATALOGO_INTERNO_VER` / `_COSTOS_VER` a los roles reales.
 *
 * Mismo problema que ya documentó `20260902140000` (LC.6.2): el módulo
 * `catalogo-interno` (PR #83) declaró el par de permisos en el enum +
 * `authz-tree`, pero sin esta migración **nadie en prod puede abrir el
 * módulo** — sólo `superadmin`/`admin` entrarían por `ALL_PERMS`.
 *
 * A quién, decidido directo con el usuario (no derivado de un hermano, no
 * hay un permiso similar ya repartido que copiar):
 *   - `administrativo` (25 personas activas, incluye a Felipe Galván) —
 *     VER + COSTOS_VER.
 *   - `piso_tienda` (1 persona activa hoy, Rodrigo Ortiz) — VER + COSTOS_VER.
 *
 * OJO para quien retome esto: `administrativo` es un rol compartido por 25
 * personas, no exclusivo de Felipe. Si en algún momento se decide que el
 * costo/margen no debería verlo todo ese grupo, la corrección es un
 * `identity.user_permissions` override NEGATIVO para las personas que no
 * deban verlo (`allow: false` en `CATALOGO_INTERNO_COSTOS_VER`), no revertir
 * esta migración — un rollback de esquema no debería apagarle el módulo a
 * los otros 24.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (no el operador `?` de JSONB,
 * que knex no escapa bien) — sólo agrega donde la clave falta, no pisa un
 * `false` puesto a mano desde `/admin/roles`.
 *
 * Después de aplicarla, Felipe y Rodrigo tienen que volver a entrar: los
 * permisos viajan en el JWT y el token ya emitido no los trae.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"CATALOGO_INTERNO_VER": true}'::jsonb
      WHERE role_name = ANY(?)
        AND permissions -> 'CATALOGO_INTERNO_VER' IS NULL`,
    [['administrativo', 'piso_tienda']],
  );

  const costos = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || '{"CATALOGO_INTERNO_COSTOS_VER": true}'::jsonb
      WHERE role_name = ANY(?)
        AND permissions -> 'CATALOGO_INTERNO_COSTOS_VER' IS NULL`,
    [['administrativo', 'piso_tienda']],
  );

  console.log(
    `[grant_catalogo_interno_administrativo_piso_tienda] VER → ${ver.rowCount ?? 0} fila(s) de rol · `
    + `COSTOS_VER → ${costos.rowCount ?? 0}. Felipe y Rodrigo deben volver a entrar (el JWT trae los permisos).`,
  );
};

/**
 * No-op, igual que el resto de los backfills de permisos del repo: revocar
 * por rollback de esquema apagaría el módulo para los 26, no sólo para quien
 * se equivocó de asignación. Para quitarlo, hacerlo desde /admin/roles.
 */
exports.down = async function () {
  console.log('[grant_catalogo_interno_administrativo_piso_tienda] down: no-op');
};
