/**
 * SM.10 — Importer de SESIONES DE CAJA (abiertas/cerradas del día).
 *
 * Complementa a import-cash-cuts (que solo trae cortes CERRADOS). Lee
 * `md.kdpv_folio_caja` de las 6 sucursales y trae las sesiones RECIENTES
 * (apertura en los últimos 2 días → descarta cajas viejas nunca cerradas) a
 * `analytics.cash_sessions`. Estado = ABIERTA si `c10='1800-01-01'` (fecha de
 * cierre centinela). Cruzada con `store_live_tickets.cajero` responde "quién está
 * cobrando ahora". Idempotente (UPSERT por suc/caja/folio).
 *
 * Columnas kdpv_folio_caja: c1=suc c2=caja c3=folio c5=fecha_ap c6=hora_ap
 *   c7=cajero_ap c8=cajero_cierre c10=fecha_cierre('1800-01-01'=abierta).
 *
 * Uso (desde database/):
 *   node importers/kepler/import-cash-sessions.js                 # dry-run
 *   DATABASE_URL_NEW='postgres://…?sslmode=no-verify' node importers/kepler/import-cash-sessions.js --apply
 */
const knexLib = require('knex');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const BRANCHES = process.env.SALES_BRANCH_MAP
  ? JSON.parse(process.env.SALES_BRANCH_MAP)
  : [
      { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00', name: 'CEDIS' },
      { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01', name: 'Padre Hidalgo' },
      { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02', name: 'La Piedad Abastos' },
      { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03', name: '8 Esquinas' },
      { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04', name: 'Yurécuaro' },
      { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05', name: 'Zamora Centro' },
    ];

async function readBranch(b) {
  const c = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 30000 });
  await c.connect();
  try {
    // Sesiones abiertas HOY/ayer + las cerradas hoy (para reflejar el cierre).
    const r = await c.query(
      `SELECT c1 AS suc, c2 AS caja, c3 AS folio, c5::date AS fecha,
              (c5::date + COALESCE(NULLIF(btrim(c6),'')::time, '00:00')) AS opened_at,
              NULLIF(c10,'1800-01-01')::timestamptz AS closed_at,
              c6 AS hora_ap, c7 AS cajero_ap, c8 AS cajero_cierre
         FROM md.kdpv_folio_caja
        WHERE c1 = $1
          AND c5::date >= (CURRENT_DATE - INTERVAL '2 days')`,
      [b.code],
    );
    return r.rows.map((x) => {
      const abierta = x.closed_at == null;
      const cajero = abierta
        ? (x.cajero_ap ? String(x.cajero_ap).trim() : null)
        : (String(x.cajero_cierre || '').trim() || String(x.cajero_ap || '').trim() || null);
      return {
        warehouse_code: b.code, warehouse_name: b.name,
        caja: String(x.caja), folio: String(x.folio), business_date: x.fecha,
        cajero_code: cajero || null, opened_at: x.opened_at, closed_at: x.closed_at,
        status: abierta ? 'open' : 'closed',
      };
    });
  } finally {
    await c.end();
  }
}

async function upsert(db, rows) {
  let n = 0;
  for (const r of rows) {
    await db('analytics.cash_sessions')
      .insert({ tenant_id: TENANT, ...r, source: 'kepler' })
      .onConflict(['tenant_id', 'warehouse_code', 'caja', 'folio'])
      .merge({
        cajero_code: r.cajero_code, closed_at: r.closed_at, status: r.status,
        opened_at: r.opened_at, business_date: r.business_date, updated_at: db.fn.now(),
      });
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
      const abiertas = rows.filter((r) => r.status === 'open').length;
      console.log(`[${b.db}] ${rows.length} sesiones (${abiertas} ABIERTAS)`);
    } catch (e) {
      console.warn(`[${b.db}] ERROR: ${e.message}`);
    }
  }
  const abiertas = all.filter((r) => r.status === 'open');
  console.log(`\nTOTAL: ${all.length} sesiones · ${abiertas.length} ABIERTAS ahora`);
  abiertas.slice(0, 12).forEach((r) => console.log(`  ABIERTA suc${r.warehouse_code} caja${r.caja} cajero=${r.cajero_code} desde ${r.opened_at?.toISOString?.().slice(0, 16) || r.opened_at}`));

  if (!APPLY) { console.log('\n(dry-run — usar --apply para escribir a analytics.cash_sessions)'); return; }
  if (!process.env.DATABASE_URL_NEW) { console.error('ERROR: --apply requiere DATABASE_URL_NEW'); process.exit(1); }
  const isLocal = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW || '');
  const db = knexLib({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: isLocal ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  const n = await upsert(db, all);
  console.log(`✅ UPSERT ${n} sesiones a analytics.cash_sessions`);
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
