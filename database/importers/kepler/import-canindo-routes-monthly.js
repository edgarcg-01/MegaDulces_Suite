/* eslint-disable no-console */
/**
 * Canindo (RUTAS) — VENTA A BORDO de las rutas de Canindo desde Kepler '06' →
 * analytics.sales_by_route_monthly, MISMO gold que /comercial/ventas-por-ruta.
 *
 * CONTEXTO: Canindo migró su POS de Wincaja a Kepler ('06'). A diferencia de las hermanas
 * Kepler (donde c63=UD10NN es la CAJA de mostrador, no ruta), Canindo SÍ trae rutas de reparto,
 * identificadas por **kdm1.c67**: `50C0N` = caja de PISO · `500N` = ruta 50N (vendedor del kduv:
 * 5001=501 Victor Zalapa, 5002=502 Daniel Padilla, 5003=503 Jose Zavala, 5004=504 Jose Mota,
 * 5005=505 Francico) · `5050`/`54BCZ` = NO-ruta (mayoreo/transfer, a reconciliar → se excluyen).
 * Encoding confirmado con Edgar 2026-08-18.
 *
 * route_code = 'WIN-50' || NN  → MISMO namespace que el histórico Wincaja (import-wincaja-routes-
 * monthly, ene-jul) → la serie por ruta queda CONTINUA (Wincaja hasta ~13-ago, Kepler desde ~15-ago).
 * Por eso hay que RETIRAR las rutas '50' de import-wincaja-routes-monthly (ya editado) para que
 * no re-upsertee data vieja sobre los meses que ahora cubre Kepler.
 *
 * Venta = c2='U' c3='D' c4=10, unidades = kdm2.c9, importe = kdm2.c13, ticket = kdm1.c6.
 * Lee la RÉPLICA LOCAL kepler_md_06 (kepler-branches → branchUrl('06')). UPSERT acumulativo con
 * GREATEST (la réplica purga historia; un mes ya capturado no baja).
 *
 *   DST_URL=…railway node database/importers/kepler/import-canindo-routes-monthly.js          # dry-run
 *   DST_URL=…            node database/importers/kepler/import-canindo-routes-monthly.js --apply
 *   ... [--year 2026]
 */
const { Client } = require('pg');
const { branchUrl } = require('../lib/kepler-branches');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.CANINDO_SRC || branchUrl('06'); // réplica local kepler_md_06
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

// Rutas de reparto: c67 = '500N' (N=1..9) → ruta 50N. Excluye piso ('50C%') y no-ruta ('5050','54%').
const ROUTE_SALES = `h.c2='U' AND h.c3='D' AND h.c4=10 AND btrim(h.c67) ~ '^500[1-9]$'`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== Canindo RUTAS (Kepler '06') → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
    const wid = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code='06' AND deleted_at IS NULL`, [M])).rows[0]?.id;
    if (!wid) { console.log('  ⚠ no existe warehouse code=06 (¿corriste canindo-identity-06.js?) — abort'); await db.end(); return; }

    const from = `${YEAR}-01-01`;
    const to = `${YEAR + 1}-01-01`;
    const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
    await src.connect();
    let rows;
    try {
      ({ rows } = await src.query(
        `SELECT 'WIN-50' || right(btrim(h.c67),1) AS route_code,
                '50' || right(btrim(h.c67),1)      AS route_no,
                date_trunc('month', h.c9)::date    AS mes,
                count(DISTINCT h.c6)               AS tickets,
                sum(d.c9)::numeric                 AS units,
                sum(d.c13)::numeric                AS revenue
           FROM md.kdm2 d
           JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
          WHERE ${ROUTE_SALES} AND h.c9 >= $1 AND h.c9 < $2
            AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
          GROUP BY 1, 2, 3`, [from, to]));
    } finally { await src.end().catch(() => {}); }

    const routes = new Set(rows.map((r) => r.route_code)).size;
    const rev = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`  origen (kepler_md_06): ${rows.length} filas ruta×mes · ${routes} rutas · revenue $${Math.round(rev).toLocaleString()}`);
    rows.forEach((r) => console.log(`    ${r.route_code} ${r.mes.toISOString().slice(0, 7)}: $${Math.round(Number(r.revenue)).toLocaleString()} · ${r.tickets} tickets`));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió (usar --apply).'); await db.end(); return; }
    if (!rows.length) { console.log('  (0 filas de ruta — nada que upsert)'); await db.end(); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // UPSERT acumulativo GREATEST (la réplica purga; no degradar un mes ya capturado).
    let ups = 0;
    for (const r of rows) {
      await db.query(
        `INSERT INTO analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units=GREATEST(analytics.sales_by_route_monthly.units, EXCLUDED.units),
           revenue=GREATEST(analytics.sales_by_route_monthly.revenue, EXCLUDED.revenue),
           tickets=GREATEST(analytics.sales_by_route_monthly.tickets, EXCLUDED.tickets),
           route_no=EXCLUDED.route_no, updated_at=now()`,
        [M, wid, r.route_code, r.route_no, r.mes, Number(r.units) || 0, Number(r.revenue) || 0, Number(r.tickets) || 0]);
      ups++;
    }
    await db.query('COMMIT');
    console.log(`\n  ✅ APPLY: ${ups} filas ruta×mes upserted (WIN-50X, GREATEST). 5050/54BCZ/piso NO son ruta → excluidos.`);
    await db.end();
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    await db.end().catch(() => {});
    process.exit(1);
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
