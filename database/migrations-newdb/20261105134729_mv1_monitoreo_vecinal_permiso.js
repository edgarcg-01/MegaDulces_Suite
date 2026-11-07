'use strict';
/**
 * `[MV.1]` — Reparte `COMMERCIAL_MONITOREO_VECINAL_VER`, la llave del **Monitoreo vecinal**
 * (`/comercial/monitoreo-vecinal`): la actividad de vendedores, surtidores y cajeras de la preventa.
 * Un módulo no está entregado hasta que su clave está en `role_permissions` (regla 20).
 *
 * ── A quién, y por qué ──────────────────────────────────────────────────────────────────────
 * Decisión de David (2026-11-05): supervisores de ruta, gerencia/dirección y encargados de tienda.
 * Medido en prod el 2026-11-05 (sólo lectura), personas activas por rol:
 *  · `supervisor_ventas` 5 — supervisan la ruta (también la Gerencia de Zona usa este rol);
 *  · `direccion` 2 — gerencia / dirección;
 *  · `encargado_tienda` 10 — su sucursal (el surtido y la caja son de su tienda);
 *  · `superadmin` 8.
 * Los cuatro ya tienen `COMMERCIAL_CARTERA_VER` (el tablero del supervisor). `retirado_gerente_de_zona`
 * (0 personas) no se toca. Qué sucursal ve cada quien lo decide su ALCANCE (ScopeService).
 *
 * ⚠️ El módulo muestra la UBICACIÓN de los vendedores. David declara que está validado con RH/Edgar
 *    (2026-11-05); la evidencia de esa validación la guarda él.
 *
 * ⚠️ Sólo hace UPDATE: se aplica a mano en prod (lo decide Edgar/PM) ANTES de soltar. Las personas
 *    tienen que volver a entrar (el JWT trae los permisos).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB). Si
 * alguien ya la puso en `false` a mano, no se le pisa.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[mv1_monitoreo_vecinal_permiso]';
const VER = 'COMMERCIAL_MONITOREO_VECINAL_VER';
const ROLES = ['direccion', 'encargado_tienda', 'superadmin', 'supervisor_ventas'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?)
        AND permissions -> ?::text IS NULL`,
    [VER, ROLES, VER],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE role_name = ANY(?) AND permissions -> ?::text = 'true'::jsonb
      ORDER BY role_name`,
    [ROLES, VER],
  );
  const con = rows.map((r) => r.role_name);
  const faltan = ROLES.filter((r) => !con.includes(r));
  // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA quién quedó sin la clave.
  console.log(
    `${TAG} ${VER}: ${res.rowCount ?? 0} fila(s) · con la clave: ${con.length} rol(es)`
    + (faltan.length ? ` · ⚠️ SIN la clave (rol inexistente o en false a mano): [${faltan.join(', ')}]` : ''),
  );
  console.log(`${TAG} Las personas afectadas deben volver a entrar (el JWT trae los permisos).`);
};

/** No-op, como el resto de los repartos de permisos: se quita desde `/admin/roles`. */
exports.down = async function down() {
  console.log(`${TAG} down: no-op`);
};
