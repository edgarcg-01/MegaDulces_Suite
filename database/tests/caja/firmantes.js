'use strict';
/**
 * `[LE.4.9]` — Siembra en la base de prueba a quien FIRMA caja: un usuario activo con un puesto que
 * tiene la responsabilidad `finanzas.caja_firma`. Desde LE.4.9 la base rechaza cualquier firma de
 * otra persona, así que toda prueba que autoriza, rechaza, cierra la jornada o cierra un hallazgo
 * con nota necesita a su firmante sembrado.
 *
 * Se confirma en su propia transacción (los tenants de prueba son al azar) y con los triggers
 * apagados (`replica`): darle la firma a un puesto abre una alerta, y aquí eso es el andamio de la
 * prueba, no lo que se prueba. La alerta tiene su propia prueba (`test-newdb-cashbook-firma-puesto`).
 * Necesita superusuario; si la migración de LE.4.9 no está, no hace nada.
 */
const CLAVE = 'finanzas.caja_firma';

async function sembrarFirmantes(knex, tenant, usuarios, { puesto = 'tesoreria', principal = true } = {}) {
  const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook._firma_de_caja(uuid, uuid)') IS NOT NULL AS hay`);
  if (!h.hay) return false;
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL session_replication_role = replica`);
    for (const id of usuarios) {
      await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, kind, position_code, created_at, updated_at)
        VALUES (?, ?, ?, 'firma_prueba', true, 'interno', ?, now(), now())`, [id, tenant, `firma_${id.slice(0, 8)}`, puesto]);
    }
    await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
      SELECT gen_random_uuid(), ?, ?, ?, ?, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM identity.position_responsibilities
                          WHERE tenant_id = ? AND position_code = ? AND responsibility_key = ? AND deleted_at IS NULL)`,
    [tenant, puesto, CLAVE, principal, tenant, puesto, CLAVE]);
  });
  return true;
}

module.exports = { sembrarFirmantes, CLAVE };
