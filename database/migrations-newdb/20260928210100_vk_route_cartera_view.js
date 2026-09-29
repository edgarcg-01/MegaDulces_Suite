'use strict';
/**
 * `[VK.2]` — La cartera de una ruta gobernada por Kepler, DERIVADA del ODS.
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * Una fila por (ruta Suite, cliente Kepler): los clientes cuya FICHA en Kepler (`kdud.c12`) dice
 * que su vendedor es el vendedor Kepler ligado a la ruta (`trade.catalogs.erp_vendor_code`), leídos
 * de la MISMA sucursal (`erp_source_branch`). Vista `derive-no-copy` sobre
 * `analytics.v_customer_master` ([TDA.A4]): cero importers, la frescura es la del CDC.
 *
 * ── Verificado antes de escribirla (2026-09-28, prod, solo lectura) ─────────────────────────
 * La ficha como fuente de "quién es de qué ruta", contra un hecho independiente (quién le vendió
 * en 60 días, `kdm1.c12`): 351 de 368 compradores (95.4%) coinciden. Y contra las capturas del
 * ERP (CxcVenAvtPag, sept-2026): Yurécuaro 11/11, PH 01 18/18, PH 02 17/17.
 *
 * ── Filtros ──────────────────────────────────────────────────────────────────────────────────
 *  · `es_interno` fuera: pisos de venta y cuentas de la propia tienda NO son clientes a visitar.
 *  · Nombres "NO USAR" / "NO TOCAR" fuera: es el personal defendiéndose de la colisión de claves.
 *
 * `security_invoker`: el tenant lo pone el RLS forzado de `trade.catalogs` (kepler_ods no trae
 * tenant). ⚠️ Tras cualquier CREATE OR REPLACE de esta vista, re-aplicar security_invoker y el
 * GRANT: no se heredan (ADR-057).
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
       m.vendedor_nombre        AS erp_vendor_name
  FROM trade.catalogs r
  JOIN analytics.v_customer_master m
    ON m.fuente_sucursal = r.erp_source_branch
   AND m.vendedor_code   = r.erp_vendor_code
 WHERE r.catalog_id = 'rutas'
   AND r.deleted_at IS NULL
   AND r.erp_vendor_code IS NOT NULL
   AND NOT m.es_interno
   AND m.nombre IS NOT NULL
   AND m.nombre !~* '^\\s*(NO\\s+USAR|NO\\s+USUAR|NO\\s+TOCAR)'`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw(`ALTER VIEW analytics.v_route_cartera_erp SET (security_invoker = on)`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_cartera_erp TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_route_cartera_erp IS
    'VK.2 — cartera de las rutas gobernadas por Kepler: ruta Suite (trade.catalogs.erp_vendor_code) x ficha de cliente Kepler (v_customer_master.vendedor_code, misma sucursal). Sin internos ni NO USAR/NO TOCAR. derive-no-copy. Verificada 95.4% contra kdm1 (quién les vende) y 46/46 contra capturas del ERP.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_cartera_erp`);
};
