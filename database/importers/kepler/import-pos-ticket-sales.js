/**
 * ⛔ RETIRADO 2026-11-11 [CANON.6.3] — ya no corre en ningún carril. La venta por cajero y día se lee de
 * la vista `analytics.v_pos_ticket_sales` (kepler_ods.kdm1, misma consulta que `readOds` de abajo).
 * `analytics.pos_ticket_sales` queda congelada; su borrado se pide aparte.
 *
 * SM.8 / P6 — Importer de venta atómica de tickets POS (cruce independiente).
 *
 * Agrega `md.kdm1` (venta real U/D/10) por sucursal×cajero(c67)×día(c9) y UPSERT a
 * `analytics.pos_ticket_sales`. El motor luego compara este total (capa atómica)
 * contra el total del corte (kdpv_folio_caja, capa agregada) → regla venta_vs_tickets.
 *
 * `[CANON.5.4]` (2026-11-05) — la fuente por default es `kepler_ods.kdm1` (una sola consulta en
 * prod, ~2 s, con `c1 = sucursal` como filtro anti-réplica). Comparación en seco contra la tabla:
 * 4,728 de 4,743 cajero×día idénticos; los 15 distintos son todos de HOY y con el ODS más alto
 * (tickets cobrados después de la corrida anterior). Control negativo (sucursal rotada) en rojo.
 * `--source=branch` conserva la lectura de cada POS. La tabla se queda: volverla vista pide
 * borrarla (regla 5, firma de Edgar).
 *
 * Uso (desde database/):
 *   node importers/kepler/import-pos-ticket-sales.js            # dry-run (ODS: requiere DATABASE_URL_NEW)
 *   DATABASE_URL_NEW='postgres://…' node importers/kepler/import-pos-ticket-sales.js --apply
 *   node importers/kepler/import-pos-ticket-sales.js --source=branch   # POS por sucursal
 */
const knexLib = require('knex');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'ods';
if (!['ods', 'branch'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (ods | branch)`);

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { salesMap, clientConfig } = require('../lib/kepler-branches');
const { loadWarehouseMap } = require('../lib/warehouse-id'); // Paso 2b: warehouse_id inline
const BRANCHES = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();

const toRow = (code) => (x) => ({
  warehouse_code: code || x.wh,
  cajero_code: String(x.cajero).trim(),
  business_date: x.dia,
  ticket_count: Number(x.n),
  ticket_total: Number(x.total) || 0,
});

// Las mismas sumas que readBranch, para todas las sucursales a la vez. `sucursal` es la base de
// origen; `c1 = sucursal` deja sólo los documentos propios (igual que `c1 = $1` en cada POS).
async function readOds() {
  if (!process.env.DATABASE_URL_NEW) throw new Error('source=ods requiere DATABASE_URL_NEW (kepler_ods vive en prod)');
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW, statement_timeout: 120000 });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT sucursal AS wh, c67 AS cajero, c9::date AS dia, COUNT(*)::int AS n, ROUND(SUM(c16::numeric),2) AS total
       FROM kepler_ods.kdm1
       WHERE sucursal = ANY($1) AND c1 = sucursal AND c2='U' AND c3='D' AND c4::text='10' AND c67 IS NOT NULL AND c67 <> ''
       GROUP BY sucursal, c67, c9::date`,
      [BRANCHES.map((b) => b.code)],
    );
    return r.rows.map(toRow(null));
  } finally { await c.end(); }
}

async function readBranch(b) {
  const c = new Client(clientConfig(b, { connectionTimeoutMillis: 6000, statement_timeout: 120000 }));
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
    return r.rows.map(toRow(b.code));
  } finally { await c.end(); }
}

async function upsert(db, rows) {
  const whMap = await loadWarehouseMap(db, TENANT); // Paso 2b
  let n = 0;
  for (const r of rows) {
    const wid = whMap.get(String(r.warehouse_code).trim()) || null;
    await db('analytics.pos_ticket_sales')
      .insert({ tenant_id: TENANT, ...r, warehouse_id: wid })
      .onConflict(['tenant_id', 'warehouse_code', 'cajero_code', 'business_date'])
      .merge({ warehouse_id: wid, ticket_count: r.ticket_count, ticket_total: r.ticket_total, updated_at: db.fn.now() });
    n++;
  }
  return n;
}

(async () => {
  const all = [];
  if (SOURCE === 'ods') {
    const rows = await readOds();
    all.push(...rows);
    for (const b of BRANCHES) console.log(`[ods ${b.code}] ${rows.filter((r) => r.warehouse_code === b.code).length} cajero×día`);
  } else {
    for (const b of BRANCHES) {
      try {
        const rows = await readBranch(b);
        all.push(...rows);
        console.log(`[${b.db}] ${rows.length} cajero×día`);
      } catch (e) { console.warn(`[${b.db}] ERROR: ${e.message}`); }
    }
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
