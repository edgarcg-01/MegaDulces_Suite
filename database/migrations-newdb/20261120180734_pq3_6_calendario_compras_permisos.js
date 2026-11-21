'use strict';
/**
 * `[PQ.3.6]` — Reparte las claves de Compras › Calendario de compras (regla 20: un módulo no está entregado
 * hasta que su permiso está repartido en prod, no sólo declarado en el enum) y recorta a los almacenistas a
 * su sucursal en el área Compras.
 *
 * Quién entra: anexo C §4.1 (puestos confirmados por Francisco el 2026-11-10). Medido en prod (sólo
 * lectura) el 2026-11-20, personas activas por rol:
 *  · gerente_compras (2) ......... ver · marcar · CICLO (DC8: los ciclos los define la gerencia de compras)
 *  · compras (2: comprador y auxiliar) ver · marcar ⚠️ no está en §4.1: se agrega por el puesto de comprador;
 *                                  quitarlo es borrar el rol de las dos listas de abajo
 *  · compras_operaciones (1) ..... ver · marcar (Compras Morelia)
 *  · auxiliar_compras (5) ........ ver · marcar (Recepción de mercancía)
 *  · encargado_tienda (10) ....... ver · marcar, sólo su sucursal (alcance `own` que el rol ya tiene)
 *  · almacenista (9) ............. ver · marcar, sólo su sucursal (el alcance de abajo)
 *  · direccion (3) ............... ver
 *  superadmin pasa todo por el modo dios del guard (también los dos gerentes de zona con ese rol).
 *
 * El alcance (`identity.role_scopes`, área `compras`, la de Pedido): el almacenista tiene `all` en `'*'`
 * (medido), así que vería y marcaría las reglas de TODAS las sucursales. Se le pone `own` (lee y escribe su
 * `warehouse_code`) sólo en Compras: medido, ningún almacenista usó en 60 días una ruta de Compras (Pedido no
 * lo tiene; Catálogo, 0 visitas), así que el recorte no le quita nada que use hoy. ⚠️ 4 de los 9 no tienen
 * sucursal en su ficha: con `own` no ven reglas hasta que se les asigne (la pantalla lo dice).
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien alguien ya
 * se la puso en `false` a mano no se le pisa. El alcance, `ON CONFLICT DO NOTHING` sobre la PK
 * `(tenant_id, role_name, dimension, area)`: si alguien ya escribió uno para el almacenista en Compras, gana el
 * suyo. Después VERIFICA y falla si no quedó.
 *
 * ⚠️ Sólo toca datos (no crea esquema): se aplica a mano con `apply-one-migration-prod.js`, DESPUÉS de
 *    20261120130156 (las tablas). Después la gente tiene que volver a entrar (el permiso viaja en el JWT armado
 *    al login); el alcance no (caché de 30 s).
 *
 * @param { import("knex").Knex } knex
 */

const REPARTO = {
  COMPRAS_CALENDARIO_VER: [
    'gerente_compras', 'compras', 'compras_operaciones', 'auxiliar_compras', 'encargado_tienda', 'almacenista', 'direccion',
  ],
  COMPRAS_CALENDARIO_GESTIONAR: ['gerente_compras', 'compras', 'compras_operaciones', 'auxiliar_compras', 'encargado_tienda', 'almacenista'],
  COMPRAS_CALENDARIO_CICLO: ['gerente_compras'],
};

const NOTA = '[PQ.3.6] Compras: el almacenista ve y marca sólo su sucursal (calendario de compras).';

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
    console.log(`  [PQ.3.6] ${clave}: ${r.rowCount} fila(s) tocadas · ${rows[0].roles} rol(es) con la clave · ${rows[0].personas} persona(s) activa(s)`);
    const existen = await knex('identity.role_permissions').whereIn('role_name', roles).whereNull('deleted_at').first('role_name');
    if (existen && rows[0].roles === 0) throw new Error(`[PQ.3.6] ${clave} no quedó en ningún rol: revisar identity.role_permissions.`);
  }

  const a = await knex.raw(
    `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, mode_write, nota)
     SELECT rp.tenant_id, rp.role_name, 'warehouse', 'compras', 'own', 'own', ?
       FROM identity.role_permissions rp
      WHERE rp.role_name = 'almacenista' AND rp.deleted_at IS NULL
     ON CONFLICT (tenant_id, role_name, dimension, area) DO NOTHING`,
    [NOTA],
  );
  const { rows: alc } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_scopes
      WHERE role_name = 'almacenista' AND dimension = 'warehouse' AND area = 'compras'`,
  );
  console.log(`  [PQ.3.6] alcance del almacenista en Compras: ${a.rowCount} fila(s) nuevas · ${alc[0].n} regla(s) en total`);
  const hayAlmacenista = await knex('identity.role_permissions').where({ role_name: 'almacenista' }).whereNull('deleted_at').first('role_name');
  if (hayAlmacenista && alc[0].n === 0) throw new Error('[PQ.3.6] el almacenista quedó sin regla de alcance en Compras: revisar identity.role_scopes.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita las tres claves en esos roles y SU regla de alcance (por la nota). */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [clave, roles] of Object.entries(REPARTO)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text
        WHERE role_name = ANY(?) AND (permissions ->> ?::text)::boolean IS TRUE`,
      [clave, roles, clave],
    );
  }
  await knex.raw(
    `DELETE FROM identity.role_scopes WHERE role_name = 'almacenista' AND dimension = 'warehouse' AND area = 'compras' AND nota = ?`,
    [NOTA],
  );
};
