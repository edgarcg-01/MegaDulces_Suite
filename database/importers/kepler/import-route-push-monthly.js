/* eslint-disable no-console */
/**
 * RR — Feed: VENTA A BORDO de las rutas del PUSH (camionetas Kepler local) →
 * `analytics.sales_by_route_monthly`, el gold que consume /comercial/ventas-por-ruta.
 *
 * Contexto (cutover fin de junio 2026): las rutas de PH migraron de las Access `.mdb`
 * de Wincaja (fuente legacy, congelada ~06-27) al PUSH: cada camioneta corre un Kepler
 * local y su `push-ruta.cmd` sube la venta cada 15 min al runner consolidado
 * (`192.168.0.249:5433/kepler_consolidado` → `mart.ventas`, `sucursal='ruta_NN'`).
 * Ese push llega FRESCO pero no había puente hacia la plataforma → el reporte mostraba
 * julio vacío. Este feed cierra ese puente.
 *
 * Escribe con el MISMO namespace que Wincaja (`route_code = 'WIN-<NN>'`, warehouse = la
 * sucursal madre por el prefijo del almacén, ej. '01-003' → '01') para que sea UNA sola
 * fila continua por ruta (Wincaja ene–jun histórico + push jul→ actual). UPSERT GREATEST:
 * julio crece con los días; junio (2 días del push) nunca degrada el mes completo Wincaja.
 * Compatible con import-wincaja-routes-monthly (ahora UPSERT, no borra el namespace).
 *
 *   SRC_URL=…@192.168.0.249:5433/kepler_consolidado (default)
 *   DST_URL / DATABASE_URL_NEW = destino (prod Railway)
 *
 *   DST_URL=…railway node database/importers/kepler/import-route-push-monthly.js           # dry-run
 *   DST_URL=…             node database/importers/kepler/import-route-push-monthly.js --apply
 *   ... [--year 2026]
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || 'postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  try {
    console.log(`\n=== VENTA en ruta (PUSH .249) → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
    try { await src.connect(); }
    catch (e) { console.error(`❌ sin conexión al runner .249 (${e.message}) — abortando`); process.exitCode = 1; return; }

    const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;
    // Agrego mart.ventas (line-level) → ruta × mes. warehouse = prefijo del almacén ('01-003' → '01').
    // route_no = número tras 'ruta_'. tickets = folios distintos.
    const { rows } = await src.query(
      `SELECT COALESCE(NULLIF(split_part(max(almacen), '-', 1), ''), '01') AS wcode,
              substring(sucursal from 'ruta_(.*)') AS route_no,
              date_trunc('month', fecha)::date AS month,
              sum(cantidad)::numeric AS units,
              sum(importe)::numeric  AS revenue,
              count(DISTINCT folio)::int AS tickets
         FROM mart.ventas
        WHERE sucursal LIKE 'ruta_%' AND fecha >= $1 AND fecha < $2 AND fecha <= CURRENT_DATE
        GROUP BY sucursal, date_trunc('month', fecha)`,
      [from, to],
    );
    if (!rows.length) { console.log('sin ventas de ruta en el runner para el rango — nada que hacer.'); return; }

    const routes = new Set(rows.map((r) => r.route_no)).size;
    const rev = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`  origen (runner): ${rows.length} filas ruta×mes · ${routes} rutas · $${Math.round(rev).toLocaleString()}`);
    for (const r of rows.slice(0, 20)) {
      console.log(`    ${r.wcode} · ruta ${r.route_no} · ${r.month.toISOString().slice(0, 7)} · $${Math.round(Number(r.revenue)).toLocaleString()} · ${r.tickets} tickets`);
    }

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    // warehouse code → id
    const whs = (await dst.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    const payload = rows.filter((r) => whTo.has(r.wcode) && r.route_no);
    const skipped = rows.length - payload.length;
    let upserts = 0;
    const BATCH = 500;
    for (let i = 0; i < payload.length; i += BATCH) {
      const chunk = payload.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => { const b = ri * 8; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`; });
      const params = [];
      for (const r of chunk) params.push(M, whTo.get(r.wcode), `WIN-${r.route_no}`, r.route_no, r.month, r.units, r.revenue, r.tickets);
      // GREATEST: no degrada el mes completo Wincaja (junio); julio crece con los días del push.
      const res = await dst.query(
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
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${upserts} filas WIN-<ruta> upserted${skipped ? ` · ${skipped} sin warehouse resuelto (omitidas)` : ''}.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
