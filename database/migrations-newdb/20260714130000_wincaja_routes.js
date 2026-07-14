/**
 * W.9 - Rutas de reparto (venta a bordo) como source_branch propios en wincaja.*.
 *
 * Cada .mdb "<n> RUTA <code>" es una base Wincaja completa con la venta REAL al
 * cliente final (el almacen madre traspasa via caja 98; la venta a bordo vive en la
 * ruta). Antes se excluian. Ahora se importan con source_branch = code de ruta.
 *
 * - branches += parent_branch (sucursal madre) + is_route.
 * - Semilla de las 13 rutas (mapeo por prefijo de archivo + terceros de caja 98):
 *     suc 10 -> 21,22,23,26,27,28 ; suc 32 -> 321,322 ; suc 50 -> 501..505
 * - v_sales_lines: la venta de una ruta se etiqueta sale_channel='ruta_venta'
 *   (venta a bordo), distinta de mostrador. warehouse_code NULL => NO fluye al gold
 *   (analytics/stock) hasta decidir la atribucion; queda en bronze+silver para analisis.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const ROUTES = [
  ['21', '10'], ['22', '10'], ['23', '10'], ['26', '10'], ['27', '10'], ['28', '10'],
  ['321', '32'], ['322', '32'],
  ['501', '50'], ['502', '50'], ['503', '50'], ['504', '50'], ['505', '50'],
];

exports.up = async function (knex) {
  const hasParent = await knex.schema.withSchema('wincaja').hasColumn('branches', 'parent_branch');
  if (!hasParent) {
    await knex.schema.withSchema('wincaja').alterTable('branches', (t) => {
      t.text('parent_branch');
      t.boolean('is_route').notNullable().defaultTo(false);
    });
  }

  for (const [code, parent] of ROUTES) {
    await knex.raw(
      `INSERT INTO wincaja.branches (tenant_id, source_branch, branch_name, kepler_code, warehouse_code, status, notes, parent_branch, is_route)
       VALUES (?, ?, ?, NULL, NULL, 'route', ?, ?, true)
       ON CONFLICT (tenant_id, source_branch)
       DO UPDATE SET branch_name = EXCLUDED.branch_name, status = 'route', parent_branch = EXCLUDED.parent_branch, is_route = true`,
      [TENANT, code, `RUTA ${code}`, `Ruta de reparto de la sucursal ${parent} (venta a bordo)`, parent],
    );
  }

  // v_sales_lines: agrega tag 'ruta_venta' para is_route (venta a bordo).
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
      CASE WHEN b.is_route THEN 'ruta_venta'
           ELSE COALESCE(cc.channel, 'mostrador') END AS sale_channel
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
      AND COALESCE(cc.es_venta, true) = true
      AND NOT EXISTS (
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
};

exports.down = async function (knex) {
  await knex.raw(`DELETE FROM wincaja.branches WHERE tenant_id = ? AND is_route = true`, [TENANT]);
  // Las columnas parent_branch/is_route se dejan (no destructivo). La vista queda con
  // el tag ruta_venta (inerte sin rutas). Para revertir la vista, correr W.8.down.
};
