const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: 'postgresql://postgres:whhQQTskVhAeQbbStUUkalNyWmikxBHJ@trolley.proxy.rlwy.net:39023/railway', ssl:{rejectUnauthorized:false} });
  await c.connect();
  const T='00000000-0000-0000-0000-00000000d01c';
  const r=await c.query(`SELECT COUNT(*) convs, ROUND(AVG(iterations),1) iter_prom, COUNT(*) FILTER (WHERE feedback=1) up, COUNT(*) FILTER (WHERE feedback=-1) down, COUNT(*) FILTER (WHERE promoted) promovidas, COUNT(*) FILTER (WHERE array_length(tools_used,1)>0) con_tools FROM commercial.thot_chat_log WHERE tenant_id=$1`,[T]);
  console.table(r.rows);
  const s=await c.query(`SELECT COUNT(*) señales FROM commercial.commerce_signals`);
  console.log('commerce_signals total (all tenants):', s.rows[0].señales);
  await c.end();
})().catch(e=>console.error(e.message));
