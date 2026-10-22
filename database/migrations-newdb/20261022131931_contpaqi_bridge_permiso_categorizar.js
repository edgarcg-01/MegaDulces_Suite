'use strict';
/**
 * `[CP.8.80]` — **Reparte `FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR`**: poner categoría desde el puente a un egreso de
 * banco que no la tiene, y dejar la regla por beneficiario.
 *
 * Permiso propio por decisión del PM (2026-10-22). La alternativa era repartir `FINANCE_BANK_GESTIONAR`, que
 * además sube estados de cuenta y edita cuentas de banco: no es trabajo de Contabilidad.
 *
 * ⛔ Un permiso que sólo vive en el enum no le da acceso a nadie (`[LC.6.2]`): esta migración es la entrega.
 *
 * | rol | por qué |
 * |---|---|
 * | `contabilidad` | arma el archivo de ContPAQi; un egreso sin categoría no entra |
 * | `finanzas` | dueño de las categorías de banco; hoy tampoco tiene dónde ponerlas (Bancos es de sólo lectura) |
 * | `superadmin` | igual que el resto del puente |
 *
 * `direccion` y `auditor_externo` ven el puente y **no** categorizan, igual que no gestionan (`[CP.8.32]`).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-22, `system_identifier` 7688376744939610156) ───────────────
 *  · Los 5 roles con el puente: `contabilidad`, `finanzas`, `superadmin` con `_GESTIONAR` en true;
 *    `direccion` y `auditor_externo` en false. **Ninguno trae `_CATEGORIZAR`** (ni en false).
 *
 * ⚠️ No crea objetos de esquema: la compuerta de despliegue la clasifica NO_MEDIDO. Aplicarla con
 *    `apply-one-migration-prod.js` ANTES de mergear.
 *
 * Idempotente: escribe el valor, exista o no la clave (el patrón `IS NULL` fue un no-op en `[IC.23]`).
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR';
const ROLES = ['contabilidad', 'finanzas', 'superadmin'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = jsonb_set(permissions, ?::text[], 'true'::jsonb, true), updated_at = now()
      WHERE role_name = ANY(?)`,
    [`{${CLAVE}}`, ROLES],
  );
  // ⛔ Un UPDATE que no encuentra su fila no falla: se lee igual que un éxito.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions WHERE (permissions->>?)::boolean IS TRUE AND role_name = ANY(?)`,
    [CLAVE, ROLES],
  );
  if (!rows[0] || rows[0].n !== ROLES.length) {
    throw new Error(`[CP.8.80] ${CLAVE} quedó en ${rows[0] ? rows[0].n : 0} roles y se esperaban ${ROLES.length} (${ROLES.join(', ')})`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now() WHERE role_name = ANY(?)`,
    [CLAVE, ROLES],
  );
};
