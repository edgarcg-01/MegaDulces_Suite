/**
 * `[DM.18]` — **El mapa `TI### → sucursal` lo DICE Kepler; dejamos de adivinarlo.**
 *
 * ── QUÉ REEMPLAZA ───────────────────────────────────────────────────────────────────────────
 * `analytics.transfer_dest_map.warehouse_id` se poblaba por INFERENCIA: el auto-ligado
 * `[DM.11d]` pareaba envío con recepción por folio+serie dentro de 15 días y se quedaba con el
 * almacén que más ganara. Esa heurística ya falló dos veces y las dos costaron dinero:
 *
 *   · `[DM.11e]` — `TI000 "CENTRO DE DISTRIBUCIÓN (CEDIS)" → 8ESQ` con **13% de evidencia**
 *     (2 pareos sobre 15 envíos): 15 docs · 5,476 pz · $123,454.08. Se le puso umbral del 60%.
 *   · `[DM.15]` — `TI009 "SUCURSAL MORELIA MADERO" → MD-32`, el almacén **Wincaja borrado** de
 *     esa tienda, mientras quien recibe es el Kepler `07`. El umbral no lo veía porque los dos
 *     almacenes se llaman igual: son la misma tienda en dos ERP.
 *
 * ⭐ **El catálogo existía en el ERP todo este tiempo.** `md.pv_suc_ip` (en el POS de cada
 * sucursal, y ya replicada al ODS por el carril espejo) trae el mapa completo y explícito:
 *
 *     00 TI000 Cedis Oficinas          05 TI007 Sucursal Zamora Centro
 *     01 TI001 Sucursal Hidalgo        06 TI006 Sucursal Canindo
 *     02 TI008 Sucursal La Piedad      07 TI009 Sucursal Morelia Madero
 *     03 TI002 Sucursal 8 Esquinas     08 TI004 Sucursal Morelia Abastos
 *     04 TI003 Sucursal Yurecuaro      SC  —    Sistema Concentrador
 *
 * Y **confirma la corrección de `[DM.15]`** (`TI009 → 07`), que hasta hoy se sostenía sobre
 * evidencia de recepción (91.2%) y ahora se sostiene sobre el catálogo del propio ERP.
 *
 * ── POR QUÉ VISTA Y NO IMPORTER ─────────────────────────────────────────────────────────────
 * La regla principal del proyecto: el dato sale del ODS, derivado, sin copiarlo. `pv_suc_ip` ya
 * está en `kepler_ods` (90 filas = 9 ramas × 10), así que esto es `derive-no-copy` puro: ninguna
 * tabla nueva, ningún script que agendar.
 *
 * ── EL CONSENSO SE MIDE, NO SE ASUME ────────────────────────────────────────────────────────
 * Cada POS guarda SU copia del catálogo, así que son 9 copias que podrían divergir. Medido el
 * 2026-10-01: las **9 ramas coinciden en los 9 códigos** (`sucursales_distintas = 1` en todos).
 * Pero eso es una medición con fecha, no una propiedad: la vista publica `ramas_que_lo_declaran`
 * y `es_consistente` POR FILA, y un consumidor que encuentre `es_consistente = false` tiene que
 * declarar, no elegir. Una copia que diverge sin avisar es exactamente cómo nacieron los dos
 * bugs de arriba.
 *
 * ⚠️ El join a `commercial.warehouses` exige `deleted_at IS NULL` — la lección de `[DM.15]`:
 * un almacén retirado no puede ser destino de nada.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_branch_catalog
      WITH (security_invoker = true) AS
    WITH consenso AS (
      -- Una fila por código TI, con cuántas de las 9 copias lo declaran y si coinciden.
      SELECT c7 AS dest_code,
             min(c1)                  AS suc_code,
             min(c2)                  AS nombre,
             count(*)::int            AS ramas_que_lo_declaran,
             (count(DISTINCT c1) = 1) AS es_consistente
        FROM kepler_ods.pv_suc_ip
       WHERE COALESCE(c7, '') <> ''
       GROUP BY c7
    )
    SELECT w.tenant_id,
           c.dest_code,
           c.suc_code,
           c.nombre,
           w.id   AS warehouse_id,
           w.code AS warehouse_code,
           c.ramas_que_lo_declaran,
           c.es_consistente
      FROM consenso c
      JOIN commercial.warehouses w
        ON w.kepler_code = c.suc_code
       AND w.deleted_at IS NULL`);

  await knex.raw(`GRANT SELECT ON analytics.v_erp_branch_catalog TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_erp_branch_catalog`);
};
