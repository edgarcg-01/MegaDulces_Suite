'use strict';
/**
 * `[PQ.157]` C2 — Reparte la clave `COMPRAS_COSTO_DECIDIR` (regla 20: un módulo no está entregado hasta que su
 * permiso está repartido en prod, no sólo declarado en el enum).
 *
 * Quién decide el costo de un renglón aplicado (aceptar, reclamar nota de crédito o promoción): **sólo Compras**,
 * decidido por Francisco el 2026-11-26 (anexo R §3e). Medido en prod (sólo lectura) ese día, personas activas por rol:
 *  · gerente_compras (2) · compras (2) · compras_operaciones (1) · auxiliar_compras (5)  → 10 personas.
 * La clave de validar entradas (`COMPRAS_ENTRADAS_VALIDAR`) la tienen además encargado_tienda (10), finanzas (2) y
 * tesorería (1): por eso es una clave propia y no se reusa. superadmin pasa todo por el modo dios del guard.
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien alguien ya se la
 * puso en `false` a mano no se le pisa. Después VERIFICA y falla si no quedó en ningún rol existente.
 *
 * ⚠️ Sólo toca datos (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y frena hasta que se
 *    aplique a mano con `apply-one-migration-prod.js` (va DESPUÉS de 20261126001925, la tabla). Después esas personas
 *    tienen que volver a entrar: el permiso viaja en el JWT armado al login.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'COMPRAS_COSTO_DECIDIR';
const ROLES = ['gerente_compras', 'compras', 'compras_operaciones', 'auxiliar_compras'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?) AND deleted_at IS NULL
        AND permissions -> ?::text IS NULL`,
    [CLAVE, ROLES, CLAVE],
  );
  const { rows } = await knex.raw(
    `SELECT count(DISTINCT rp.role_name)::int AS roles, count(DISTINCT u.id)::int AS personas
       FROM identity.role_permissions rp
       LEFT JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                                 AND u.activo IS TRUE AND u.deleted_at IS NULL
      WHERE rp.role_name = ANY(?) AND rp.deleted_at IS NULL
        AND (rp.permissions ->> ?::text)::boolean IS TRUE`,
    [ROLES, CLAVE],
  );
  console.log(`  [PQ.157] ${CLAVE}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la clave · ${rows[0].personas} persona(s) activa(s)`);
  const existen = await knex('identity.role_permissions').whereIn('role_name', ROLES).whereNull('deleted_at').first('role_name');
  if (existen && rows[0].roles === 0) throw new Error(`[PQ.157] ${CLAVE} no quedó en ningún rol: revisar identity.role_permissions.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave en esos roles (sólo donde está en true). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text
      WHERE role_name = ANY(?) AND (permissions ->> ?::text)::boolean IS TRUE`,
    [CLAVE, ROLES, CLAVE],
  );
};
