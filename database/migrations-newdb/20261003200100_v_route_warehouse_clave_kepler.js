'use strict';
/**
 * `[VK.8]` — La clave de ruta (`route_key`) sale del CÓDIGO KEPLER cuando la ruta está ligada.
 *
 * `analytics.v_route_warehouse` ([JZ.2]) deriva `route_key` del NOMBRE de la ruta
 * (`upper`, sólo A-Z0-9, sin el prefijo RUTA), y esa clave es la que guarda el arqueo de rutas
 * (`reconciliation.blind_counts.route_code`, tipos rd/rv — SM.36).
 *
 * Con [VK.8] las vecinales se nombran "<código Kepler> <EJECUTIVO>" y el nombre CAMBIA cuando
 * cambia el ejecutivo. Si la clave siguiera saliendo del nombre, cada cambio de ejecutivo partiría
 * el historial de arqueos de esa ruta en dos. Ahora:
 *
 *   ruta ligada a Kepler   → route_key = código Kepler       ("1V001", fijo)
 *   ruta sin liga          → route_key = la de siempre       ("21", "501", ...)
 *
 * Medido en prod (2026-10-03): 0 arqueos rd/rv guardados → no hay historia que migrar. Y de paso
 * se deshace un choque real: "Ruta Vecinal #1" (Madero) y "Ruta vecinal 1" (Abastos) daban las
 * dos `VECINAL1` y la vista las marcaba `ambigua`.
 *
 * Mismas columnas y en el mismo orden (CREATE OR REPLACE lo exige). ⚠️ Tras un CREATE OR REPLACE
 * se re-aplican `security_invoker` y el GRANT: no se heredan (ADR-057).
 *
 * @param { import("knex").Knex } knex
 */
const VISTA = 'analytics.v_route_warehouse';

const CLAVE = (col) =>
  `regexp_replace(regexp_replace(upper(${col}), '[^A-Z0-9]', '', 'g'), '^RUTA', '')`;

const view = (routeKeyExpr) => `
  CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS
  WITH cat AS (
    SELECT
      c.tenant_id,
      c.id            AS route_catalog_id,
      c.value         AS route_label,
      c.parent_id     AS zona_id,
      z.name          AS zona_name,
      ${routeKeyExpr} AS route_key
    FROM trade.catalogs c
    JOIN trade.zones z
      ON z.id = c.parent_id
     AND z.tenant_id = c.tenant_id
     AND z.activo
     AND z.deleted_at IS NULL
    WHERE c.catalog_id = 'rutas'
      AND c.activo
      AND c.deleted_at IS NULL
  ),
  choque AS (
    SELECT tenant_id, route_key
    FROM cat
    GROUP BY 1, 2
    HAVING count(DISTINCT zona_id) > 1
  ),
  alm AS (
    SELECT
      w.tenant_id,
      w.id   AS warehouse_id,
      w.code AS warehouse_code,
      w.name AS warehouse_name,
      ${CLAVE('w.code')} AS route_key
    FROM commercial.warehouses w
    WHERE w.deleted_at IS NULL
      AND w.code LIKE 'RUTA-%'
  )
  SELECT
    cat.tenant_id,
    cat.route_key,
    cat.route_catalog_id,
    cat.route_label,
    cat.zona_id,
    cat.zona_name,
    alm.warehouse_id,
    alm.warehouse_code,
    alm.warehouse_name,
    (alm.warehouse_id IS NULL)   AS sin_almacen,
    (ch.route_key IS NOT NULL)   AS ambigua
  FROM cat
  LEFT JOIN alm
    ON alm.route_key = cat.route_key AND alm.tenant_id = cat.tenant_id
  LEFT JOIN choque ch
    ON ch.route_key = cat.route_key AND ch.tenant_id = cat.tenant_id`;

exports.up = async function up(knex) {
  await knex.raw(view(CLAVE('COALESCE(c.erp_vendor_code, c.value)')));
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.raw(view(CLAVE('c.value')));
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};
