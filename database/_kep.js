const { Client } = require('pg');
(async () => {
  const tries = [
    'postgresql://postgres:kepler123@192.168.0.245:5432/postgres',
    'postgresql://postgres:superoot@192.168.0.245:5432/postgres',
  ];
  for (const cs of tries) {
    const c = new Client({ connectionString: cs, connectionTimeoutMillis: 6000 });
    try {
      await c.connect();
      const dbs = (await c.query(`SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1`)).rows.map(r=>r.datname);
      console.log('OK con', cs.replace(/:[^:@/]+@/,':***@'));
      console.log('DATABASES:', dbs.join(', '));
      await c.end();
      return;
    } catch(e){ console.log('FALLÓ', cs.replace(/:[^:@/]+@/,':***@'), '→', e.message); try{await c.end();}catch{} }
  }
})();
