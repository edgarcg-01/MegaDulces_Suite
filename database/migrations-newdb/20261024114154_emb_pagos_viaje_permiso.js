'use strict';
/**
 * `[EMB.43]` — Reparte el permiso del módulo **Logística › Pagos de viaje**
 * (`LOGISTICS_PAGOS_VER` / `LOGISTICS_PAGOS_GESTIONAR`).
 *
 * Un módulo no está entregado hasta que su clave está en `role_permissions` (regla 20).
 * Decisión de Edgar (2026-10-24): «Leonardo y Juan» operan; finanzas y dirección ven.
 *
 * ── A quién, medido en prod el 2026-10-24 (sólo lectura)
 *
 *  - `encargado_bodega` — 1 persona activa: Leonardo Cazares (Aux. Administrativo de Logística),
 *    que es quien arma HOY la liquidación de comisiones en papel. ⛔ Su rol no tenía NINGÚN
 *    permiso de logística: no podía abrir ni `/logistica/shipments`. VER + GESTIONAR.
 *  - `coordinador_embarques` — 1 persona activa: Juan Arellano (Embarques). Sólo veía
 *    embarques. VER + GESTIONAR.
 *  - `finanzas` (1) y `direccion` (2): sólo VER. Finanzas aprueba el vale en Gastos; dirección
 *    autoriza tarifas (`LOGISTICS_TARIFAS_AUTORIZAR`).
 *  - superadmin / admin pasan por `manage:all`.
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue no la puede «medir» por un objeto de
 * esquema. **Aplicarla ANTES de empujar** (una por una, `apply-one-migration-prod.js`).
 *
 * Idempotente y no destructivo: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB).
 * Si alguien ya la puso en `false` a mano, no se le pisa. Después de aplicarla, las personas
 * tienen que volver a entrar: los permisos viajan dentro del JWT.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[emb_pagos_viaje_permiso]';
const VER = 'LOGISTICS_PAGOS_VER';
const GESTIONAR = 'LOGISTICS_PAGOS_GESTIONAR';
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
