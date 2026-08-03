/* eslint-disable no-console */
/**
 * RA-PRO.17.1 — Demanda LIMPIA por almacén × producto → analytics.product_demand.
 *
 * Lee analytics.sales_daily (misma DB, NO toca Kepler) y normaliza la unidad vía
 * REVENUE, que es agnóstico a si el almacén vende por caja o por pieza:
 *
 *   precio_pieza(producto) = MIN( revenue/units )  entre almacenes con venta real
 *                            (la pieza es siempre la unidad más granular → menor $/u)
 *   RA-PRO.29.2: para BOXED (factor_sale>1) el precio_pieza = MAX(MIN, cost_with_tax) — piso de
 *                costo que evita contar sub-porciones cuando el dulce se vende suelto en retail.
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
      pf AS (
        SELECT id AS product_id, COALESCE(factor_sale, 1)::numeric AS fs,
               COALESCE(cost_with_tax, 0)::numeric AS cwt
          FROM catalog.products WHERE tenant_id = $1
      ),
      pp AS (
        -- RA-PRO.29.2 / RA-PRO.35 — PISO DE COSTO por PIEZA para no inflar boxed vendido suelto.
        -- El MIN($/u) toma la unidad más granular; para un dulce BOXED (fs>1) que se vende SUELTO
        -- en retail, un glitch podría dejar el MIN por debajo del costo → cuenta sub-porciones.
        -- El piso protege contra eso. CLAVE (RA-PRO.35): cost_with_tax es costo por CAJA (bruto),
        -- NO por pieza — verificado: para fs∈{12,20,24,…} cost_with_tax ≈ fs × costo-pieza. Usar
        -- cost_with_tax crudo como piso por pieza lo eleva 10-40× y APLASTA la demanda real
        -- (33027: rutas venden a $9.65/pz pero el piso lo forzaba a $90 → demanda /9×). Fix: el
        -- piso va en la MISMA unidad que el precio-pieza → cost_with_tax / factor_sale. Granel
        -- (fs<=1, kg/cubeta con SUF) queda intacto.
        SELECT wp.product_id,
               CASE WHEN COALESCE(pf.fs, 1) > 1 AND COALESCE(pf.cwt, 0) > 0
                    THEN GREATEST(min(wp.rev / wp.u), pf.cwt / pf.fs)
                    ELSE min(wp.rev / wp.u) END AS piece_price
          FROM wp LEFT JOIN pf ON pf.product_id = wp.product_id
         WHERE wp.u >= 3 AND wp.rev >= 0.5
         GROUP BY wp.product_id, pf.fs, pf.cwt
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
    // Refresco IDEMPOTENTE de la ventana: staging TEMP (server-side) → UPSERT que solo escribe
    // las filas cambiadas → DELETE solo lo que salió del origen. Antes: DELETE-window+INSERT
    // reescribía toda la ventana cada corrida (churn = costo Railway).
    await db.query(
      `CREATE TEMP TABLE stg_demand ON COMMIT DROP AS ${CTE}
       SELECT $1::uuid AS tenant_id, wp.warehouse_id, wp.product_id, $2::int AS window_days,
              (wp.rev / pp.piece_price) AS pieces, wp.rev AS revenue,
              (wp.rev / pp.piece_price) / $2::numeric AS daily_pieces, wp.rev / $2::numeric AS daily_revenue,
              pp.piece_price, now() AS computed_at
         FROM wp JOIN pp USING (product_id) ${WHERE}`, [M, DAYS]);
    const up = await db.query(
      `INSERT INTO analytics.product_demand AS d
         (tenant_id, warehouse_id, product_id, window_days, pieces, revenue, daily_pieces, daily_revenue, piece_price, computed_at)
       SELECT tenant_id, warehouse_id, product_id, window_days, pieces, revenue, daily_pieces, daily_revenue, piece_price, computed_at
         FROM stg_demand
       ON CONFLICT (tenant_id, warehouse_id, product_id, window_days) DO UPDATE SET
         pieces=EXCLUDED.pieces, revenue=EXCLUDED.revenue, daily_pieces=EXCLUDED.daily_pieces,
         daily_revenue=EXCLUDED.daily_revenue, piece_price=EXCLUDED.piece_price, computed_at=now()
       WHERE (d.pieces, d.revenue, d.daily_pieces, d.daily_revenue, d.piece_price)
             IS DISTINCT FROM
             (EXCLUDED.pieces, EXCLUDED.revenue, EXCLUDED.daily_pieces, EXCLUDED.daily_revenue, EXCLUDED.piece_price)`);
    const del = await db.query(
      `DELETE FROM analytics.product_demand d
        WHERE d.tenant_id = $1 AND d.window_days = $2
          AND NOT EXISTS (SELECT 1 FROM stg_demand s
                           WHERE s.warehouse_id = d.warehouse_id AND s.product_id = d.product_id)`, [M, DAYS]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (desaparecidas).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
