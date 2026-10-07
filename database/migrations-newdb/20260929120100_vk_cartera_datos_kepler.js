'use strict';
/**
 * `[VK.2.1]` — La cartera VK trae TODO lo que la ficha de Kepler ya tiene, no solo nombre y crédito.
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * `analytics.v_route_cartera_erp` exponía nombre / dirección / ciudad / crédito / plazo. La ficha
 * (`kepler_ods.kdud`) tiene más, y el vendedor en campo lo necesita (domicilio para llegar,
 * teléfono para avisar). Se AGREGAN al final (CREATE OR REPLACE solo permite columnas nuevas al
 * final): estado, código postal, zona, RFC, teléfono, correo.
 *
 * ── Decode verificado (2026-09-29, prod, solo lectura, los 496 clientes de las 4 rutas) ─────
 *   kdud.c4  = calle y número   (495/496 con dato)   → ya salía como `direccion`
 *   kdud.c5  = colonia, ciudad  (484/496)            → ya salía como `ciudad`
 *   kdud.c6  = estado · c27 = CP                      → v_customer_master.estado / codigo_postal
 *   kdud.c7  = TELÉFONO  — solo 12/496 (2.4%) con dato: "3525260030", "3521254012"...
 *   kdud.c11 = CORREO    — 7/496
 *   kdud.c10 = RFC       — 35/496 reales; el resto es el genérico XAXX010101000 → se deja NULL
 *   kdud.c8/c9 vacíos en el 100% de la muestra.
 * El teléfono casi no existe en Kepler: lo sigue capturando el vendedor (dato Suite).
 *
 * NO se toca `analytics.v_customer_master`: la usan otras tres pantallas (reporte de cliente,
 * análisis semanal). Se lee `kdud` directo, con la MISMA llave (sucursal, clave).
 *
 * ⚠️ Tras CREATE OR REPLACE se re-aplica security_invoker + GRANT: no se heredan (ADR-057).
 *
 * @param { import("knex").Knex } knex
 */
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_route_cartera_erp AS
SELECT r.tenant_id,
       r.id                     AS route_id,
       r.value                  AS route,
       m.fuente_sucursal        AS erp_source_branch,
       m.cliente_code           AS erp_customer_code,
       m.nombre,
       m.direccion,
       m.ciudad,
       m.limite_credito,
       m.plazo_dias,
       m.vendedor_code          AS erp_vendor_code,
       m.vendedor_nombre        AS erp_vendor_name,
       -- [VK.2.1] nuevas, al final
       m.estado,
       m.codigo_postal,
       m.zona_nombre,
       CASE WHEN btrim(d.c10) IN ('', 'XAXX010101000', 'XAXX010101001', 'XEXX010101000') THEN NULL
            ELSE NULLIF(upper(btrim(d.c10)), '') END                        AS rfc,
       NULLIF(regexp_replace(COALESCE(d.c7, ''), '[^0-9]', '', 'g'), '')   AS telefono,
       NULLIF(lower(btrim(d.c11)), '')                                     AS email
  FROM trade.catalogs r
  JOIN analytics.v_customer_master m
    ON m.fuente_sucursal = r.erp_source_branch
   AND m.vendedor_code   = r.erp_vendor_code
  LEFT JOIN kepler_ods.kdud d
    ON d.sucursal = m.fuente_sucursal
   AND btrim(d.c2) = m.cliente_code
 WHERE r.catalog_id = 'rutas'
   AND r.deleted_at IS NULL
   AND r.erp_vendor_code IS NOT NULL
   AND NOT m.es_interno
   AND m.nombre IS NOT NULL
   AND m.nombre !~* '^\\s*(NO\\s+USAR|NO\\s+USUAR|NO\\s+TOCAR)'`;

// Definición anterior (20260928210100), para el down.
const VIEW_PREV = `
CREATE VIEW analytics.v_route_cartera_erp AS
SELECT r.tenant_id, r.id AS route_id, r.value AS route,
       m.fuente_sucursal AS erp_source_branch, m.cliente_code AS erp_customer_code,
       m.nombre, m.direccion, m.ciudad, m.limite_credito, m.plazo_dias,
       m.vendedor_code AS erp_vendor_code, m.vendedor_nombre AS erp_vendor_name
  FROM trade.catalogs r
  JOIN analytics.v_customer_master m
    ON m.fuente_sucursal = r.erp_source_branch AND m.vendedor_code = r.erp_vendor_code
 WHERE r.catalog_id = 'rutas' AND r.deleted_at IS NULL AND r.erp_vendor_code IS NOT NULL
   AND NOT m.es_interno AND m.nombre IS NOT NULL
   AND m.nombre !~* '^\\s*(NO\\s+USAR|NO\\s+USUAR|NO\\s+TOCAR)'`;

async function hardening(knex) {
  await knex.raw(`ALTER VIEW analytics.v_route_cartera_erp SET (security_invoker = on)`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_cartera_erp TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await hardening(knex);
  await knex.raw(`COMMENT ON VIEW analytics.v_route_cartera_erp IS
    'VK.2/VK.2.1 — cartera de las rutas gobernadas por Kepler: ruta Suite (trade.catalogs.erp_vendor_code) x ficha de cliente Kepler (v_customer_master.vendedor_code, misma sucursal) + kdud c7 telefono / c10 rfc (sin genérico) / c11 correo. Sin internos ni NO USAR/NO TOCAR. derive-no-copy.'`);
};

exports.down = async function down(knex) {
  // Quitar columnas exige DROP + CREATE (CREATE OR REPLACE no puede quitarlas).
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_cartera_erp`);
  await knex.raw(VIEW_PREV);
  await hardening(knex);
};
