const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.U, ssl:{rejectUnauthorized:false}, statement_timeout:120000 });
  await c.connect();
  const db=(await c.query('select current_database() d')).rows[0].d;
  if(db!=='railway'){ console.error('NO es prod'); process.exit(2); }
  const t=(await c.query(`SELECT id FROM identity.tenants WHERE slug='mega_dulces'`)).rows[0].id;
  const w=await c.query(`SELECT code,id FROM commercial.warehouses WHERE tenant_id=$1 AND code IN ('MD-32','07')`,[t]);
  const id=Object.fromEntries(w.rows.map(r=>[r.code,r.id]));
  const col=(await c.query(`SELECT count(*) n FROM analytics.sales_daily WHERE tenant_id=$1 AND warehouse_id=$2 AND channel LIKE 'wincaja_%'`,[t,id['07']])).rows[0].n;
  console.log(`07 filas wincaja_% previas: ${col} (debe ser 0)`);
  if(Number(col)>0){ console.error('colisión — abort'); process.exit(3); }
  const r=await c.query(`UPDATE analytics.sales_daily SET warehouse_id=$3, updated_at=now()
     WHERE tenant_id=$1 AND warehouse_id=$2 AND channel LIKE 'wincaja_%'`,[t,id['MD-32'],id['07']]);
  console.log(`Madero wincaja MD-32 -> 07: ${r.rowCount} filas movidas`);
  const chk=await c.query(`SELECT w.code, count(*) n FROM analytics.sales_daily sd JOIN commercial.warehouses w ON w.id=sd.warehouse_id
     WHERE sd.tenant_id=$1 AND w.code IN ('MD-32','07') AND sd.channel LIKE 'wincaja_%' GROUP BY w.code`,[t]);
  console.log('wincaja_% ahora:', chk.rows.map(x=>`${x.code}=${x.n}`).join(' ')||'MD-32=0 (ok)');
  await c.end();
})().catch(e=>{console.error('FALLO:',e.message);process.exitCode=1;});
