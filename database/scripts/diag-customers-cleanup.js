// READ-ONLY: scope + dependencias para limpiar commercial.customers (excepto hoy)
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.PROD_DATABASE_URL });
  await c.connect();
  const q = (s, p) => c.query(s, p).then(r => r.rows);

  const cols = await q(`select column_name from information_schema.columns
    where table_schema='commercial' and table_name='customers' order by ordinal_position`);
  console.log('COLUMNS customers:', cols.map(r => r.column_name).join(', '));

  const total = await q(`select count(*)::int n from commercial.customers`);
  const alive = await q(`select count(*)::int n from commercial.customers where deleted_at is null`);
  console.log('\nTOTAL customers:', total[0].n, '| vivos (deleted_at null):', alive[0].n);

  const today = await q(`select count(*)::int n from commercial.customers
    where (created_at at time zone 'America/Mexico_City')::date = (now() at time zone 'America/Mexico_City')::date`);
  console.log('Creados HOY (MX):', today[0].n);

  const toDelete = await q(`select count(*)::int n from commercial.customers
    where deleted_at is null
      and (created_at at time zone 'America/Mexico_City')::date <> (now() at time zone 'America/Mexico_City')::date`);
  console.log('Candidatos a borrar (vivos y NO de hoy):', toDelete[0].n);

  const sample = await q(`select code, name, created_at from commercial.customers
    where (created_at at time zone 'America/Mexico_City')::date = (now() at time zone 'America/Mexico_City')::date
    order by created_at desc limit 20`);
  console.log('\nClientes de HOY (se conservan):');
  sample.forEach(r => console.log('  ', r.code, '|', r.name, '|', r.created_at));

  const withOrders = await q(`select count(distinct cu.id)::int n
    from commercial.customers cu join commercial.orders o on o.customer_id = cu.id
    where cu.deleted_at is null
      and (cu.created_at at time zone 'America/Mexico_City')::date <> (now() at time zone 'America/Mexico_City')::date`);
  console.log('\nDe los candidatos, con pedidos (FK orders):', withOrders[0].n);

  const fks = await q(`select tc.table_schema, tc.table_name, kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.constraint_type='FOREIGN KEY' and ccu.table_schema='commercial' and ccu.table_name='customers'`);
  console.log('\nTablas que referencian commercial.customers (FK):');
  fks.forEach(r => console.log('  ', r.table_schema + '.' + r.table_name, '->', r.column_name));

  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
