'use strict';
/**
 * `[COT.21]` — reparte `COMMERCIAL_QUOTES_VER_ALL` («ver cotizaciones de TODOS») a `direccion`.
 *
 * Desde COT.21 cada quien ve y trabaja sólo las cotizaciones que hizo (regla de Edgar,
 * 2026-11-03: «cada usuario sólo debería ver sus propias cotizaciones… dirección general puede
 * ver todas»). La llave es lo que abre las de todos, siempre dentro de sus sucursales (COT.19).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-03) ────────────────────────────────────────
 *  · Las 4 que cotizan en Padre Hidalgo (cinthia_valle, claudia_mata, cynthia_lopez,
 *    ivette_cruz) veían y podían cancelar las de las otras: el único filtro era la sucursal.
 *  · `direccion` = guillermo_lopez y superuser, ambos con alcance `televenta:all`.
 *  · ⛔ No se decide por el modo de alcance `all`: claudia_mata (supervisor) tiene `*:all` por
 *    una regla puesta para otros módulos, y habría seguido viendo las de todos.
 *  · `superadmin` entra por god-mode (como en `RolesGuard`); va en `true` para que /admin/roles
 *    diga la verdad. ⚠️ Eso incluye a los jefes de zona con rol `superadmin` (aaron_alejo,
 *    ivette_cruz, ramon_rodriguez): ven las de todos, pero sólo de las sucursales de su zona.
 *
 * Los demás roles vivos reciben la clave en `false` explícito (sin la clave, /admin/roles no la
 * muestra y nadie la puede conceder). Los `retirado_*` quedan fuera.
 *
 * ⚠️ Sólo hace UPDATE sobre `role_permissions`: la compuerta del despliegue la clasifica
 *    NO_MEDIDO. Aplicala con `apply-one-migration-prod.js` ANTES de soltar el código: si el
 *    código llega primero, Dirección ve sólo las suyas hasta que se aplique (falla cerrada, no
 *    abierta). Permisos frescos por request (`RolesGuard`): no hace falta re-login.
 *
 * Idempotente por `-> 'KEY' IS NULL`.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'COMMERCIAL_QUOTES_VER_ALL';
const ROLES = ['direccion', 'superadmin'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, (role_name = ANY(?::text[])))
      WHERE permissions -> ?::text IS NULL
        AND role_name NOT LIKE 'retirado_%'`,
    [KEY, ROLES, KEY],
  );
  const { rows } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' ORDER BY 1`,
    [KEY],
  );
  console.log(`[cot21_quotes_ver_all_direccion] ${KEY}: ${res.rowCount ?? 0} filas · en true: ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  if (!rows.length) {
    throw new Error(`Ningún rol (fuera de superadmin) quedó con ${KEY}: Dirección no vería las de todos (regla 20)`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la clave es nueva, nadie la tenía antes. */
exports.down = async function down(knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`, [KEY, KEY]);
};
