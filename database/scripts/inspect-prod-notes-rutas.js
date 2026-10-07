"use strict";

/**
 * READ-ONLY: replica el DRY del backfill sin escribir. Cuenta cuántos customers
 * (sales_route NULL) traen la ruta como texto en notes ("Ruta: X") y la
 * distribución que se poblaría. Uso:
 *   $env:PROD_DATABASE_URL='...'; node database/scripts/inspect-prod-notes-rutas.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const counts = await c.query(`
    SELECT count(*)::int total_sin_ruta,
           count(*) FILTER (WHERE notes IS NOT NULL)::int con_notes,
           count(*) FILTER (WHERE notes ~* 'ruta:\\s*\\S')::int con_patron_ruta
    FROM commercial.customers
    WHERE deleted_at IS NULL AND sales_route IS NULL`);
  console.log('customers sin sales_route:', counts.rows[0]);

  const dist = await c.query(`
    SELECT upper(trim(substring(notes from '(?i)ruta:\\s*(.+?)\\s*$'))) AS route, count(*)::int n
    FROM commercial.customers
    WHERE deleted_at IS NULL AND sales_route IS NULL AND notes ~* 'ruta:\\s*\\S'
    GROUP BY 1 ORDER BY n DESC LIMIT 50`);
  console.log(`\nrutas que el backfill poblaría (${dist.rows.length} distintas):`);
  if (!dist.rows.length) console.log('  (NINGUNA — notes no trae el patron "Ruta:") ← el backfill no serviría');
  for (const r of dist.rows) console.log(`  ${r.route} -> ${r.n}`);

  const sample = await c.query(`
    SELECT code, left(notes, 140) AS notes_preview
    FROM commercial.customers
    WHERE deleted_at IS NULL AND notes IS NOT NULL
    ORDER BY code LIMIT 12`);
  console.log('\nmuestra de notes (12):');
  for (const s of sample.rows) console.log(`  ${s.code}: ${JSON.stringify(s.notes_preview)}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
