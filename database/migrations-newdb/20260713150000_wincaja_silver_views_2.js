/**
 * W.5 (cont.) - Capa SILVER Wincaja, bloque 2: cartera / CxP / arqueo / precios.
 *
 * Saneo clave (bronze -> silver): las cuentas cuyo nombre empieza con "ALMAC"
 * (ALMACEN/ALMACEN...) NO son clientes: son cuentas internas de traspaso entre
 * sucursales (codigo = numero de otra sucursal). Inflaban la cartera a ~$1B.
 * Se marcan con is_internal para que los consumidores las excluyan.
 *
 * security_invoker=true => RLS de tablas base aplica al rol que consulta.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // v_ar_customer: cartera por cliente (saldo denormalizado + flag interno)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_ar_customer WITH (security_invoker = true) AS
    SELECT
      c.tenant_id,
      c.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)               AS wincaja_only,
      c.cliente,
      c.nombre,
      c.rfc,
      c.vendedor,
      c.territorio,
      c.saldo_mn                            AS saldo,
      c.maximo_mn                           AS limite_credito,
      c.credito,
      c.plazo,
      c.bloqueado,
      c.puntos_acumulados,
      (c.nombre ILIKE 'ALMAC%')             AS is_internal,   -- cuenta de traspaso, no cliente
      (c.maximo_mn > 0 AND c.saldo_mn > c.maximo_mn) AS sobre_limite,
      c.fecha_alta,
      c.fecha_ult_mod
    FROM wincaja.clientes c
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = c.tenant_id AND b.source_branch = c.source_branch
    WHERE c.source_dataset = 'actual'
  `);

  // v_ar_open_docs: documentos de venta con saldo abierto (aging desde el ledger)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_ar_open_docs WITH (security_invoker = true) AS
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      m.tercero                             AS cliente,
      m.documento,
      m.referencia,
      m.fecha::date                         AS fecha,
      m.fecha_vencimiento::date             AS vence,
      m.valor,
      m.saldo,
      m.vendedor,
      GREATEST(0, (CURRENT_DATE - m.fecha_vencimiento::date)) AS dias_vencido
    FROM wincaja.movimiento_clientes m
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
    WHERE m.source_dataset = 'actual'
      AND m.tipo = 'V'
      AND m.saldo > 0
      AND NOT EXISTS (
        SELECT 1 FROM wincaja.clientes cc
        WHERE cc.tenant_id = m.tenant_id AND cc.source_branch = m.source_branch
          AND cc.source_dataset = 'actual' AND cc.cliente = m.tercero
          AND cc.nombre ILIKE 'ALMAC%'
      )
  `);

  // v_ap_supplier: cuenta por pagar por proveedor
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_ap_supplier WITH (security_invoker = true) AS
    SELECT
      s.tenant_id,
      s.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)               AS wincaja_only,
      s.proveedor,
      s.nombre,
      s.rfc,
      s.saldo_mn                            AS saldo,
      s.limite_credito_mn                   AS limite_credito,
      s.tipo,
      s.fecha_alta
    FROM wincaja.proveedores s
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = s.tenant_id AND b.source_branch = s.source_branch
    WHERE s.source_dataset = 'actual'
  `);

  // v_cash_denomination: arqueo billete/moneda (unico de Wincaja, para SM).
  // denominacion = valor del billete/moneda (1..1000, estandar MX); cantidad = piezas.
  // El arqueo se ata al RETIRO (folio+caja), no al corte (verificado: folio=retiros.folio).
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_cash_denomination WITH (security_invoker = true) AS
    SELECT
      a.tenant_id,
      a.source_branch,
      b.warehouse_code,
      a.source_dataset,
      a.consecutivo                         AS arqueo_id,
      a.caja,
      a.folio,
      r.fecha::date                         AS fecha,
      r.cajero,
      r.dotacion_inicial,
      r.por_diferencia_corte,
      a.denominacion,
      a.cantidad,
      (a.denominacion * a.cantidad)         AS monto,
      (a.denominacion IN (0.5,1,2,5,10,20,50,100,200,500,1000)) AS denom_valida
    FROM wincaja.arqueos a
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = a.tenant_id AND b.source_branch = a.source_branch
    LEFT JOIN wincaja.retiros r
      ON  r.tenant_id      = a.tenant_id
      AND r.source_branch  = a.source_branch
      AND r.source_dataset = a.source_dataset
      AND r.folio          = a.folio
      AND r.caja           = a.caja
  `);

  // v_prices: precio por nivel + margen (para pricing / etiquetera / margen)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_prices WITH (security_invoker = true) AS
    SELECT
      pr.tenant_id,
      pr.source_branch,
      b.warehouse_code,
      pr.articulo                           AS sku,
      pr.no_precio                          AS nivel_precio,
      pr.precio,
      pr.margen_utilidad,
      pr.comision_vendedor,
      (p.sku IS NOT NULL)                   AS in_kepler_catalog
    FROM wincaja.precios pr
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = pr.tenant_id AND b.source_branch = pr.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = pr.tenant_id AND p.sku = pr.articulo AND p.deleted_at IS NULL
    WHERE pr.source_dataset = 'actual'
  `);

  await knex.raw(`GRANT SELECT ON wincaja.v_ar_customer, wincaja.v_ar_open_docs, wincaja.v_ap_supplier, wincaja.v_cash_denomination, wincaja.v_prices TO app_runtime`);
};

exports.down = async function (knex) {
  for (const v of ['v_ar_customer', 'v_ar_open_docs', 'v_ap_supplier', 'v_cash_denomination', 'v_prices']) {
    await knex.raw(`DROP VIEW IF EXISTS wincaja.${v}`);
  }
};
