const { Client } = require('pg');
const M = '00000000-0000-0000-0000-00000000d01c';
const BLEND = `(vl.wincaja_only = true OR (vl.source_branch='10' AND vl.business_date < DATE '2026-07-01') OR (vl.source_branch='42' AND vl.business_date < DATE '2025-10-01'))`;
(async () => {
  const db = new Client({ connectionString: process.env.U, ssl: { rejectUnauthorized: false }, statement_timeout: 90000, keepAlive: true });
  await db.connect();
  // ROLLUP junio: total + por vendedor
  const roll = (await db.query(`
    SELECT round(sum(revenue))::bigint rev, count(DISTINCT vendor_code) vendors
      FROM analytics.sales_by_vendor_monthly WHERE tenant_id=$1 AND year_month='2026-06'`, [M])).rows[0];
  // LIVE junio (mismo blend + is_promo=false + deleted_at null, igual que el feed)
  const t = Date.now();
  const live = (await db.query(`
    SELECT round(sum(vl.importe))::bigint rev,
           count(DISTINCT (vl.source_branch||':'||COALESCE(NULLIF(btrim(vl.vendedor),''),'·'))) vendors
      FROM wincaja.v_sales_lines vl
      JOIN catalog.products p ON p.tenant_id=vl.tenant_id AND p.sku=vl.sku AND p.deleted_at IS NULL AND p.is_promo=false
     WHERE vl.tenant_id=$1 AND ${BLEND} AND vl.business_date>='2026-06-01' AND vl.business_date<'2026-07-01'`, [M])).rows[0];
  console.log('ROLLUP junio :', JSON.stringify(roll));
  console.log(`LIVE   junio : ${JSON.stringify(live)}  (${Date.now() - t}ms)`);
  console.log('MATCH revenue:', String(roll.rev) === String(live.rev) ? '✅' : `❌ diff ${Number(roll.rev) - Number(live.rev)}`);
  console.log('MATCH vendors:', String(roll.vendors) === String(live.vendors) ? '✅' : `❌ ${roll.vendors} vs ${live.vendors}`);
  // velocidad del fast-path (rollup) simulando sellOutVendors
  const t2 = Date.now();
  await db.query(`SELECT sd.sale_channel, sd.vendor_code, sd.vendor_name, sum(sd.revenue) rev
     FROM analytics.sales_by_vendor_monthly sd WHERE sd.tenant_id=$1
     AND sd.sale_channel IN ('mayoreo_credito','ruta_venta','preventa_vecinal')
     GROUP BY 1,2,3 HAVING sum(sd.revenue)>0`, [M]);
  console.log(`\nfast-path sellOutVendors (rollup): ${Date.now() - t2}ms`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
