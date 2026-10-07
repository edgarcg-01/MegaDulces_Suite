const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.U, ssl:{rejectUnauthorized:false}, statement_timeout:60000 });
  await c.connect();
  const t=(await c.query(`SELECT id FROM identity.tenants WHERE slug='mega_dulces'`)).rows[0].id;
  const q=async(tbl)=>{
    const r=await c.query(`SELECT w.code, count(*) n FROM analytics.${tbl.startsWith('reorder')?'commercial':'analytics'}.${tbl} x JOIN commercial.warehouses w ON w.id=x.warehouse_id WHERE x.tenant_id=$1 AND w.code IN ('MD-32','07') GROUP BY w.code ORDER BY w.code`,[t]).catch(async e=>{
      // reorder_policy vive en commercial
      return c.query(`SELECT w.code, count(*) n FROM commercial.${tbl} x JOIN commercial.warehouses w ON w.id=x.warehouse_id WHERE x.tenant_id=$1 AND w.code IN ('MD-32','07') GROUP BY w.code ORDER BY w.code`,[t]);
    });
    console.log(`  ${tbl.padEnd(20)}: ${r.rows.map(x=>`${x.code}=${x.n}`).join('  ')||'sin filas'}`);
  };
  console.log('=== Madero por etapa (post paso 2) ===');
  await q('product_demand');
  await q('reorder_policy');
  await q('replenishment_plan');
  await c.end();
})().catch(e=>{console.error('FALLO:',e.message);process.exitCode=1;});
