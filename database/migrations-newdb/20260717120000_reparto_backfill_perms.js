/**
 * Reparto / Última Milla (ADR-027) — backfill de los permisos propios del módulo.
 *
 * El módulo Reparto dejó de tomar prestados COMMERCIAL_ORDERS_* / COMMERCIAL_PAYMENTS_* /
 * LOGISTICS_* : ahora sus endpoints piden REPARTO_DESPACHAR (persona de tienda que
 * asigna) o REPARTO_ENTREGAR (repartidor que entrega y cobra). Para que nadie pierda
 * acceso, cada rol recibe el permiso derivado del que lo gateaba:
 *
 *   - REPARTO_DESPACHAR ← LOGISTICS_HOME_DISPATCH (era el permiso de despacho de tienda).
 *   - REPARTO_ENTREGAR  ← role_name = 'repartidor' (único rol repartidor canónico; el
 *       endpoint viejo pedía ORDERS_FULFILL+PAYMENTS_REGISTRAR, que muchos roles tienen,
 *       por eso derivamos por ROL y no por esos permisos: evita clasificar a un vendedor
 *       o encargado como repartidor). Roles repartidor custom se togglean en /admin/roles.
 *
 * Idempotente: cada clave se escribe sólo si aún no existe (`-> 'KEY' IS NULL`).
 * Aditivo: NO borra LOGISTICS_HOME_DISPATCH ni los ORDERS_*/PAYMENTS_* viejos (se
 * retiran en la limpieza F4). Los permisos viajan en el JWT → re-login para el gating
 * de UI; la autz backend es fresca (cache 30s).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  let total = 0;

  // REPARTO_DESPACHAR ← LOGISTICS_HOME_DISPATCH (1:1).
  const despachar = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(
          'REPARTO_DESPACHAR', COALESCE((permissions->>'LOGISTICS_HOME_DISPATCH')::boolean, false))
      WHERE permissions -> 'REPARTO_DESPACHAR' IS NULL`,
  );
  total += despachar.rowCount ?? 0;

  // REPARTO_ENTREGAR ← role_name = 'repartidor'.
  const entregar = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(
          'REPARTO_ENTREGAR', role_name = 'repartidor')
      WHERE permissions -> 'REPARTO_ENTREGAR' IS NULL`,
  );
  total += entregar.rowCount ?? 0;

  console.log(`[reparto_backfill_perms] up: filas actualizadas = ${total}`);
};

/**
 * Revierte: quita las 2 claves REPARTO del JSONB de todos los roles. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  for (const k of ['REPARTO_DESPACHAR', 'REPARTO_ENTREGAR']) {
    await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions - :k::text
        WHERE permissions -> :k::text IS NOT NULL`,
      { k },
    );
  }
  console.log('[reparto_backfill_perms] down: claves REPARTO removidas');
};
