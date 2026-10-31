'use strict';
/**
 * `[CGA-A.65]` — Reparte `FINANCE_HOJA_GASTOS_CERRAR` a Caja General (`finanzas`): una sola firma.
 *
 * Edgar, 2026-10-30, al rearmar el plan de mejora («evitemos reprocesos»): la hoja la ARMA Caja
 * General (tiene el papel y el retiro), la APRUEBA tesorería —la única firma— y la PAGA Caja General.
 * El servidor ya cuida los cuatro ojos: quien aprueba no es quien cierra ni quien paga.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ────────────────────────────────────────
 *  · `FINANCE_HOJA_GASTOS_CERRAR` no la tiene NINGÚN rol: HG-1 la cerró superadmin. Sin esto, las
 *    hojas en papel de octubre (99 pagos de Morelia del 12 al 28/10 por ligar a su retiro) sólo las
 *    podría registrar superadmin.
 *  · `FINANCE_EXPENSES_COMPROBAR` (aprobar): `tesoreria` (maria_gutierrez).
 *    `FINANCE_CAJA_GESTIONAR` (pagar): `finanzas`, `superadmin`, `tesoreria`.
 *  · carmen_rodriguez = `finanzas`.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO → se aplica a mano en prod
 *    ANTES de soltar. Después, quien la recibe tiene que volver a entrar (el JWT trae los permisos).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[cga_a65_caja_general_arma_la_hoja]';
const KEY = 'FINANCE_HOJA_GASTOS_CERRAR';
const ROLES = ['finanzas'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?)
        AND role_name NOT LIKE 'retirado%'
        AND permissions -> ?::text IS NULL`,
    [KEY, ROLES, KEY],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb
      ORDER BY role_name`,
    [ROLES, KEY],
  );
  const con = rows.map((r) => r.role_name);
  const faltan = ROLES.filter((r) => !con.includes(r));
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quién quedó sin la clave.
  console.log(
    `${TAG} ${KEY}: ${res.rowCount ?? 0} fila(s) · con la clave: [${con.join(', ') || 'NINGUNO'}]`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
  console.log(`${TAG} Las personas afectadas deben volver a entrar (el JWT trae los permisos).`);
};

/** No-op, como el resto de los repartos de permisos: se quita desde `/admin/roles`. */
exports.down = async function down() {
  console.log(`${TAG} down: no-op`);
};
