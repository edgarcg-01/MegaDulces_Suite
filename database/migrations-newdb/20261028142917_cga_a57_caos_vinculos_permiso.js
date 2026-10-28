'use strict';
/**
 * `[CGA-A.57]` — Reparte `FINANCE_CAOS_VINCULOS_VER`: ver a qué movimientos de Caja General se
 * vinculó cada depósito o retiro de CAOS (Edgar, 2026-10-28: *«¿dónde puedo visualizar los
 * movimientos que se vincularon a cada movimiento de CAOS? sólo como supervisor»*).
 *
 * Un módulo no está entregado hasta que su clave está en `role_permissions` (regla 20).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-28) ────────────────────────────────────────
 *  · `FINANCE_CAOS_VER` la tienen 12 roles, `surtidor` y `marketing` incluidos: por eso la clave
 *    es aparte y no se cuelga de la de ver la pantalla.
 *  · Supervisión = `direccion`, `finanzas` y `tesoreria` (el puesto de quien autoriza la caja,
 *    maria_gutierrez). Los tres existen y ninguno trae la clave todavía.
 *  · superadmin / admin pasan por god-mode (ADR-054).
 *
 * ⚠️ Es una clave `FINANCE_CAOS_*`: el trigger de `[LE.4.8]` abre UN hallazgo por rol en
 *    `cashbook.findings`, que cierra una persona distinta de quien lo aplicó. Es lo esperado.
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO → se aplica a mano en
 *    prod ANTES de soltar. Después, las personas tienen que volver a entrar (el JWT trae los permisos).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[cga_a57_caos_vinculos_permiso]';
const KEY = 'FINANCE_CAOS_VINCULOS_VER';
const ROLES = ['direccion', 'finanzas', 'tesoreria'];

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
