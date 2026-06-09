/* eslint-disable no-console */
/**
 * Backfill de commercial.customers.sales_route desde el texto de notes.
 * Los clientes importados del ERP traen la ruta de venta como texto en notes
 * ("Ruta: RUTA 21"). Este script la extrae y la persiste en la columna
 * estructurada sales_route (uppercase, trim).
 *
 * Idempotente: solo escribe donde sales_route IS NULL y notes matchea el patron
 * "Ruta: X". Re-correr no pisa valores ya seteados.
 *
 * Uso:
 *   DRY (default):  node database/scripts/backfill-customer-sales-route.js
 *   APLICAR:        node database/scripts/backfill-customer-sales-route.js --apply
 *   prod:           TARGET_DB_URL="postgres://..." node ... --apply
 */
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const RUTA_RE = /ruta:\s*(.+?)\s*$/i;

const conn = process.env.TARGET_DB_URL
  ? { client: 'pg', connection: { connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } } }
  : require('../knexfile-newdb.js').development;
const knex = require('knex')(conn);

(async () => {
  const target = process.env.TARGET_DB_URL ? 'PROD' : 'local';
  const rows = await knex('commercial.customers')
    .where({ tenant_id: T })
    .whereNull('deleted_at')
    .whereNull('sales_route')
    .whereNotNull('notes')
    .select('id', 'notes');

  const plan = [];
  for (const r of rows) {
    const m = RUTA_RE.exec(String(r.notes).trim());
    if (!m) continue;
    const route = m[1].trim().toUpperCase().slice(0, 50);
    if (route) plan.push({ id: r.id, route });
  }

  const dist = {};
  for (const p of plan) dist[p.route] = (dist[p.route] || 0) + 1;
  console.log(`target=${target}${APPLY ? '' : ' [DRY — usar --apply]'}`);
  console.log(`candidatos (sales_route NULL + notes con "Ruta:")=${plan.length} | rutas distintas=${Object.keys(dist).length}`);
  console.log('distribucion:', Object.entries(dist).sort((a, b) => b[1] - a[1]).map((e) => e[0] + '(' + e[1] + ')').join(', '));

  if (!APPLY) { await knex.destroy(); return; }

  let updated = 0;
  for (const p of plan) {
    updated += await knex('commercial.customers')
      .where({ id: p.id })
      .whereNull('sales_route')
      .update({ sales_route: p.route, updated_at: knex.fn.now() });
  }
  const total = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('sales_route').count('* as n').first();
  console.log(`actualizados ahora: ${updated} | total con sales_route: ${total.n}`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
