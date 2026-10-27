'use strict';
/**
 * `[FCU.3.11]` — Reparte el permiso del módulo **Logística › Costo por unidad**
 * (`LOGISTICS_COSTO_UNIDAD_VER` / `LOGISTICS_COSTO_UNIDAD_GESTIONAR`).
 *
 * Un módulo no está entregado hasta que su clave está en `role_permissions` (regla 20).
 *
 * ── A quién, medido en prod el 2026-10-26 (sólo lectura) ────────────────────────────────────
 *  - `encargado_bodega` (Leonardo Cazares, Aux. Administrativo de Logística) y
 *    `coordinador_embarques` (Juan, Embarques): VER + GESTIONAR. Son quienes hoy llenan y usan la
 *    hoja; GESTIONAR incluye ver salarios y nómina administrativa.
 *  - `finanzas` y `direccion`: sólo VER (no ven salarios ni nómina administrativa).
 *  - superadmin / admin pasan por `manage:all`.
 *  - ⚠️ La Jefatura de CEDIS tiene el rol `almacenista`, que comparten TODOS los almacenistas:
 *    darlo por rol abriría salarios a todo el almacén. NO se reparte aquí; se le da a esa persona
 *    desde `/admin/personas` (permiso individual) cuando Edgar lo decida.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO → se aplica a mano en
 *    prod ANTES de soltar. Después, las personas tienen que volver a entrar (el JWT trae los permisos).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[fcu_costo_unidad_permiso]';
const VER = 'LOGISTICS_COSTO_UNIDAD_VER';
const GESTIONAR = 'LOGISTICS_COSTO_UNIDAD_GESTIONAR';
const OPERAN = ['encargado_bodega', 'coordinador_embarques'];
const VEN = ['encargado_bodega', 'coordinador_embarques', 'finanzas', 'direccion'];

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
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quién quedó sin la clave.
  console.log(
    `${TAG} ${key}: ${res.rowCount ?? 0} fila(s) · con la clave: [${con.join(', ') || 'NINGUNO'}]`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await otorga(knex, VER, VEN);
  await otorga(knex, GESTIONAR, OPERAN);
  console.log(`${TAG} Las personas afectadas deben volver a entrar (el JWT trae los permisos).`);
};

/** No-op, como el resto de los repartos de permisos: se quita desde `/admin/roles`. */
exports.down = async function down() {
  console.log(`${TAG} down: no-op`);
};
