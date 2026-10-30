'use strict';
/**
 * `[E.12.y]` — concede `COMMERCIAL_TELEVENTA_OPERATE` (Operar Telemarketing) a `cajero` y
 * `encargado_tienda` (Opción A, autorizada por Edgar el 2026-10-30).
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 * La ruta `/telemarketing/cotizaciones` exige DOS llaves a la vez (app.routes.ts, `[AX.16]`):
 * `COMMERCIAL_QUOTES_VER` **Y** `COMMERCIAL_TELEVENTA_OPERATE`. La migración 20261030143050 dio
 * las de QUOTES, pero sin OPERATE la ruta seguía denegando («Tu rol no abre esta sección»).
 *
 * ⚠️ OPERATE NO es sólo cotizar: abre TODO el pool de televenta (tomar cliente, registrar llamada,
 *    levantar pedido) y las demás pantallas de Telemarketing gateadas por esta llave. Edgar lo
 *    aceptó a propósito para dar acceso inmediato sin esperar un deploy del candado de la ruta.
 *
 * ── Estado medido en prod (sólo lectura, 2026-10-30) ────────────────────────────────────────
 *  · cajero: NO tenía la clave (NULL).
 *  · encargado_tienda: la tenía en `false` explícito.
 * Por eso NO se usa el patrón «rellenar sólo donde la clave es NULL»: hay que FORZAR `true` en
 * ambos. El UPDATE escribe `true` sin condición de valor previo → idempotente (correrlo otra vez
 * deja lo mismo). NO toca a ningún otro rol.
 *
 * Permisos frescos por request (`RolesGuard`): sin re-login en el servidor; la UI los toma en el
 * siguiente `me/access` (recargar basta).
 *
 * ⚠️ Sólo UPDATE sobre `role_permissions`: la compuerta del despliegue la clasifica NO_MEDIDO.
 *    Aplicar con `apply-one-migration-prod.js`, una por una (regla 17).
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'COMMERCIAL_TELEVENTA_OPERATE';
const ROLES = ['cajero', 'encargado_tienda'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ANY(?::text[])`,
    [KEY, ROLES],
  );
  const { rows } = await knex.raw(
    `SELECT role_name, permissions -> ?::text AS valor
       FROM role_permissions WHERE role_name = ANY(?::text[]) ORDER BY 1`,
    [KEY, ROLES],
  );
  console.log(`[tlmk_operate_cajero_encargado] ${res.rowCount ?? 0} filas · ${rows.map((r) => `${r.role_name}=${JSON.stringify(r.valor)}`).join(', ')}`);
  const ok = rows.filter((r) => r.valor === true || r.valor === 'true');
  if (ok.length !== ROLES.length) {
    throw new Error(`No quedaron en true los ${ROLES.length} roles esperados: ${rows.map((r) => `${r.role_name}=${r.valor}`).join(', ')}`);
  }
};

exports.down = async function down(knex) {
  // Reversa conservadora: deja la clave en `false` explícito (no la borra). cajero no la tenía;
  // encargado_tienda la tenía en false. Volver a false en ambos restituye el estado funcional.
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, false)
      WHERE role_name = ANY(?::text[])`,
    [KEY, ROLES],
  );
};
