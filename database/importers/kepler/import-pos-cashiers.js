/**
 * SM.7 — Importer del catálogo de cajeros POS (nombres).
 *
 * Lee `md.kdpv_gerentes` (c1=suc, c2=clave, c3=nombre) y `md.kdpv_kdku`
 * (c1=clave, c2=nombre) de las 6 sucursales Kepler (LAN) y UPSERT a
 * `analytics.pos_cashiers`. Escopeado por (tenant, warehouse_code, cajero_code).
 *
 * gerentes se carga DESPUÉS de kdku → gana en códigos compartidos (los que
 * realmente cierran cortes son los prefijados de gerentes: 40VMC, 42GERNTA…).
 *
 * Uso (desde database/):
 *   node importers/kepler/import-pos-cashiers.js            # dry-run
 *   DATABASE_URL_NEW='postgres://…' node importers/kepler/import-pos-cashiers.js --apply
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

const clean = (s) => (s == null ? '' : String(s).replace(/[\r\n\t]+/g, ' ').trim());

async function readBranch(b) {
  const c = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 6000, statement_timeout: 30000 });
  await c.connect();
  const out = [];
  try {
    // cajeros (códigos cortos) — c1=clave, c2=nombre
    const kdku = await c.query(`SELECT c1 AS code, c2 AS nombre FROM md.kdpv_kdku WHERE c1 IS NOT NULL AND c1 <> '' AND c2 IS NOT NULL AND c2 <> ''`).catch(() => ({ rows: [] }));
    for (const r of kdku.rows) {
      const code = clean(r.code); const nombre = clean(r.nombre);
      if (code && nombre) out.push({ warehouse_code: b.code, cajero_code: code, nombre, source: 'cajero' });
    }
    // gerentes (códigos prefijados) — c1=suc, c2=clave, c3=nombre. Filtrar a la sucursal propia.
    const ger = await c.query(`SELECT c2 AS code, c3 AS nombre FROM md.kdpv_gerentes WHERE c1 = $1 AND c2 IS NOT NULL AND c2 <> '' AND c3 IS NOT NULL AND c3 <> ''`, [b.code]).catch(() => ({ rows: [] }));
    for (const r of ger.rows) {
      const code = clean(r.code); const nombre = clean(r.nombre);
      if (code && nombre) out.push({ warehouse_code: b.code, cajero_code: code, nombre, source: 'gerente' });
    }
  } finally { await c.end(); }
  return out;
}

async function upsert(db, rows) {
  let n = 0;
  for (const r of rows) {
    await db('analytics.pos_cashiers')
      .insert({ tenant_id: TENANT, ...r })
      .onConflict(['tenant_id', 'warehouse_code', 'cajero_code'])
      .merge({ nombre: r.nombre, source: r.source, updated_at: db.fn.now() });
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
      const g = rows.filter((x) => x.source === 'gerente').length;
      console.log(`[${b.db}] ${rows.length} cajeros (${g} gerentes)`);
    } catch (e) { console.warn(`[${b.db}] ERROR: ${e.message}`); }
  }
  console.log(`\nTOTAL: ${all.length} filas cajero`);
  all.filter((x) => x.source === 'gerente').slice(0, 8).forEach((r) => console.log(`  suc${r.warehouse_code} ${r.cajero_code} → ${r.nombre}`));

  if (!APPLY) { console.log('\n(dry-run — usar --apply para escribir a analytics.pos_cashiers)'); return; }
  if (!process.env.DATABASE_URL_NEW) { console.error('ERROR: --apply requiere DATABASE_URL_NEW'); process.exit(1); }
  const isLocal = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW);
  const db = knexLib({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: isLocal ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  const n = await upsert(db, all);
  console.log(`✅ UPSERT ${n} filas a analytics.pos_cashiers`);
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
