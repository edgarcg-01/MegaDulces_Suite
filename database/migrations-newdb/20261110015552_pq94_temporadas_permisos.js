'use strict';
/**
 * `[PQ.94]` — Reparte las claves de Compras › Temporadas (regla 20: un módulo no está entregado hasta que su
 * permiso está repartido en prod, no sólo declarado en el enum).
 *
 * D35 (Francisco, 2026-11-10; falta que el PM la ratifique): la temporada la deciden Compras, Mercadotecnia,
 * Dirección Comercial y Dirección General. Medido en prod (sólo lectura) el 2026-11-10, personas activas:
 *  · VER        → compras (2), gerente_compras (2), auxiliar_compras (5), compras_operaciones (1),
 *                 marketing (3), jefe_marketing (1), direccion (2).
 *  · GESTIONAR  → compras, gerente_compras, marketing, jefe_marketing, direccion (quienes deciden; los
 *                 auxiliares y operaciones de Compras leen).
 *  ⚠️ Dirección Comercial NO tiene rol propio (MATRIZ_ACCESOS: «Dirección Comercial y Marketing · sin
 *     definir»): queda cubierta por `direccion`. superadmin pasa todo por el modo dios del guard.
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien alguien
 * ya se la puso en `false` a mano no se le pisa. Después VERIFICA y falla si no quedó repartida.
 *
 * ⚠️ Sólo hace UPDATE (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y se aplica a mano
 *    con `apply-one-migration-prod.js`, DESPUÉS de 20261110010537 (las tablas). Después la gente tiene que
 *    volver a entrar (el permiso viaja en el JWT armado al login).
 *
 * @param { import("knex").Knex } knex
 */

const REPARTO = {
  COMPRAS_TEMPORADAS_VER: ['compras', 'gerente_compras', 'auxiliar_compras', 'compras_operaciones', 'marketing', 'jefe_marketing', 'direccion'],
  COMPRAS_TEMPORADAS_GESTIONAR: ['compras', 'gerente_compras', 'marketing', 'jefe_marketing', 'direccion'],
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [clave, roles] of Object.entries(REPARTO)) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true)
        WHERE role_name = ANY(?) AND deleted_at IS NULL
          AND permissions -> ?::text IS NULL`,
      [clave, roles, clave],
    );
    const { rows } = await knex.raw(
      `SELECT count(DISTINCT rp.role_name)::int AS roles, count(DISTINCT u.id)::int AS personas
         FROM identity.role_permissions rp
         LEFT JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                                   AND u.activo IS TRUE AND u.deleted_at IS NULL
        WHERE rp.role_name = ANY(?) AND rp.deleted_at IS NULL
          AND (rp.permissions ->> ?::text)::boolean IS TRUE`,
      [roles, clave],
    );
    // eslint-disable-next-line no-console
    console.log(`  [PQ.94] ${clave}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la clave · ${rows[0].personas} persona(s) activa(s)`);
    const existen = await knex('identity.role_permissions').whereIn('role_name', roles).whereNull('deleted_at').first('role_name');
    if (existen && rows[0].roles === 0) throw new Error(`[PQ.94] ${clave} no quedó en ningún rol: revisar identity.role_permissions.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita las dos claves en esos roles. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [clave, roles] of Object.entries(REPARTO)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text
        WHERE role_name = ANY(?) AND (permissions ->> ?::text)::boolean IS TRUE`,
      [clave, roles, clave],
    );
  }
};
