"use strict";
/** READ-ONLY: estado real del schema de daily_captures / vendor_sale_lines en prod. */
const { Client } = require('pg');
const URL = process.env.PROD_DATABASE_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const rels = await c.query(
    `SELECT n.nspname AS schema, c.relname, c.relkind
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relname IN ('daily_captures','vendor_sale_lines') AND c.relkind IN ('r','v')
      ORDER BY 1,2`);
  console.log('Relaciones (r=tabla, v=vista):'); console.table(rels.rows);

  const views = await c.query(
    `SELECT schemaname, viewname FROM pg_views WHERE viewname='daily_captures' ORDER BY 1`);
  console.log('\nVistas daily_captures:', views.rows.map(r=>r.schemaname+'.'+r.viewname).join(', ') || '(ninguna)');
  for (const v of views.rows) {
    const def = await c.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [v.schemaname+'.'+v.viewname]);
    console.log(`\n--- ${v.schemaname}.${v.viewname} ---\n` + def.rows[0].def);
  }

  const cols = await c.query(
    `SELECT table_schema, table_name, column_name, is_nullable, data_type
       FROM information_schema.columns
      WHERE table_name IN ('daily_captures','vendor_sale_lines')
        AND column_name IN ('store_id','customer_id')
      ORDER BY table_name, table_schema, column_name`);
  console.log('\nColumnas store_id/customer_id:'); console.table(cols.rows);

  await c.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
