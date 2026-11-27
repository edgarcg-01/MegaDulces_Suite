'use strict';
/**
 * `[PGP.229]` — Reparte la clave `FINANCE_CFDI_NORMA_DECIDIR` (regla 20: un módulo no está entregado hasta que su
 * permiso está repartido en prod, no sólo declarado en el enum).
 *
 * Quién decide si una factura recibida fuera de norma fiscal (uso S01, régimen distinto de 612) se usa o no: **basta
 * una firma, de Administración o de Contabilidad** (D-NF2), y la llave va a los perfiles **`contabilidad` y
 * `direccion`** (Francisco, 2026-11-26). Medido en prod (sólo lectura) ese día: contabilidad 5 personas, direccion 4.
 * Ninguno la tiene todavía (la clave es nueva). superadmin pasa todo por el modo dios del guard.
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien alguien ya se la
 * puso en `false` a mano no se le pisa. Después VERIFICA y falla si no quedó en ningún rol existente.
 *
 * ⚠️ Sólo toca datos (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y frena hasta que se
 *    aplique a mano con `apply-one-migration-prod.js`, DESPUÉS de `20261126215436_pgp224_autorizaciones_norma_fiscal_cfdi.js`
 *    (la tabla). Después esas personas tienen que volver a entrar: el permiso viaja en el JWT armado al login.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'FINANCE_CFDI_NORMA_DECIDIR';
const ROLES = ['contabilidad', 'direccion'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object(?::text, true)
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
  console.log(`  [PGP.229] ${CLAVE}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la clave · ${rows[0].personas} persona(s) activa(s)`);
  const existen = await knex('identity.role_permissions').whereIn('role_name', ROLES).whereNull('deleted_at').first('role_name');
  if (existen && rows[0].roles === 0) throw new Error(`[PGP.229] ${CLAVE} no quedó en ningún rol: revisar identity.role_permissions.`);
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
