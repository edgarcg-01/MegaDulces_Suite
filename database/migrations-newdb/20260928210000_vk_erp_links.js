'use strict';
/**
 * `[VK.1]` + `[VK.3]` — Ligas con Kepler para que la cartera del vendedor la gobierne el ERP.
 * Plan: docs/IMPLEMENTACION/FASES/FASE_VK_CARTERA_KEPLER.md
 *
 * ── 1. Ruta de la Suite ↔ vendedor Kepler (`trade.catalogs`, catalog_id='rutas') ─────────────
 * Una ruta de la Suite no sabía de qué vendedor Kepler es. Se le agrega (sucursal, código):
 * `('02','1V003')` = RUTA VECINAL ABASTOS LP. La cartera de esa ruta pasa a ser la de la ficha
 * de clientes de Kepler (`kdud.c12`), verificada 95.4% contra quién les vende de verdad.
 *
 * ⚠️ La llave es (sucursal, código), NUNCA el código solo: Kepler reusa códigos entre sucursales
 * para personas distintas (ver 20260903120000_vendor_identity_kepler.js).
 *
 * ── 2. Cliente de la Suite ↔ cliente Kepler (`commercial.customers`) ────────────────────────
 * `commercial.customers` sigue siendo el ancla de 16 FKs (pedidos, visitas, pagos...). Una fila
 * ligada a Kepler guarda lo PROPIO (GPS, orden de visita, WhatsApp); nombre, ruta y crédito los
 * refresca el servicio desde `analytics.v_route_cartera_erp` cada vez que se abre la ruta.
 *
 * ⚠️ La clave de cliente Kepler es POR SUCURSAL (141 de 1,574 claves son un cliente distinto según
 * la plaza — ver 20260920130000_v_customer_master.js). Por eso la liga es (sucursal, clave).
 *
 * `public.catalogs` es una vista con columnas explícitas: NO expone las columnas nuevas. El código
 * que las necesita lee `trade.catalogs`.
 *
 * Idempotente (hasColumn + IF NOT EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  // ── 1. trade.catalogs ──
  if (!(await knex.schema.withSchema('trade').hasColumn('catalogs', 'erp_source_branch'))) {
    await knex.raw(`ALTER TABLE trade.catalogs ADD COLUMN erp_source_branch varchar(4)`);
  }
  if (!(await knex.schema.withSchema('trade').hasColumn('catalogs', 'erp_vendor_code'))) {
    await knex.raw(`ALTER TABLE trade.catalogs ADD COLUMN erp_vendor_code varchar(20)`);
  }
  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_erp_vendor_pair_ck`);
  await knex.raw(`
    ALTER TABLE trade.catalogs ADD CONSTRAINT catalogs_erp_vendor_pair_ck
      CHECK ((erp_source_branch IS NULL) = (erp_vendor_code IS NULL))`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_catalogs_route_erp_vendor
      ON trade.catalogs (tenant_id, erp_source_branch, erp_vendor_code)
      WHERE erp_vendor_code IS NOT NULL AND deleted_at IS NULL`);
  await knex.raw(`COMMENT ON COLUMN trade.catalogs.erp_vendor_code IS
    'VK.1 — solo rutas: código de vendedor Kepler (kduv.c2 / kdud.c12) cuya cartera ES la de esta ruta. Con erp_source_branch. NULL = ruta manual (cartera por customers.sales_route).'`);

  // ── 2. commercial.customers ──
  if (!(await knex.schema.withSchema('commercial').hasColumn('customers', 'erp_source_branch'))) {
    await knex.raw(`ALTER TABLE commercial.customers ADD COLUMN erp_source_branch varchar(4)`);
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('customers', 'erp_customer_code'))) {
    await knex.raw(`ALTER TABLE commercial.customers ADD COLUMN erp_customer_code varchar(20)`);
  }
  await knex.raw(`ALTER TABLE commercial.customers DROP CONSTRAINT IF EXISTS customers_erp_pair_ck`);
  await knex.raw(`
    ALTER TABLE commercial.customers ADD CONSTRAINT customers_erp_pair_ck
      CHECK ((erp_source_branch IS NULL) = (erp_customer_code IS NULL))`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_erp_link
      ON commercial.customers (tenant_id, erp_source_branch, erp_customer_code)
      WHERE erp_customer_code IS NOT NULL AND deleted_at IS NULL`);
  await knex.raw(`COMMENT ON COLUMN commercial.customers.erp_customer_code IS
    'VK.3 — cliente Kepler (kdud.c2) que esta fila ancla, con erp_source_branch. Si no es NULL, nombre/ruta/crédito los gobierna Kepler (se refrescan al abrir la ruta); la fila solo guarda lo propio (GPS, orden, WhatsApp).'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_customers_erp_link`);
  await knex.raw(`ALTER TABLE commercial.customers DROP CONSTRAINT IF EXISTS customers_erp_pair_ck`);
  await knex.raw(`ALTER TABLE commercial.customers DROP COLUMN IF EXISTS erp_customer_code`);
  await knex.raw(`ALTER TABLE commercial.customers DROP COLUMN IF EXISTS erp_source_branch`);
  await knex.raw(`DROP INDEX IF EXISTS trade.ux_catalogs_route_erp_vendor`);
  await knex.raw(`ALTER TABLE trade.catalogs DROP CONSTRAINT IF EXISTS catalogs_erp_vendor_pair_ck`);
  await knex.raw(`ALTER TABLE trade.catalogs DROP COLUMN IF EXISTS erp_vendor_code`);
  await knex.raw(`ALTER TABLE trade.catalogs DROP COLUMN IF EXISTS erp_source_branch`);
};
