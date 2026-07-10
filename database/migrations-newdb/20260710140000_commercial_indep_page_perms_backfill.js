/**
 * Permisos dedicados para 2 páginas INDEPENDIENTES que estaban bajo un permiso
 * compartido (mismo patrón que el split de reportes, solo las páginas cuyos
 * endpoints NO se comparten con hermanas → cero riesgo de 403):
 *
 *   COMMERCIAL_ERP_PROMOS_VER   → /comercial/erp-promos  (endpoint analytics/erp-promotions)
 *   COMMERCIAL_VENDOR_SALES_VER → /comercial/vendor-sales (endpoints commercial/vendor-sales/reports/*)
 *
 * Backfill no-regresión:
 *   - VENDOR_SALES_VER ← ROUTE_CONTROL_VER (ruta y endpoints ya lo exigían).
 *   - ERP_PROMOS_VER ← (COMMERCIAL_PROMOTIONS_VER AND COMMERCIAL_ANALYTICS_VER):
 *     antes la ruta pedía PROMOTIONS_VER y el endpoint erp-promotions pedía
 *     ANALYTICS_VER, así que solo quien tenía AMBOS podía usar la página.
 *
 * Idempotente: sólo escribe si la clave no existe (`-> 'KEY' IS NULL`).
 * Frontend gatea por JWT → re-login requerido.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const vs = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('COMMERCIAL_VENDOR_SALES_VER',
              COALESCE((permissions->>'ROUTE_CONTROL_VER')::boolean, false))
      WHERE permissions -> 'COMMERCIAL_VENDOR_SALES_VER' IS NULL`,
  );
  console.log(`[indep_page_perms_backfill] up VENDOR_SALES (← ROUTE_CONTROL_VER): filas = ${vs.rowCount ?? 0}`);

  const ep = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('COMMERCIAL_ERP_PROMOS_VER',
              COALESCE((permissions->>'COMMERCIAL_PROMOTIONS_VER')::boolean, false)
              AND COALESCE((permissions->>'COMMERCIAL_ANALYTICS_VER')::boolean, false))
      WHERE permissions -> 'COMMERCIAL_ERP_PROMOS_VER' IS NULL`,
  );
  console.log(`[indep_page_perms_backfill] up ERP_PROMOS (← PROMOTIONS_VER AND ANALYTICS_VER): filas = ${ep.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of ['COMMERCIAL_VENDOR_SALES_VER', 'COMMERCIAL_ERP_PROMOS_VER']) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`,
    );
  }
  console.log('[indep_page_perms_backfill] down: claves removidas');
};
