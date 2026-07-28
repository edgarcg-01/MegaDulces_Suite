/* eslint-disable no-console */
/**
 * RA-PRO.17.1 — Demanda LIMPIA por almacén × producto → analytics.product_demand.
 *
 * Lee analytics.sales_daily (misma DB, NO toca Kepler) y normaliza la unidad vía
 * REVENUE, que es agnóstico a si el almacén vende por caja o por pieza:
 *
 *   precio_pieza(producto) = MIN( revenue/units )  entre almacenes con venta real
 *                            (la pieza es siempre la unidad más granular → menor $/u)
 *   piezas_limpias(almacén, producto) = revenue(almacén) / precio_pieza(producto)
 *
 * Guardas: solo filas con units≥3 y revenue≥0.5 cuentan para el MIN (mata SKUs basura
 * precio-$0 y glitches de 1 pieza). Ventana 30d por default.
 *
 *   DATABASE_URL_NEW=…            node database/importers/kepler/import-demand-clean.js          # dry-run
 *   DST_URL=…railway              node database/importers/kepler/import-demand-clean.js --apply  # commit
 *   ... [--days 30]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const DAYS = di !== -1 ? Number(process.argv[di + 1]) : 30;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    console.log(`\n=== DEMANDA LIMPIA → analytics.product_demand (${APPLY ? 'APPLY' : 'DRY-RUN'}, ${DAYS}d) ===\n`);

    // Computo server-side (barato, todo dentro de la DB). precio_pieza por producto =
    // MIN($/u) entre almacenes "confiables" (units≥3, revenue≥0.5). Luego piezas
    // limpias = revenue/precio_pieza para TODOS los almacenes (incl. caja-vendedores).
    // CTE base (sin proyección) — reutilizado por el resumen y por el INSERT..SELECT.
    const CTE = `
      WITH wp AS (
        SELECT product_id, warehouse_id,
               sum(units)::numeric   AS u,
               sum(revenue)::numeric AS rev
          FROM analytics.sales_daily
         WHERE tenant_id = $1 AND sale_date >= current_date - $2::int
         GROUP BY product_id, warehouse_id
      ),
      pp AS (
        SELECT product_id, min(rev / u) AS piece_price
          FROM wp
         WHERE u >= 3 AND rev >= 0.5
         GROUP BY product_id
      )`;
    const WHERE = `WHERE pp.piece_price > 0 AND wp.rev > 0`;

    const summary = await db.query(
      `${CTE}
       SELECT count(*)::int filas,
              round(sum(wp.rev / pp.piece_price))::numeric piezas,
              round(sum(wp.rev))::numeric revenue
         FROM wp JOIN pp USING (product_id) ${WHERE}`, [M, DAYS]);
    const s = summary.rows[0];
    console.log(`  filas almacén×producto: ${Number(s.filas).toLocaleString()} · piezas limpias=${Number(s.piezas).toLocaleString()} · revenue=$${Number(s.revenue).toLocaleString()}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // Refresco full de la ventana: borra el window_days del tenant e inserta server-side.
    await db.query(`DELETE FROM analytics.product_demand WHERE tenant_id = $1 AND window_days = $2`, [M, DAYS]);
    const ins = await db.query(
      `${CTE}
       INSERT INTO analytics.product_demand
         (tenant_id, warehouse_id, product_id, window_days, pieces, revenue, daily_pieces, daily_revenue, piece_price, computed_at)
       SELECT $1::uuid, wp.warehouse_id, wp.product_id, $2::int,
              (wp.rev / pp.piece_price),
              wp.rev,
              (wp.rev / pp.piece_price) / $2::numeric,
              wp.rev / $2::numeric,
              pp.piece_price, now()
         FROM wp JOIN pp USING (product_id) ${WHERE}`, [M, DAYS]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${ins.rowCount} filas en analytics.product_demand.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
