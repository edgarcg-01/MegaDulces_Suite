const { Client } = require('pg');
const URL = process.env.PROD_URL;
const M = '00000000-0000-0000-0000-00000000d01c';
const SKU = process.env.SKU || '03026';
(async () => {
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const p = (await c.query(`SELECT id, sku, nombre, activo, brand_id, cost_with_tax, factor_sale FROM catalog.products WHERE sku=$1 AND tenant_id=$2`, [SKU, M])).rows;
  console.log('-- catalog --');
  if (!p.length) { console.log('(NO existe en catálogo)'); }
  for (const r of p) console.log(`${r.sku} activo=${r.activo} costo=${r.cost_with_tax} fs=${r.factor_sale} | ${r.nombre}`);
  if (!p.length) { await c.end(); return; }
  const pid = p[0].id;
  const st = (await c.query(`
    SELECT w.code, w.name, st.quantity FROM commercial.stock st
    JOIN commercial.warehouses w ON w.id=st.warehouse_id AND w.tenant_id=st.tenant_id
    WHERE st.tenant_id=$1 AND st.product_id=$2 ORDER BY w.code`, [M, pid])).rows;
  console.log('\n-- stock (todas las filas, incl 0) --');
  if (!st.length) console.log('(sin filas de stock en ningún almacén)');
  for (const r of st) console.log(`${r.code}/${r.name} qty=${r.quantity}`);
  const sa = (await c.query(`
    SELECT w.code, sum(m.units) units, min(m.sale_date) d0, max(m.sale_date) d1
    FROM analytics.product_sales_daily m JOIN commercial.warehouses w ON w.id=m.warehouse_id
    WHERE m.tenant_id=$1 AND m.product_id=$2 AND m.sale_date >= current_date-90
    GROUP BY 1 ORDER BY 1`, [M, pid])).rows;
  console.log('\n-- ventas 90d --');
  if (!sa.length) console.log('(sin ventas 90d)');
  for (const r of sa) console.log(`${r.code} units=${r.units} (${r.d0?.toISOString?.().slice(0,10)}..${r.d1?.toISOString?.().slice(0,10)})`);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
