const { Client } = require('pg');
const T = '00000000-0000-0000-0000-00000000d01c';
// Parse el contenido real (sub-unidades por unidad de stock) del nombre.
function parseSUF(nombre) {
  const n = nombre.toUpperCase();
  let m = n.match(/(\d+(?:\.\d+)?)\s*KG\b/);          if (m) return { suf: Math.round(+m[1]), how: 'KG' };
  m = n.match(/\b(\d+(?:\.\d+)?)\s*K\b/);              if (m) return { suf: Math.round(+m[1]), how: 'K' };
  m = n.match(/\/\s*(\d+)\b/);                          if (m) return { suf: +m[1], how: '/N' };
  return null;
}
(async () => {
  const c = new Client({ connectionString: process.env.PRODURL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query(`SELECT set_config('app.tenant_id', $1, false)`, [T]);
  // granel candidates: factor_sale<=1 y ratio>=3
  const q = `
    WITH s AS (SELECT sd.product_id, CASE WHEN w.code LIKE 'MD-%' THEN 'mayoreo' WHEN w.code ~ '^[0-9]+$' AND w.code<>'00' THEN 'retail' ELSE 'other' END ch,
                 sum(sd.units) u, sum(sd.revenue) rev
               FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id=sd.warehouse_id AND w.tenant_id=sd.tenant_id
               WHERE sd.tenant_id=$1 AND sd.sale_date>=now()-interval '90 days' AND sd.units>0 AND sd.revenue>0 GROUP BY sd.product_id, ch),
    piv AS (SELECT product_id, sum(rev) FILTER (WHERE ch='retail') rr, sum(u) FILTER (WHERE ch='retail') ru,
                    sum(rev) FILTER (WHERE ch='mayoreo') mr, sum(u) FILTER (WHERE ch='mayoreo') mu FROM s GROUP BY product_id)
    SELECT p.id, p.sku, p.nombre, round(((mr/NULLIF(mu,0))/(rr/NULLIF(ru,0)))::numeric,1) ratio
      FROM piv JOIN catalog.products p ON p.id=piv.product_id AND p.tenant_id=$1
     WHERE ru>0 AND mu>0 AND (mr/NULLIF(mu,0))/(rr/NULLIF(ru,0)) >= 3
       AND GREATEST(CASE WHEN p.factor_sale>1 THEN p.factor_sale ELSE 1 END,1) <= 1`;
  const r = await c.query(q, [T]);
  let seeded = 0, skipped = 0;
  for (const row of r.rows) {
    const p = parseSUF(row.nombre);
    const suf = p ? p.suf : Math.round(Number(row.ratio)); // fallback: ratio
    if (!suf || suf < 2) { skipped++; continue; }
    const src = p ? p.how : 'ratio';
    const ex = await c.query(`SELECT id FROM commercial.product_unit_overrides WHERE tenant_id=$1 AND product_id=$2 AND deleted_at IS NULL`, [T, row.id]);
    if (ex.rows.length) await c.query(`UPDATE commercial.product_unit_overrides SET pieces_per_unit=$3, box_factor=1, sold_as='granel', note=$4, updated_at=now() WHERE id=$5`, [T, row.id, suf, `auto-seed ${src}`, ex.rows[0].id]);
    else await c.query(`INSERT INTO commercial.product_unit_overrides (tenant_id, product_id, pieces_per_unit, box_factor, sold_as, note) VALUES ($1,$2,$3,1,'granel',$4)`, [T, row.id, suf, `auto-seed ${src}`]);
    seeded++;
    console.log(`${row.sku} | ${row.nombre.slice(0,34)} | ratio ${row.ratio} | SUF=${suf} (${src})`);
  }
  console.log(`\nSeeded ${seeded}, skipped ${skipped}, total candidates ${r.rows.length}`);
  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
