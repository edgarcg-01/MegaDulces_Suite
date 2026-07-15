const { Client } = require('pg');
const URL = process.env.PROD_URL;
const M = '00000000-0000-0000-0000-00000000d01c';
(async () => {
  const c = new Client({ connectionString: URL, connectionTimeoutMillis: 20000, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Productos ACTIVOS con existencia (stock<>0) en cualquier almacén, con su factor y unidad.
  const { rows } = await c.query(`
    SELECT p.sku, p.nombre, upper(btrim(coalesce(p.unit_sale,''))) unit,
           p.factor_sale::numeric fs, lp.box_size::numeric box_lbl,
           sum(abs(st.quantity)) existencia
    FROM catalog.products p
    JOIN commercial.stock st ON st.product_id=p.id AND st.tenant_id=p.tenant_id AND st.quantity <> 0
    LEFT JOIN commercial.product_label_prices lp ON lp.product_id=p.id AND lp.tenant_id=p.tenant_id
    WHERE p.tenant_id=$1 AND p.activo=true
    GROUP BY 1,2,3,4,5`, [M]);
  const isPza = (u) => u==='' || u==='PZA' || u==='PZAS' || u==='PIEZA' || u==='PZ';
  let ok=0, coherentUnit=0, gapNoFactor=0;
  const unitMiss = new Map();
  const gapSamples = [];
  for (const r of rows) {
    const boxF = (Number(r.box_lbl)>0) ? Number(r.box_lbl) : (Number(r.fs)>0 ? Number(r.fs) : 0);
    if (isPza(r.unit) && boxF>0) { ok++; }
    else if (!isPza(r.unit)) { coherentUnit++; unitMiss.set(r.unit,(unitMiss.get(r.unit)||0)+1); }
    else { gapNoFactor++; if (gapSamples.length<25) gapSamples.push(r); } // pieza pero sin factor → "—" incoherente
  }
  console.log(`Productos ACTIVOS con existencia: ${rows.length}`);
  console.log(`  ✅ Exist.Cja calcula (pieza + factor): ${ok}`);
  console.log(`  ➖ "—" coherente (unidad no divisible): ${coherentUnit}`);
  console.log(`     por unidad: ${[...unitMiss.entries()].sort((a,b)=>b[1]-a[1]).map(([u,n])=>`${u||'(vacía)'}=${n}`).join(', ')}`);
  console.log(`  ⚠️  "—" INCOHERENTE (pieza SIN factor_sale ni etiqueta): ${gapNoFactor}`);
  for (const r of gapSamples) console.log(`     ${r.sku} u=${r.unit||'(vacía)'} fs=${r.fs} box_lbl=${r.box_lbl} exist=${r.existencia} | ${r.nombre}`);
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
