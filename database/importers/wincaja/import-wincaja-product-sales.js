/**
 * W (gold) — Feed: venta por PRODUCTO de las tiendas CIEGAS Wincaja (30/32/50) →
 * `analytics.product_sales_monthly` + `analytics.product_sales_daily`, las tablas
 * que consume /comercial/salidas (Fase SAL). Hoy esas tablas solo traen Kepler
 * (01-05) → 30/32/50 quedaban invisibles en Salidas.
 *
 * NO relee el silver: deriva de `analytics.sales_daily` (canal 'wincaja', que ya
 * tiene product_id×warehouse×día). Solo tiendas (channel LIKE 'wincaja%'); las RUTAS
 * (channel='wincaja_ruta') se EXCLUYEN por decisión de negocio (Salidas es
 * producto×sucursal con existencia; el camión no tiene stock). Aditivo: Kepler no
 * alimenta 30/32/50 → cero doble conteo. Idempotente: DELETE de esas warehouses +
 * INSERT (reload full). analytics.* sin RLS (filtro tenant explícito). Owner.
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-wincaja-product-sales.js            # dry-run
 *   node importers/wincaja/import-wincaja-product-sales.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const STORES = ['MD-30', 'MD-32', 'MD-50'];

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);

  try {
    const whs = await db('commercial.warehouses').where({ tenant_id: TENANT }).whereIn('code', STORES).whereNull('deleted_at').select('id', 'code');
    const ids = whs.map((w) => w.id);
    console.log(`\n=== VENTA POR PRODUCTO Wincaja (30/32/50) → product_sales_monthly/daily (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  warehouses: ${whs.map((w) => w.code).join(', ') || '(ninguna — ¿migración MD-30/50?)'}`);
    if (!ids.length) { await db.destroy(); return; }

    const [pre] = (await db.raw(
      `SELECT count(*)::int rows, count(distinct product_id)::int prods, coalesce(round(sum(units)::numeric,0),0) u
       FROM analytics.sales_daily WHERE tenant_id=? AND channel LIKE 'wincaja%' AND warehouse_id = ANY(?)`, [TENANT, ids])).rows;
    console.log(`  origen (sales_daily canal wincaja): ${pre.rows} filas prod×almacén×día, ${pre.prods} productos, ${Number(pre.u).toLocaleString()} unidades`);

    if (!APPLY) { console.log('(dry-run — usar --apply)'); await db.destroy(); return; }

    await db.transaction(async (trx) => {
      const dM = await trx('analytics.product_sales_monthly').where({ tenant_id: TENANT }).whereIn('warehouse_id', ids).del();
      const iM = await trx.raw(
        `INSERT INTO analytics.product_sales_monthly (tenant_id, product_id, warehouse_id, month, units, updated_at)
         SELECT ?, product_id, warehouse_id, date_trunc('month', sale_date)::date, sum(units), now()
         FROM analytics.sales_daily WHERE tenant_id=? AND channel LIKE 'wincaja%' AND warehouse_id = ANY(?)
         GROUP BY product_id, warehouse_id, date_trunc('month', sale_date)`, [TENANT, TENANT, ids]);
      console.log(`  product_sales_monthly: -${dM} +${iM.rowCount}`);

      const dD = await trx('analytics.product_sales_daily').where({ tenant_id: TENANT }).whereIn('warehouse_id', ids).del();
      const iD = await trx.raw(
        `INSERT INTO analytics.product_sales_daily (tenant_id, product_id, warehouse_id, sale_date, units, updated_at)
         SELECT ?, product_id, warehouse_id, sale_date, sum(units), now()
         FROM analytics.sales_daily WHERE tenant_id=? AND channel LIKE 'wincaja%' AND warehouse_id = ANY(?)
         GROUP BY product_id, warehouse_id, sale_date`, [TENANT, TENANT, ids]);
      console.log(`  product_sales_daily:   -${dD} +${iD.rowCount}`);
    });

    const chk = (await db.raw(
      `SELECT w.code, count(*)::int filas, count(distinct m.product_id)::int prods, round(sum(m.units)::numeric,0) u
       FROM analytics.product_sales_monthly m JOIN commercial.warehouses w ON w.id=m.warehouse_id
       WHERE m.tenant_id=? AND w.code = ANY(?) GROUP BY 1 ORDER BY 1`, [TENANT, STORES])).rows;
    console.log('✅ product_sales_monthly Wincaja:');
    for (const r of chk) console.log(`   ${r.code}: ${r.prods} productos, ${r.filas} filas, ${Number(r.u).toLocaleString()} u`);
    await db.destroy();
  } catch (e) {
    console.error('\nERROR:', e.message);
    await db.destroy();
    process.exit(1);
  }
})();
