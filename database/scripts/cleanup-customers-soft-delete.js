// PROD WRITE (autorizado): soft-delete de clientes vivos NO creados hoy (TZ MX).
// Conserva los 6 de hoy. No toca trade.stores. Reversible (deleted_at=null).
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.PROD_DATABASE_URL });
  await c.connect();
  const q = (s, p) => c.query(s, p).then(r => r.rows);

  const where = `deleted_at is null
    and (created_at at time zone 'America/Mexico_City')::date
        <> (now() at time zone 'America/Mexico_City')::date`;

  const before = await q(`select count(*)::int n from commercial.customers where ${where}`);
  console.log('A soft-deletear:', before[0].n);

  await c.query('begin');
  const res = await c.query(`update commercial.customers
    set deleted_at = now(), active = false, updated_at = now()
    where ${where}`);
  await c.query('commit');
  console.log('Filas actualizadas:', res.rowCount);

  const alive = await q(`select count(*)::int n from commercial.customers where deleted_at is null`);
  const today = await q(`select code, name from commercial.customers
    where deleted_at is null order by created_at desc`);
  console.log('Clientes vivos restantes:', alive[0].n);
  today.forEach(r => console.log('  ', r.code, '|', r.name));

  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
