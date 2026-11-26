'use strict';
/**
 * `[PQ.3.8]` — Reparte las llaves de Compras › Proveedores › **Citas** (regla 20: un módulo no está entregado hasta
 * que su permiso está repartido en prod, no sólo declarado en el enum).
 *
 * Quién entra: DC41 (Francisco, 2026-11-26, «sin tiendas»): agendan Compras, Mercadotecnia y Tesorería; Dirección
 * consulta. Encargados de tienda y almacenistas NO: su trato con el proveedor es la entrega y el pedido del Calendario.
 *
 * ── Lo medido antes (pg-prod 7688376744939610156, sólo lectura, 2026-11-26) — personas activas por rol ──────────────
 *  · gerente_compras (2) · compras (2) · compras_operaciones (1) · auxiliar_compras (5) ... ver · AGENDAR (Compras, 10)
 *  · jefe_marketing (1) · marketing (3) ................................................ ver · AGENDAR (Mercadotecnia, 4)
 *  · tesoreria (1) ..................................................................... ver · AGENDAR (DC16: Tesorería)
 *  · direccion (3) ..................................................................... ver
 *  = 18 personas ven la agenda y 15 agendan. superadmin pasa todo por el modo dios del guard. El puesto «Analista de
 *  Egresos» (DC16) tiene 0 personas y sin rol: quien lo ocupe necesita `tesoreria` o la llave por persona.
 *
 * Sólo AGREGA donde la llave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien alguien ya se la
 * puso en `false` a mano no se le pisa. Después VERIFICA y falla si no quedó.
 *
 * ⚠️ Sólo toca datos (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y FRENA hasta que alguien la
 *    aplique a mano con `apply-one-migration-prod.js`, DESPUÉS de 20261125203927 (las tablas). Aplicala ANTES de soltar.
 *    Después, esas 18 personas tienen que volver a entrar (el permiso viaja en el JWT armado al login).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const AGENDAN = ['gerente_compras', 'compras', 'compras_operaciones', 'auxiliar_compras', 'jefe_marketing', 'marketing', 'tesoreria'];

const REPARTO = {
  COMPRAS_CITAS_VER: [...AGENDAN, 'direccion'],
  COMPRAS_CITAS_AGENDAR: AGENDAN,
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [clave, roles] of Object.entries(REPARTO)) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object(?::text, true)
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
    console.log(`  [PQ.3.8] ${clave}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la llave · ${rows[0].personas} persona(s) activa(s)`);
    const existen = await knex('identity.role_permissions').whereIn('role_name', roles).whereNull('deleted_at').first('role_name');
    if (existen && rows[0].roles === 0) throw new Error(`[PQ.3.8] ${clave} no quedó en ningún rol: revisar identity.role_permissions.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita las dos llaves en esos roles (sólo donde valen true). */
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
