const { Client } = require('pg');
const targets = [
  { label: 'DATABASE_URL_NEW', cs: process.env.DATABASE_URL_NEW },
  { label: '.245:5432', cs: 'postgres://postgres:postgres@192.168.0.245:5432/postgres_platform' },
];
(async () => {
  for (const t of targets) {
    if (!t.cs) { console.log(`\n[${t.label}] (no set)`); continue; }
    const c = new Client({ connectionString: t.cs, ssl: t.cs.includes('proxy') ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 5000 });
    try {
      await c.connect();
      const host = (await c.query('select inet_server_addr() h, current_database() db')).rows[0];
      const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='analytics' AND table_name='cash_cuts' AND column_name IN ('venta_total','tarjeta_diff','arqueo_billetes','efectivo_retirado') ORDER BY 1`);
      const cnt = await c.query(`SELECT count(*)::int n FROM analytics.cash_cuts`).catch(() => ({ rows: [{ n: 'NO TABLE' }] }));
      console.log(`\n[${t.label}] db=${host.db} addr=${host.h || 'local'} · cash_cuts rows=${cnt.rows[0].n} · cols_nuevas=[${cols.rows.map(r=>r.column_name).join(',')}]`);
    } catch (e) { console.log(`\n[${t.label}] ERROR: ${e.message}`); }
    finally { await c.end().catch(()=>{}); }
  }
})();
