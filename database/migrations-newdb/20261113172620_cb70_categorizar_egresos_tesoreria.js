'use strict';
/**
 * `[CB.70]` — **Reparte `FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR` a `finanzas_operativo` y `tesoreria`**: categorizar
 * un egreso de banco sin categoría desde Bancos › Movimientos (la misma pieza y el mismo motor del puente,
 * `[CP.8.80]`), y si se pide, dejar la regla por beneficiario.
 *
 * Decisión de Edgar (2026-11-13, «si, dale»): quien concilia los bancos categoriza lo que le sale sin categoría.
 * Hasta hoy el permiso era sólo de `contabilidad`, `finanzas` y `superadmin` (`20261022131931`), y el Cierre de
 * Bancos mandaba a buscarlo en Kepler, que no le pone categoría al movimiento.
 *
 * ⛔ Un permiso que sólo vive en el enum no le da acceso a nadie (`[LC.6.2]`): esta migración es la entrega.
 * ⚠️ NO reparte `FISCAL_CONTPAQI_BRIDGE_VER`: estos roles no ven la pantalla del puente. Las dos lecturas que usa la
 *    pieza (categorías de egreso y vista previa de la regla) pasan en CB.70 a `@RequireAnyPermission(_VER,
 *    _CATEGORIZAR)`: sin ese cambio, el botón saldría y el formulario fallaría con 403.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-13, `system_identifier` 7688376744939610156) ───────────────
 *  · `finanzas_operativo` (8 personas activas) y `tesoreria` (2): `FINANCE_BANK_VER` en true; **ninguno trae
 *    `_CATEGORIZAR` ni `_VER` del puente** (ni en false).
 *  · Noviembre de 2026: 30 egresos sin categoría ($762,621) en Bancos.
 *
 * ⚠️ No crea objetos de esquema: la compuerta de despliegue la clasifica NO_MEDIDO. Aplicarla con
 *    `apply-one-migration-prod.js` ANTES de mergear.
 *
 * Idempotente: escribe el valor, exista o no la clave (el patrón `IS NULL` fue un no-op en `[IC.23]`).
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR';
const ROLES = ['finanzas_operativo', 'tesoreria'];

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
    throw new Error(`[CB.70] ${CLAVE} quedó en ${rows[0] ? rows[0].n : 0} roles y se esperaban ${ROLES.length} (${ROLES.join(', ')})`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más: antes de esta migración, la clave no existía en estos roles. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now() WHERE role_name = ANY(?)`,
    [CLAVE, ROLES],
  );
};
