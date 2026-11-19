'use strict';
/**
 * `[ALC/promotor]` — El rol `promotor` gana acceso a `/levantamiento` (catálogo digital) y a la
 * Mesa de Servicio para REPORTAR. Pedido de Edgar (2026-11-19): «a todas las promotoras, acceso a
 * la mesa de servicio y al apartado de /levantamiento».
 *
 *  · CATALOGO_LEVANTAR → abre `/levantamiento` (permissionGuard en app.routes.ts): escanear y
 *    fotografiar fichas desde el celular. La sucursal se elige al capturar (D25).
 *  · SERVICIO_REPORTAR → Mesa de Servicio: reportar un problema/necesidad (folio SRV-…) y ver,
 *    comentar, confirmar o reabrir SÓLO lo propio. NO da la bandeja de atención (SERVICIO_ATENDER)
 *    ni coordinación (SERVICIO_COORDINAR).
 *
 * ── Lo medido antes (sólo lectura, sysid 7688376744939610156) ───────────────────────────────
 *  · identity.role_permissions: 1 fila `promotor` (tenant mega_dulces), activa, 2 claves de
 *    caducidades, sin CATALOGO_LEVANTAR ni SERVICIO_REPORTAR.
 *
 * No crea objetos de esquema (sólo UPDATE a role_permissions): la compuerta del despliegue la
 * clasifica NO_MEDIDO. Se aplica a mano ANTES de mergear (`aplicar-migracion.sh`). Las promotoras
 * deben RE-ENTRAR para que el JWT traiga las claves nuevas.
 *
 * Idempotente (`||` reaplica sin duplicar; el `down` quita exactamente las 2 claves).
 *
 * @param { import("knex").Knex } knex
 */

const CLAVES_NUEVAS = { CATALOGO_LEVANTAR: true, SERVICIO_REPORTAR: true };

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb,
            updated_at  = now()
      WHERE role_name = 'promotor'
        AND NOT (permissions @> ?::jsonb)`,
    [JSON.stringify(CLAVES_NUEVAS), JSON.stringify(CLAVES_NUEVAS)]
  );
  console.log(`[promotor] filas actualizadas con CATALOGO_LEVANTAR + SERVICIO_REPORTAR: ${res.rowCount}`);

  // Gate: ninguna fila `promotor` puede quedar SIN las dos claves.
  const faltan = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE role_name = 'promotor' AND NOT (permissions @> ?::jsonb)`,
    [JSON.stringify(CLAVES_NUEVAS)]
  );
  const n = faltan.rows[0].n;
  if (n > 0) throw new Error(`[promotor] ${n} fila(s) quedaron sin las claves nuevas — abortado`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita las 2 claves, nada más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - 'CATALOGO_LEVANTAR' - 'SERVICIO_REPORTAR',
            updated_at  = now()
      WHERE role_name = 'promotor'`
  );
};
