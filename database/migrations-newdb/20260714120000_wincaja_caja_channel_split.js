/**
 * W.8 - Taxonomia de CAJA via crosswalk `wincaja.caja_channels` (analisis 2026-07-14,
 * conocimiento de dominio de Edgar + verificacion en data).
 *
 * Cada caja tiene un significado de negocio. En vez de hardcodear CASE en la vista
 * (fragil, requiere migracion por caja), una tabla de crosswalk mapea
 * (source_branch, caja) -> channel + es_venta. v_sales_lines filtra es_venta=true.
 *
 * source_branch = '*' aplica a todas las sucursales; un codigo especifico overridea
 * (prioridad al match exacto). Hoy los significados son consistentes entre sucursales
 * (verificado), asi que se siembra global ('*'). Cajas NO listadas = mostrador / venta.
 *
 * Semilla (verificada en data actual):
 *   15 = preventa_vecinal (tienditas, contado)      -> VENTA
 *   70 = mayoreo_credito  (mayoristas, credito=true) -> VENTA
 *   90 = almacen (entradas/salidas/traspasos fisicos) -> no venta
 *   95 = compras (recepcion a proveedor)              -> no venta
 *   96 = compras (recepcion de traspasos)             -> no venta
 *   98 = ruta_bordo (traspaso a ruta, venta a bordo ocurre en el camion) -> no venta
 *   99 = traspaso_almacen (inter-almacen)             -> no venta
 * (fisicas 10-14/30-34/40-46/50-55/... no listadas = mostrador / VENTA por default)
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const SEED = [
  ['15', 'preventa_vecinal', true,  'Preventa vecinal (tienditas de barrio, contado)'],
  ['70', 'mayoreo_credito',  true,  'Mayoreo a credito'],
  ['90', 'almacen',          false, 'Movimientos de almacen (entradas/salidas/traspasos)'],
  ['95', 'compras',          false, 'Recepcion de compra a proveedor'],
  ['96', 'compras',          false, 'Recepcion de traspasos (compra interna)'],
  ['98', 'ruta_bordo',       false, 'Traspaso a ruta; la venta a bordo ocurre en el camion (fuera de esta base)'],
  ['99', 'traspaso_almacen', false, 'Traspaso inter-almacen'],
];

exports.up = async function (knex) {
  const has = await knex.schema.withSchema('wincaja').hasTable('caja_channels');
  if (!has) {
    await knex.raw(`
      CREATE TABLE wincaja.caja_channels (
        tenant_id     uuid    NOT NULL DEFAULT current_tenant_id(),
        source_branch text    NOT NULL DEFAULT '*',
        caja          text    NOT NULL,
        channel       text    NOT NULL,
        es_venta      boolean NOT NULL DEFAULT true,
        notes         text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, source_branch, caja)
      )
    `);
    await knex.raw(`ALTER TABLE wincaja.caja_channels ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE wincaja.caja_channels FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON wincaja.caja_channels USING (tenant_id = current_tenant_id())`);
    await knex.raw(`GRANT SELECT ON wincaja.caja_channels TO app_runtime`);
  }

  for (const [caja, channel, esVenta, notes] of SEED) {
    await knex.raw(
      `INSERT INTO wincaja.caja_channels (tenant_id, source_branch, caja, channel, es_venta, notes)
       VALUES (?, '*', ?, ?, ?, ?)
       ON CONFLICT (tenant_id, source_branch, caja)
       DO UPDATE SET channel = EXCLUDED.channel, es_venta = EXCLUDED.es_venta, notes = EXCLUDED.notes, updated_at = now()`,
      [TENANT, caja, channel, esVenta, notes],
    );
  }

  // v_sales_lines: resuelve channel/es_venta via crosswalk (match exacto de sucursal
  // gana sobre el wildcard '*'; sin fila = mostrador / venta). Excluye es_venta=false
  // (98/99/90/95/96). Mantiene el respaldo NOT EXISTS ALMAC% para traspasos en otras cajas.
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH cutoff AS (
      SELECT tenant_id, source_branch, MAX(fecha)::date AS conc_max
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
      GROUP BY tenant_id, source_branch
    )
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      m.source_dataset,
      m.fecha::date                    AS business_date,
      d.articulo                       AS sku,
      (p.sku IS NOT NULL)              AS in_kepler_catalog,
      d.cantidad_regular               AS qty,
      d.valor_venta                    AS importe,
      d.valor_costo                    AS costo,
      m.consecutivo,
      d.documento                      AS doc_ref,
      m.vendedor,
      m.tercero                        AS cliente,
      m.caja,
      m.cajero,
      COALESCE(cc.channel, 'mostrador') AS sale_channel
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON  m.tenant_id     = d.tenant_id
      AND m.source_branch = d.source_branch
      AND m.source_dataset= d.source_dataset
      AND m.consecutivo   = d.consecutivo
    LEFT JOIN cutoff c
      ON c.tenant_id = m.tenant_id AND c.source_branch = m.source_branch
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = m.tenant_id AND p.sku = d.articulo AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT k.channel, k.es_venta
      FROM wincaja.caja_channels k
      WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
        AND k.source_branch IN (m.source_branch, '*')
      ORDER BY (k.source_branch = m.source_branch) DESC
      LIMIT 1
    ) cc ON true
    WHERE d.tipo = 'V'
      AND COALESCE(m.cancelado, false) = false
      AND COALESCE(cc.es_venta, true) = true          -- excluye 98/99/90/95/96
      AND NOT EXISTS (                                  -- respaldo: traspasos ALMAC% en otras cajas
        SELECT 1 FROM wincaja.clientes cli
        WHERE cli.tenant_id = m.tenant_id AND cli.source_branch = m.source_branch
          AND cli.source_dataset = m.source_dataset AND cli.cliente = m.tercero
          AND cli.nombre ILIKE 'ALMAC%'
      )
      AND (
        m.source_dataset = 'concentrada'
        OR c.conc_max IS NULL
        OR m.fecha::date > c.conc_max
      )
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_daily WITH (security_invoker = true) AS
    SELECT
      tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku,
      SUM(qty)                          AS qty,
      SUM(importe)                      AS importe,
      SUM(costo)                        AS costo,
      SUM(importe) - SUM(costo)         AS margen,
      COUNT(DISTINCT consecutivo)       AS tickets,
      sale_channel
    FROM wincaja.v_sales_lines
    GROUP BY tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku, sale_channel
  `);
};

exports.down = async function (knex) {
  // Revertir vistas a W.5 (sin crosswalk ni sale_channel). La tabla caja_channels se deja.
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH cutoff AS (
      SELECT tenant_id, source_branch, MAX(fecha)::date AS conc_max
      FROM wincaja.maestro_mov_almacen WHERE source_dataset = 'concentrada'
      GROUP BY tenant_id, source_branch
    )
    SELECT m.tenant_id, m.source_branch, b.warehouse_code, (b.kepler_code IS NULL) AS wincaja_only,
      m.source_dataset, m.fecha::date AS business_date, d.articulo AS sku, (p.sku IS NOT NULL) AS in_kepler_catalog,
      d.cantidad_regular AS qty, d.valor_venta AS importe, d.valor_costo AS costo, m.consecutivo,
      d.documento AS doc_ref, m.vendedor, m.tercero AS cliente, m.caja, m.cajero
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m ON m.tenant_id=d.tenant_id AND m.source_branch=d.source_branch AND m.source_dataset=d.source_dataset AND m.consecutivo=d.consecutivo
    LEFT JOIN cutoff c ON c.tenant_id=m.tenant_id AND c.source_branch=m.source_branch
    LEFT JOIN wincaja.branches b ON b.tenant_id=m.tenant_id AND b.source_branch=m.source_branch
    LEFT JOIN catalog.products p ON p.tenant_id=m.tenant_id AND p.sku=d.articulo AND p.deleted_at IS NULL
    WHERE d.tipo='V' AND COALESCE(m.cancelado,false)=false
      AND NOT EXISTS (SELECT 1 FROM wincaja.clientes cli WHERE cli.tenant_id=m.tenant_id AND cli.source_branch=m.source_branch AND cli.source_dataset=m.source_dataset AND cli.cliente=m.tercero AND cli.nombre ILIKE 'ALMAC%')
      AND (m.source_dataset='concentrada' OR c.conc_max IS NULL OR m.fecha::date > c.conc_max)
  `);
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_daily WITH (security_invoker = true) AS
    SELECT tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku,
      SUM(qty) AS qty, SUM(importe) AS importe, SUM(costo) AS costo, SUM(importe)-SUM(costo) AS margen,
      COUNT(DISTINCT consecutivo) AS tickets
    FROM wincaja.v_sales_lines
    GROUP BY tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku
  `);
};
