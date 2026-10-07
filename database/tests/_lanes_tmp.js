const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.U, ssl:{rejectUnauthorized:false}, statement_timeout:60000 });
  await c.connect();
  const keys=['kepler_catalog_bulk','wincaja_replica','kepler_prices_bitacora','feed_catalog','wincaja_concentrada'];
  console.log('=== analytics.cron_runs para los 5 carriles ===');
  const r=await c.query(`SELECT job_key, to_char(max(ran_at),'YYYY-MM-DD HH24:MI') last, round(extract(epoch from (now()-max(ran_at)))/3600)::int edad_h, max(status) st
     FROM analytics.cron_runs WHERE job_key = ANY($1) GROUP BY job_key ORDER BY edad_h DESC`,[keys]);
  r.rows.forEach(x=>console.log(`  ${String(x.job_key).padEnd(24)} last=${x.last} · ${x.edad_h}h · status=${x.st}`));
  const found=r.rows.map(x=>x.job_key);
  keys.filter(k=>!found.includes(k)).forEach(k=>console.log(`  ${k.padEnd(24)} SIN filas en cron_runs`));
  // también: qué otros job_keys existen y su frescura (para contexto)
  console.log('\n=== TODOS los job_keys en cron_runs (edad) ===');
  const all=await c.query(`SELECT job_key, round(extract(epoch from (now()-max(ran_at)))/3600)::int edad_h FROM analytics.cron_runs GROUP BY job_key ORDER BY edad_h DESC`);
  all.rows.forEach(x=>console.log(`  ${String(x.edad_h).padStart(5)}h  ${x.job_key}`));
  await c.end();
})().catch(e=>{console.error('FALLO:',e.message);process.exitCode=1;});
