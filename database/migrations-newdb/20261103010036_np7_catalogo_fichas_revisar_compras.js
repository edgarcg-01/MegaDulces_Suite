'use strict';
/**
 * `[NP.7.L.15]` — Reparte `CATALOGO_FICHAS_REVISAR` (la bandeja «Por revisar» del Catálogo digital) a
 * `compras` y `gerente_compras` (regla 20).
 *
 * Decisión de Francisco (2026-11-03): publican las fichas Compras y su gerencia — quienes mantienen el
 * catálogo hoy, pocos para que el criterio sea parejo. Medido ese día en prod (sólo lectura): los dos roles
 * existen, ninguno trae la clave (ni en false) y suman 4 personas activas.
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien
 * alguien ya se la puso en `false` a mano no se le pisa. Después VERIFICA y falla si no quedó repartida.
 *
 * ⚠️ Sólo hace UPDATE (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y se aplica a
 * mano con `apply-one-migration-prod.js`. Después la gente tiene que volver a entrar (el permiso viaja en
 * el JWT armado al login).
 *
 * @param { import("knex").Knex } knex
 */

const ROLES = ['compras', 'gerente_compras'];
const CLAVE = 'CATALOGO_FICHAS_REVISAR';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"${CLAVE}": true}'::jsonb
      WHERE role_name IN (?, ?) AND deleted_at IS NULL
        AND permissions -> '${CLAVE}' IS NULL`,
    ROLES,
  );
  const { rows } = await knex.raw(
    `SELECT count(DISTINCT rp.role_name)::int AS roles, count(DISTINCT u.id)::int AS personas
       FROM identity.role_permissions rp
       LEFT JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                                 AND u.activo IS TRUE AND u.deleted_at IS NULL
      WHERE rp.role_name IN (?, ?) AND rp.deleted_at IS NULL
        AND (rp.permissions ->> ?)::boolean IS TRUE`,
    [...ROLES, CLAVE],
  );
  // eslint-disable-next-line no-console
  console.log(`  [NP.7.L.15] ${CLAVE}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la clave · ${rows[0].personas} persona(s) activa(s)`);
  const existen = await knex('identity.role_permissions').whereIn('role_name', ROLES).whereNull('deleted_at').first('role_name');
  if (existen && rows[0].roles === 0) throw new Error(`[NP.7.L.15] ${CLAVE} no quedó en ningún rol de Compras: revisar role_permissions.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave en esos dos roles. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - '${CLAVE}'
      WHERE role_name IN (?, ?) AND (permissions ->> '${CLAVE}')::boolean IS TRUE`,
    ROLES,
  );
};
