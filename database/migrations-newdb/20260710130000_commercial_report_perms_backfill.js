/**
 * Split de COMMERCIAL_ANALYTICS_VER en permisos dedicados por REPORTE, para
 * poder acotar un rol a un solo reporte (como Auxiliar_mercadotecnia → sell-out).
 *
 * Nuevos permisos (VER read-only), cada uno gatea su página + endpoints:
 *   COMMERCIAL_SALIDAS_VER        → /comercial/salidas          (salidas, salidas.xlsx)
 *   COMMERCIAL_ROUTE_SALES_VER    → /comercial/ventas-por-ruta  (sales-by-route[.xlsx])
 *   COMMERCIAL_CUSTOMERS360_VER   → /comercial/customers-360    (erp-customers[/:code/products])
 *   COMMERCIAL_HISTORICAL_VER     → /comercial/historical       (historical/*)
 *   COMMERCIAL_DEADSTOCK_VER      → /almacen/dead-stock         (dead-stock)
 *   COMMERCIAL_INVHEALTH_VER      → /almacen/inventory-health   (inventory-health)
 *
 * Traspasos NO entra aquí: reusa el permiso existente LOGISTICS_TRANSFERS_VER (su
 * ruta ya lo exigía; el endpoint /analytics/transfers se alineó a él). Los roles
 * que ya usaban transfers ya tienen esa clave → sin regresión, sin backfill.
 *
 * Backfill (no-regresión): estos 6 reportes vivían bajo COMMERCIAL_ANALYTICS_VER,
 * así que todo rol con ANALYTICS_VER=true recibe los 6 en true; el resto en false.
 * Command Center + endpoints agregados (overview, network, top-N, erp-promos, shipments)
 * siguen bajo COMMERCIAL_ANALYTICS_VER.
 *
 * Idempotente: sólo escribe si la clave no existe (`-> 'KEY' IS NULL`, NO el
 * operador `?` que knex no escapa). Frontend gatea por JWT → re-login requerido.
 *
 * @param { import("knex").Knex } knex
 */
const ANCHOR = 'COMMERCIAL_ANALYTICS_VER';
const KEYS = [
  'COMMERCIAL_SALIDAS_VER',
  'COMMERCIAL_ROUTE_SALES_VER',
  'COMMERCIAL_CUSTOMERS360_VER',
  'COMMERCIAL_HISTORICAL_VER',
  'COMMERCIAL_DEADSTOCK_VER',
  'COMMERCIAL_INVHEALTH_VER',
];

exports.up = async function (knex) {
  for (const key of KEYS) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                COALESCE((permissions->>'${ANCHOR}')::boolean, false))
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[report_perms_backfill] up ${key} (← ${ANCHOR}): filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of KEYS) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`,
    );
  }
  console.log('[report_perms_backfill] down: claves removidas');
};
