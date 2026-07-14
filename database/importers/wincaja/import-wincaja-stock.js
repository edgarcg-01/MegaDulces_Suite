/**
 * W.5 (gold) - Feed: existencia de las sucursales CIEGAS (30/32/50) ->
 * `commercial.stock`, la tabla operativa que consumen RA/inventario/reorder.
 *
 * Mismo patron que import-kepler-stock: snapshot absoluto, ON CONFLICT DO UPDATE
 * quantity (preserva reserved_quantity), SET LOCAL app.tenant_id (RLS forzada).
 * Solo wincaja_only (30/32/50) -> warehouses que Kepler no alimenta -> aditivo,
 * cero conflicto. Solo SKUs con product_id.
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-wincaja-stock.js            # dry-run
 *   node importers/wincaja/import-wincaja-stock.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// v_stock agrega por (sku, warehouse) sumando almacenes internos de la sucursal
const SRC = `
  SELECT p.id AS product_id, w.id AS warehouse_id, GREATEST(SUM(s.existencia), 0) AS qty
  FROM wincaja.v_stock s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.code = s.warehouse_code AND w.deleted_at IS NULL
  WHERE s.tenant_id = ? AND s.wincaja_only = true AND s.existencia IS NOT NULL
    AND s.warehouse_code NOT LIKE 'RUTA-%'   -- excluir inventario de camion (W.10)
  GROUP BY p.id, w.id
`;

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);

  const [pre] = (await db.raw(`SELECT count(*)::int n, count(*) FILTER (WHERE qty>0)::int pos FROM (${SRC}) x`, [TENANT])).rows;
  console.log(`origen (30/32/50, SKU mapeable): ${pre.n} producto-almacen (${pre.pos} con existencia>0)`);

  if (!APPLY) { console.log('(dry-run - usar --apply)'); await db.destroy(); return; }

  await db.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const ins = await trx.raw(
      `INSERT INTO commercial.stock (tenant_id, warehouse_id, product_id, quantity, reserved_quantity, updated_at)
       SELECT ?, warehouse_id, product_id, qty, 0, now() FROM (${SRC}) src
       ON CONFLICT (tenant_id, warehouse_id, product_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
      [TENANT, TENANT],
    );
    console.log(`commercial.stock: ${ins.rowCount} upserts`);
  });

  const chk = (await db.raw(
    `SELECT w.code, count(*)::int n, round(sum(st.quantity)::numeric,0) q
     FROM commercial.stock st JOIN commercial.warehouses w ON w.id = st.warehouse_id
     WHERE st.tenant_id = ? AND w.code IN ('MD-30','MD-32','MD-50')
     GROUP BY 1 ORDER BY 1`, [TENANT])).rows;
  console.log('✅ commercial.stock por almacen:', chk.map((r) => `${r.code}=${r.n}(q ${Number(r.q).toLocaleString()})`).join(' '));
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
