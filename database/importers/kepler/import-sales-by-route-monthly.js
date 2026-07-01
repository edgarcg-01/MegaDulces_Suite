/* eslint-disable no-console */
/**
 * RR.2 — Feed de VENTA REAL por sucursal × RUTA × mes → Railway
 * (analytics.sales_by_route_monthly). Base del reporte /comercial/ventas-por-ruta.
 *
 * Ruta = serie del folio Kepler `kdm1.c63` (formato `UD`+almacén+ruta; ej.
 * `UD1003` = PH ruta 03 = "md_01-003"). Venta = docs `c2='U' c3='D' c4=10`,
 * unidades = kdm2.c9, importe = kdm2.c13, ticket = kdm1.c6 (folio).
 *
 * Lee los 6 servidores Kepler de sucursal EN VIVO (192.168.x). Como esos
 * servidores PURGAN historia (PH retiene ~días), el upsert es ACUMULATIVO con
 * GREATEST: nunca baja un mes ya capturado, solo lo sube si la fuente trae más.
 * Historia por ruta se construye HACIA ADELANTE. NO usa mart.ventas (no lleva c63).
 *
 *   DST_URL=postgresql://…railway node database/importers/kepler/import-sales-by-route-monthly.js          # dry-run
 *   DST_URL=…                     node database/importers/kepler/import-sales-by-route-monthly.js --apply   # commit
 *   ... [--year 2026]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

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

const SALES = `h.c2='U' AND h.c3='D' AND h.c4=10`;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    console.log(`\n=== VENTA mensual por RUTA → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);

    // Tabla (idempotente) — permite correr antes de la migración formal.
    await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics.sales_by_route_monthly (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      warehouse_id uuid NOT NULL, route_code text NOT NULL, route_no text,
      month date NOT NULL, units numeric NOT NULL DEFAULT 0, revenue numeric NOT NULL DEFAULT 0,
      tickets integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sbrm ON analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, month)`);

    const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));
    console.log(`  lookup: ${whTo.size} warehouses`);

    const from = `${YEAR}-01-01`;
    const to = `${YEAR + 1}-01-01`;
    const all = []; // [warehouse_id, route_code, route_no, month, units, revenue, tickets]

    for (const b of BRANCHES) {
      const wid = whTo.get(b.code);
      if (!wid) { console.log(`  ⚠️  sucursal ${b.code} sin warehouse en destino — skip`); continue; }
      const src = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 8000, statement_timeout: 120000 });
      const t0 = Date.now();
      try {
        await src.connect();
        const { rows } = await src.query(
          `SELECT rtrim(btrim(h.c63),'-') AS route_code,
                  substring(rtrim(btrim(h.c63),'-') from '([0-9]{2})$') AS route_no,
                  date_trunc('month', h.c9)::date AS mes,
                  count(DISTINCT h.c6) AS tickets,
                  sum(d.c9)::numeric  AS units,
                  sum(d.c13)::numeric AS revenue
             FROM md.kdm2 d
             JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
            WHERE ${SALES} AND h.c9 >= $1 AND h.c9 < $2
              AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> '' AND btrim(coalesce(h.c63,'')) <> ''
            GROUP BY 1, 2, 3`, [from, to]);
        for (const r of rows) {
          if (!r.route_code) continue;
          all.push([wid, r.route_code, r.route_no, r.mes, Number(r.units) || 0, Number(r.revenue) || 0, Number(r.tickets) || 0]);
        }
        const routes = new Set(rows.map((r) => r.route_code)).size;
        console.log(`  ✅ ${b.db} (${b.code}): ${rows.length} filas ruta×mes · ${routes} rutas (${Date.now() - t0}ms)`);
      } catch (e) {
        console.log(`  ❌ ${b.db} (${b.code}): ${e.message}`);
      } finally {
        try { await src.end(); } catch { /* noop */ }
      }
    }
    console.log(`\n  total a upsert: ${all.length} filas`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // UPSERT acumulativo: GREATEST evita degradar un mes ya capturado cuando la
    // sucursal viva ya purgó parte de ese mes.
    const BATCH = 500;
    let upserts = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      // 8 params por fila: tenant + [warehouse_id, route_code, route_no, month, units, revenue, tickets]
      const vals = chunk.map((_, ri) => { const b = ri * 8; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`; });
      const params = []; chunk.forEach((row) => params.push(M, row[0], row[1], row[2], row[3], row[4], row[5], row[6]));
      const res = await db.query(
        `INSERT INTO analytics.sales_by_route_monthly
           (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units   = GREATEST(analytics.sales_by_route_monthly.units,   EXCLUDED.units),
           revenue = GREATEST(analytics.sales_by_route_monthly.revenue, EXCLUDED.revenue),
           tickets = GREATEST(analytics.sales_by_route_monthly.tickets, EXCLUDED.tickets),
           route_no = COALESCE(EXCLUDED.route_no, analytics.sales_by_route_monthly.route_no),
           updated_at = now()`, params);
      upserts += res.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${upserts} filas upserted en analytics.sales_by_route_monthly.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
