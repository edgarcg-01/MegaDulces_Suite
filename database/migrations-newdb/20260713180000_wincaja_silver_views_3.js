/**
 * W.5 (cont.) - Capa SILVER Wincaja, bloque 3: demanda perdida + auditoria caja.
 *   v_lost_demand      (U6): faltantes de cotizacion normalizados -> insumo RA.
 *   v_cash_authorizations (U12): overrides de supervisor con nombres -> SM/prevencion.
 *
 * security_invoker=true => RLS de tablas base aplica.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // U6: demanda insatisfecha (lo que el cliente pidio y no habia)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_lost_demand WITH (security_invoker = true) AS
    SELECT
      f.tenant_id,
      f.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      f.source_dataset,
      f.fecha::date                    AS business_date,
      f.articulo                       AS sku,
      (p.sku IS NOT NULL)              AS in_kepler_catalog,
      f.cantidad_regular               AS qty_faltante,
      f.valor_venta                    AS importe_perdido,
      f.cliente,
      f.vendedor,
      f.almacen
    FROM wincaja.faltantes_cotizacion f
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = f.tenant_id AND b.source_branch = f.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = f.tenant_id AND p.sku = f.articulo AND p.deleted_at IS NULL
  `);

  // U12: autorizaciones/overrides de supervisor en caja (con nombres)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_cash_authorizations WITH (security_invoker = true) AS
    SELECT
      a.tenant_id,
      a.source_branch,
      b.warehouse_code,
      a.source_dataset,
      a.fecha::date                    AS business_date,
      a.hora,
      a.caja,
      a.autorizo,
      ca.nombre                        AS autorizo_nombre,
      a.cajero,
      cc.nombre                        AS cajero_nombre,
      a.referencia
    FROM wincaja.autorizaciones a
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = a.tenant_id AND b.source_branch = a.source_branch
    LEFT JOIN wincaja.cajeros ca
      ON ca.tenant_id = a.tenant_id AND ca.source_branch = a.source_branch
      AND ca.source_dataset = a.source_dataset AND ca.cajero = a.autorizo
    LEFT JOIN wincaja.cajeros cc
      ON cc.tenant_id = a.tenant_id AND cc.source_branch = a.source_branch
      AND cc.source_dataset = a.source_dataset AND cc.cajero = a.cajero
  `);

  await knex.raw(`GRANT SELECT ON wincaja.v_lost_demand, wincaja.v_cash_authorizations TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS wincaja.v_lost_demand`);
  await knex.raw(`DROP VIEW IF EXISTS wincaja.v_cash_authorizations`);
};
