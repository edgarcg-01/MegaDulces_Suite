/**
 * SM.8 / P6 — Importer de venta atómica de tickets POS (cruce independiente).
 *
 * Agrega `md.kdm1` (venta real U/D/10) por sucursal×cajero(c67)×día(c9) y UPSERT a
 * `analytics.pos_ticket_sales`. El motor luego compara este total (capa atómica)
 * contra el total del corte (kdpv_folio_caja, capa agregada) → regla venta_vs_tickets.
 *
 * Uso (desde database/):
 *   node importers/kepler/import-pos-ticket-sales.js            # dry-run
 *   DATABASE_URL_NEW='postgres://…' node importers/kepler/import-pos-ticket-sales.js --apply
 */
const knexLib = require('knex');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const BRANCHES = process.env.SALES_BRANCH_MAP
  ? JSON.parse(process.env.SALES_BRANCH_MAP)
  : [
      { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00' },
      { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01' },
      { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02' },
      { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03' },
      { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04' },
      { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05' },
    ];

async function readBranch(b) {
  const c = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 120000 });
  await c.connect();
  try {
    // Venta real (U/D/10) agregada por cajero×día. Filtro c1 = sucursal propia (réplicas).
    const r = await c.query(
      `SELECT c67 AS cajero, c9::date AS dia, COUNT(*)::int AS n, ROUND(SUM(c16::numeric),2) AS total
       FROM md.kdm1
       WHERE c1 = $1 AND c2='U' AND c3='D' AND c4::text='10' AND c67 IS NOT NULL AND c67 <> ''
       GROUP BY c67, c9::date`,
      [b.code],
    );
    return r.rows.map((x) => ({
      warehouse_code: b.code,
      cajero_code: String(x.cajero).trim(),
      business_date: x.dia,
      ticket_count: Number(x.n),
      ticket_total: Number(x.total) || 0,
    }));
  } finally { await c.end(); }
}

async function upsert(db, rows) {
  let n = 0;
  for (const r of rows) {
    await db('analytics.pos_ticket_sales')
      .insert({ tenant_id: TENANT, ...r })
      .onConflict(['tenant_id', 'warehouse_code', 'cajero_code', 'business_date'])
      .merge({ ticket_count: r.ticket_count, ticket_total: r.ticket_total, updated_at: db.fn.now() });
    n++;
  }
  return n;
}

(async () => {
  const all = [];
  for (const b of BRANCHES) {
    try {
      const rows = await readBranch(b);
      all.push(...rows);
      console.log(`[${b.db}] ${rows.length} cajero×día`);
    } catch (e) { console.warn(`[${b.db}] ERROR: ${e.message}`); }
  }
  const totalVenta = Math.round(all.reduce((s, r) => s + r.ticket_total, 0));
  console.log(`\nTOTAL: ${all.length} filas cajero×día · venta tickets $${totalVenta.toLocaleString('es-MX')}`);

  if (!APPLY) { console.log('\n(dry-run — usar --apply para escribir a analytics.pos_ticket_sales)'); return; }
  if (!process.env.DATABASE_URL_NEW) { console.error('ERROR: --apply requiere DATABASE_URL_NEW'); process.exit(1); }
  const isLocal = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW);
  const db = knexLib({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: isLocal ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  const n = await upsert(db, all);
  console.log(`✅ UPSERT ${n} filas a analytics.pos_ticket_sales`);
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
