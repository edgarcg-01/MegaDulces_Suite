/**
 * W (gold) — Feed: venta por PRODUCTO de las tiendas CIEGAS Wincaja (30/32/50) →
 * `analytics.product_sales_daily`, la tabla
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
const STORES = ['MD-30', 'MD-32']; // Canindo migró a Kepler ('06') → sus ventas las alimenta el feed Kepler

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
      // Merge SIN churn: UPSERT solo-cambios + delete-not-seen (scope = warehouses Wincaja).
      // Antes: DELETE-por-warehouse+INSERT reescribía todo cada corrida.
      // ⛔ [AUD-DAT.10] ACÁ SE ESCRIBÍA TAMBIÉN `product_sales_monthly`. Se retiró: esa tabla
      // pasó a ser el ROLLUP de `product_sales_daily` y tiene UN SOLO DUEÑO
      // (`kepler/import-product-sales-monthly.js`). Eran TRES escritores para dos tablas
      // hermanas, y se contradecían hasta 44.7 % en un mes cerrado.
      //
      // ⚠️ Este importer sigue siendo dueño de la pierna Wincaja de la DIARIA — y ahora la
      // mensual lo sigue. O sea que el `DELETE` de abajo se volvió más caro: si `sales_daily`
      // pierde estas warehouses (le pasó a `MD-32`: no tiene UNA fila en ningún mes), el
      // borrado se propaga a la mensual. El freno vive en el importer mensual
      // (`MAX_HUERFANOS_PCT`), que aborta antes de replicar un vaciado.
      const iD = await trx.raw(
        `INSERT INTO analytics.product_sales_daily AS t (tenant_id, product_id, warehouse_id, sale_date, units, updated_at)
         SELECT ?, product_id, warehouse_id, sale_date, sum(units), now()
         FROM analytics.sales_daily WHERE tenant_id=? AND channel LIKE 'wincaja%' AND warehouse_id = ANY(?)
         GROUP BY product_id, warehouse_id, sale_date
         ON CONFLICT (tenant_id, product_id, warehouse_id, sale_date) DO UPDATE SET units=EXCLUDED.units, updated_at=now()
         WHERE t.units IS DISTINCT FROM EXCLUDED.units`, [TENANT, TENANT, ids]);
      const dD = await trx.raw(
        `DELETE FROM analytics.product_sales_daily t
          WHERE t.tenant_id=? AND t.warehouse_id = ANY(?)
            AND NOT EXISTS (SELECT 1 FROM analytics.sales_daily s
                             WHERE s.tenant_id=t.tenant_id AND s.channel LIKE 'wincaja%'
                               AND s.product_id=t.product_id AND s.warehouse_id=t.warehouse_id AND s.sale_date=t.sale_date)`, [TENANT, ids]);
      console.log(`  product_sales_daily:   ${iD.rowCount} escritas, ${dD.rowCount} borradas`);
    });

    const chk = (await db.raw(
      `SELECT w.code, count(*)::int filas, count(distinct m.product_id)::int prods, round(sum(m.units)::numeric,0) u
       FROM analytics.product_sales_daily m JOIN commercial.warehouses w ON w.id=m.warehouse_id
       WHERE m.tenant_id=? AND w.code = ANY(?) GROUP BY 1 ORDER BY 1`, [TENANT, STORES])).rows;
    console.log('✅ product_sales_daily Wincaja:');
    for (const r of chk) console.log(`   ${r.code}: ${r.prods} productos, ${r.filas} filas, ${Number(r.u).toLocaleString()} u`);
    await db.destroy();
  } catch (e) {
    console.error('\nERROR:', e.message);
    await db.destroy();
    process.exit(1);
  }
})();
