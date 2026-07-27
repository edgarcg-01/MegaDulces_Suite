/* eslint-disable no-console */
/**
 * RA-PRO.17 — Velocidad de COMPRA real → analytics.purchase_velocity.
 *
 * Ancla el sugerido de reabasto en el LEDGER de compras reales (entrada X-A-40) en vez de
 * derivarlo de demanda×política×costo — que en el granel se rompía por unidades mezcladas
 * (venta en piezas, compra en cajas, costo per-caja/per-pieza según el producto). El ledger
 * es la única fuente auto-consistente y en dinero real. Validado: a 30d de cobertura reproduce
 * el gasto mensual real por proveedor (Fabricas Selectas $206k ≈ $220k real). Ver FASE_RA.
 *
 * Lee analytics.stock_movements (que ya trae las entradas X-A-40 desde import-stock-movements)
 * en el MISMO DST — no necesita conexión a Kepler. Grano = almacén×producto:
 *   daily_rate     = Σ qty (entrada X-A-40, ventana) / ventana_días   [unidad de COMPRA]
 *   real_unit_cost = Σ amount / Σ qty                                 [costo real por unidad]
 * SOLO los almacenes que compran directo (CEDIS/hubs) reciben filas → el sugerido a proveedor
 * se genera donde de verdad se compra; las sucursales sin compra directa van por traspaso.
 *
 * Idempotente: recomputa TODA la tabla del tenant cada corrida (DELETE + INSERT). Correr en el
 * nightly DESPUÉS de import-stock-movements (que puebla las entradas).
 *
 *   node database/importers/kepler/import-purchase-velocity.js          # dry-run
 *   node database/importers/kepler/import-purchase-velocity.js --apply  # commit
 *   RA_PV_WINDOW_DAYS=120 node ... --apply                              # ventana custom
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const WINDOW = Number(process.env.RA_PV_WINDOW_DAYS || 90);

// Compra REAL a proveedor = entrada Kepler X-A-40 (orden de entrada, donde suma existencia).
// Se agrega por almacén×producto sobre la ventana; el costo real sale del propio movimiento
// (amount preferido; qty*unit_cost como respaldo) → auto-corrige el drift del costo de catálogo.
const SELECT_VELOCITY = `
  SELECT m.warehouse_id, m.product_id,
         SUM(m.qty)                                   AS qty_win,
         SUM(COALESCE(m.amount, m.qty * m.unit_cost)) AS amt_win,
         COUNT(DISTINCT m.doc_date::date)             AS order_days,
         MAX(m.doc_date::date)                        AS last_purchase
    FROM analytics.stock_movements m
   WHERE m.tenant_id = $1
     AND m.movement_kind = 'entrada' AND m.genero = 'X' AND m.doc_type = '40'
     AND m.doc_date >= current_date - $2::int
     AND m.qty > 0
   GROUP BY m.warehouse_id, m.product_id
  HAVING SUM(m.qty) > 0`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Velocidad de compra (X-A-40) → analytics.purchase_velocity (${APPLY ? 'APPLY' : 'DRY-RUN'}) · ventana ${WINDOW}d ===\n`);

    const { rows: preview } = await db.query(`
      SELECT count(*)::int filas,
             round(sum(qty_win)::numeric,0) qty_total,
             round(sum(amt_win)::numeric,0) valor_compra_ventana
        FROM (${SELECT_VELOCITY}) v`, [M, WINDOW]);
    console.table(preview);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`DELETE FROM analytics.purchase_velocity WHERE tenant_id = $1`, [M]);
    const up = await db.query(`
      INSERT INTO analytics.purchase_velocity
        (tenant_id, warehouse_id, product_id, daily_rate, qty_90d, real_unit_cost, order_days, last_purchase, computed_at)
      SELECT $1, v.warehouse_id, v.product_id,
             round(v.qty_win / $2::numeric, 4),
             round(v.qty_win, 2),
             round(v.amt_win / NULLIF(v.qty_win, 0), 4),
             v.order_days, v.last_purchase, now()
        FROM (${SELECT_VELOCITY}) v`, [M, WINDOW]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de velocidad de compra.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
