/**
 * [SM.47] Reparte `STORE_ARQUEO_SIN_CAJA_CAPTURAR` («Conteo de efectivo»).
 *
 * Un modulo no esta entregado hasta que su clave esta en `role_permissions`
 * (regla 20). Pedido: «encargados de sucursal, area de finanzas, jefes de zona».
 *
 * ── A quien, medido en prod el 2026-10-22 (solo lectura)
 *
 *  - `encargado_tienda` (10 activos). Ya tiene `STORE_ARQUEO_VER`.
 *  - `finanzas` (1), `finanzas_operativo` (7) y `tesoreria` (1). NINGUNO tiene
 *    `STORE_ARQUEO_*`; `finanzas` y `tesoreria` lo tienen en `false` a proposito.
 *    ⚠️ NO se les da `STORE_ARQUEO_VER`: pisar un `false` es decision de quien lo
 *    puso. Con la clave nueva entran a la pantalla (guard de la ruta) y el listado
 *    les muestra SOLO sus conteos del dia (`@RequireAnyPermission` en `GET /`).
 *  - ⚠️ «Jefe de zona» NO existe como rol: el puesto lo ocupan 3 `superadmin`
 *    (que ya pasan por `ALL_PERMS`) y 1 `encargado_tienda` (incluido arriba). Si
 *    se decide un rol (p. ej. `supervisor_ventas`), se suma desde `/admin/roles`.
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?`
 * de JSONB). Si alguien ya la puso en `false` a mano, no se le pisa.
 *
 * Despues de aplicarla, las personas tienen que volver a entrar: los permisos
 * viajan dentro del JWT.
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'STORE_ARQUEO_SIN_CAJA_CAPTURAR';
const ROLES_CAPTURA = ['encargado_tienda', 'finanzas', 'finanzas_operativo', 'tesoreria'];

const otorga = async (knex, key, roles) => {
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?)
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> ?::text IS NULL`,
    [key, roles, key],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb
      ORDER BY role_name`,
    [roles, key],
  );
  const con = rows.map((r) => r.role_name);
  const faltan = roles.filter((r) => !con.includes(r));
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quien quedo sin la clave.
  console.log(
    `[grant_arqueo_sin_caja] ${key}: ${res.rowCount ?? 0} fila(s) · con la clave: [${con.join(', ') || 'NINGUNO'}]`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
};

exports.up = async function up(knex) {
  await otorga(knex, KEY, ROLES_CAPTURA);
  console.log('[grant_arqueo_sin_caja] Las personas afectadas deben volver a entrar (el JWT trae los permisos).');
};

/** No-op, como el resto de los backfills de permisos: se quita desde `/admin/roles`. */
exports.down = async function down() {
  console.log('[grant_arqueo_sin_caja] down: no-op');
};
