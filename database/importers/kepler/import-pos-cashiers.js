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
 * [CANON.5.28] Fuente por defecto: `kepler_ods.kdpv_kdku` / `kdpv_gerentes`, las 9 sucursales en
 * una consulta. `--source=branch` conserva la lectura de cada POS. Medido el 2026-11-06: de 1,359
 * llaves, las únicas diferencias con el ODS eran 4 envíos perdidos del carril hash (los repone la
 * red de resync de `replicate-ods-live.js`) y 4 en las que el ODS ya iba MÁS al día que la tabla.
 *
 * Uso (desde database/):
 *   node importers/kepler/import-pos-cashiers.js            # dry-run
 *   node importers/kepler/import-pos-cashiers.js --source=branch   # POS por sucursal
 *   DATABASE_URL_NEW='postgres://…' node importers/kepler/import-pos-cashiers.js --apply
 */
const knexLib = require('knex');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
if (!['ods', 'branch'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { salesMap, clientConfig } = require('../lib/kepler-branches');
const { loadWarehouseMap } = require('../lib/warehouse-id'); // Paso 2b: warehouse_id inline
const BRANCHES = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();

const clean = (s) => (s == null ? '' : String(s).replace(/[\r\n\t]+/g, ' ').trim());

/** Misma regla que readBranch, sobre el ODS: kdku primero y gerentes (de su propia sucursal) después. */
async function readOds() {
  if (!process.env.DATABASE_URL_NEW) throw new Error('source=ods requiere DATABASE_URL_NEW (kepler_ods vive en prod)');
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW, statement_timeout: 30000 });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT sucursal AS wh, c1 AS code, c2 AS nombre, 'cajero' AS source, 1 AS orden FROM kepler_ods.kdpv_kdku
        WHERE sucursal = ANY($1) AND c1 IS NOT NULL AND c1 <> '' AND c2 IS NOT NULL AND c2 <> ''
       UNION ALL
       SELECT sucursal, c2, c3, 'gerente', 2 FROM kepler_ods.kdpv_gerentes
        WHERE sucursal = ANY($1) AND c1 = sucursal AND c2 IS NOT NULL AND c2 <> '' AND c3 IS NOT NULL AND c3 <> ''
       ORDER BY wh, orden, code`,
      [BRANCHES.map((b) => b.code)],
    );
    const out = [];
    for (const r0 of r.rows) {
      const code = clean(r0.code); const nombre = clean(r0.nombre);
      if (code && nombre) out.push({ warehouse_code: r0.wh, cajero_code: code, nombre, source: r0.source });
    }
    return out;
  } finally { await c.end(); }
}

async function readBranch(b) {
  const c = new Client(clientConfig(b, { connectionTimeoutMillis: 6000, statement_timeout: 30000 }));
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
  const whMap = await loadWarehouseMap(db, TENANT); // Paso 2b
  let n = 0;
  for (const r of rows) {
    const wid = whMap.get(String(r.warehouse_code).trim()) || null;
    await db('analytics.pos_cashiers')
      .insert({ tenant_id: TENANT, ...r, warehouse_id: wid })
      .onConflict(['tenant_id', 'warehouse_code', 'cajero_code'])
      .merge({ warehouse_id: wid, nombre: r.nombre, source: r.source, updated_at: db.fn.now() });
    n++;
  }
  return n;
}

(async () => {
  const all = [];
  if (SOURCE === 'ods') {
    all.push(...await readOds());
    for (const b of BRANCHES) {
      const rows = all.filter((x) => x.warehouse_code === b.code);
      console.log(`[ods ${b.code}] ${rows.length} cajeros (${rows.filter((x) => x.source === 'gerente').length} gerentes)`);
    }
  } else {
    for (const b of BRANCHES) {
      try {
        const rows = await readBranch(b);
        all.push(...rows);
        const g = rows.filter((x) => x.source === 'gerente').length;
        console.log(`[${b.db}] ${rows.length} cajeros (${g} gerentes)`);
      } catch (e) { console.warn(`[${b.db}] ERROR: ${e.message}`); }
    }
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
