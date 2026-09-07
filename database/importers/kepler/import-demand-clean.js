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
// RA-PRO.40 — piloto demanda MONEY-ANCHORED: para las marcas en scope, el precio-unidad
// = cja_price/box_factor (precio de venta REAL de la unidad, ej. PAQ) en vez del MIN($/u),
// que tomaba precios sub-unidad (indiv/glitch) e inflaba la demanda hasta ~8-16×. Fuera del
// scope o sin cja_price → lógica MIN+piso previa intacta. Ampliar el LIKE tras validar por marca.
const MONEY_BRAND_LIKE = process.env.MONEY_ANCHOR_BRAND_LIKE || '%rosa%';

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
      WITH wl AS (
        -- FRESCURA POR ALMACÉN (RA-PRO.41): la ventana se ancla al último día que ESE almacén
        -- reportó venta, no a current_date. Si un feed se atrasa (MD-30/32 iban 4 días atrás;
        -- rutas 501-505 llevaban 17 sin push) la ventana fija diluía su demanda ~día/30 por día
        -- de atraso → el pedido salía corto justo en los almacenes más grandes. Con el anclaje,
        -- demanda = sus últimos $2 días CON datos. Tope 21 días: más viejo = almacén inactivo
        -- (RUTA-322 muerta desde jun) → fuera (demanda 0, la fila se borra por delete-not-seen).
        -- sale_date <= current_date filtra filas basura con fecha futura (hay un 2026-12-05).
        SELECT warehouse_id, max(sale_date) AS last_d
          FROM analytics.sales_daily
         WHERE tenant_id = $1 AND sale_date <= current_date
         GROUP BY warehouse_id
        HAVING current_date - max(sale_date) <= 21
      ),
      wp AS (
        SELECT sd.product_id, sd.warehouse_id,
               sum(sd.units)::numeric   AS u,
               sum(sd.revenue)::numeric AS rev
          FROM analytics.sales_daily sd
          JOIN wl ON wl.warehouse_id = sd.warehouse_id
         WHERE sd.tenant_id = $1
           AND sd.sale_date > wl.last_d - $2::int AND sd.sale_date <= wl.last_d
           AND sd.channel NOT IN ('mayoreo')  -- =TI% traspaso interno CEDIS→suc, no es demanda de venta
         GROUP BY sd.product_id, sd.warehouse_id
      ),
      pf AS (
        SELECT id AS product_id, COALESCE(factor_sale, 1)::numeric AS fs,
               COALESCE(cost_with_tax, 0)::numeric AS cwt
          FROM catalog.products WHERE tenant_id = $1
      ),
      pp AS (
        -- RA-PRO.40 (piloto): para marcas en scope con precio de caja, el precio-unidad =
        -- cja_price/box_factor (precio de venta REAL de la unidad — PAQ), money-anchored. Corrige
        -- que el MIN($/u) tomaba precios sub-unidad y ×8-16 la demanda (70056: 2103 vs ~120 PAQ/día
        -- reales verificado en Kepler). Fuera de scope o sin cja_price → lógica MIN+piso previa:
        -- RA-PRO.29.2/35 — PISO DE COSTO por PIEZA para no inflar boxed vendido suelto: para
        -- fs∈{2..48} con cwt/fs ≥ $1 el piso va = cwt/fs, fuera de ese rango (factor basura o
        -- granel) se conserva el piso CRUDO cwt.
        --
        -- ⛔ U.0 (2026-09-03) — LA PREMISA DE ESE /fs ES FALSA.
        -- OJO: sin backticks en este comentario — va dentro de un template literal de JS.
        -- Este comentario decía que cost_with_tax es "costo por CAJA (bruto)". MEDIDO contra la
        -- escalera del ERP (analytics.v_supplier_cost_ladder) sobre 6,626 SKUs / $116.8M de venta
        -- 90d: la razón cost_with_tax / u1_cost se agrupa en múltiplos de IMPUESTO exactos a 4
        -- decimales —1.0000 exento (960 SKUs) · 1.0800 IVA 8% (1,886 · $69.3M) · 1.1600 IVA 16%
        -- (1,507) · 1.2400 IVA+IEPS (1,987 · $29.8M)— y NO en factores de unidad (la razón contra
        -- box_cost es 0.058). O sea cost_with_tax = u1_cost × (1 + impuesto): peldaño BASE/SUELTO.
        --
        -- Consecuencia: cwt/fs deja el piso fs veces más BAJO de lo que debe, así que min(rev/u)
        -- gana más seguido y piece_price puede quedarse en un precio sub-unidad →
        -- daily_pieces = revenue / piece_price sale INFLADO, que es justo lo que el piso existe
        -- para evitar. El piso correcto es pf.cwt a secas (la rama ELSE).
        -- NO se corrige acá a propósito: daily_pieces es el numerador de todo /compras/pedido y su
        -- peldaño ya flota con el mix de precios de la red (ver el min(rev/u) de arriba).
        -- Estabilizarlo es MR.7.1 (persistir el peldaño), no un parche de una línea.
        -- Ver docs/UNIDADES_DE_MEDIDA.md 8quater.
        SELECT wp.product_id,
               CASE
                 WHEN b.nombre ILIKE '${MONEY_BRAND_LIKE}' AND bp.cja_price > 0 AND vbf.box_factor > 0
                   THEN bp.cja_price / vbf.box_factor
                 WHEN COALESCE(pf.fs, 1) > 1 AND COALESCE(pf.cwt, 0) > 0
                   THEN CASE WHEN pf.fs <= 48 AND pf.cwt / pf.fs >= 1
                             THEN GREATEST(min(wp.rev / wp.u), pf.cwt / pf.fs)
                             ELSE GREATEST(min(wp.rev / wp.u), pf.cwt) END
                 ELSE min(wp.rev / wp.u) END AS piece_price
          FROM wp
          LEFT JOIN pf ON pf.product_id = wp.product_id
          LEFT JOIN catalog.products p3 ON p3.tenant_id = $1 AND p3.id = wp.product_id
          LEFT JOIN catalog.brands   b  ON b.id = p3.brand_id
          LEFT JOIN analytics.product_box_price   bp  ON bp.tenant_id = $1 AND bp.product_id = wp.product_id AND bp.cja_price > 0
          LEFT JOIN analytics.v_product_box_factor vbf ON vbf.tenant_id = $1 AND vbf.product_id = wp.product_id
         WHERE wp.u >= 3 AND wp.rev >= 0.5
         GROUP BY wp.product_id, pf.fs, pf.cwt, b.nombre, bp.cja_price, vbf.box_factor
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

    // Frescura por almacén — que el atraso de un feed no pase en silencio ("que no se nos pase nada").
    const fresh = await db.query(`
      SELECT w.code, current_date - max(sd.sale_date) AS lag_d,
             CASE WHEN current_date - max(sd.sale_date) > 21 THEN 'INACTIVO (demanda 0)'
                  WHEN current_date - max(sd.sale_date) > 1  THEN 'ventana desplazada' END AS estado
        FROM analytics.sales_daily sd
        JOIN commercial.warehouses w ON w.id = sd.warehouse_id AND w.tenant_id = sd.tenant_id
       WHERE sd.tenant_id = $1 AND sd.sale_date <= current_date AND sd.sale_date >= current_date - 90
       GROUP BY w.code
      HAVING current_date - max(sd.sale_date) > 1
       ORDER BY 2 DESC`, [M]);
    if (fresh.rows.length) {
      console.log(`  ⚠ almacenes con feed atrasado (la ventana se ancla a su último día con datos):`);
      for (const f of fresh.rows) console.log(`     ${f.code}: ${f.lag_d} día(s) — ${f.estado}`);
    }

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
