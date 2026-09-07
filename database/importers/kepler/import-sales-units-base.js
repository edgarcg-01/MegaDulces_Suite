/* eslint-disable no-console */
/**
 * ⛔ CÓDIGO MUERTO — NO CORRER. `analytics.sales_daily.units_base` está 100% en NULL en prod
 * (defecto #6 de docs/UNIDADES_DE_MEDIDA.md §8, abierto) y el experimento quedó retirado
 * (FASE_MR_COSTO_Y_UNIDAD §"units_base"). Se conserva por trazabilidad del método, no por uso.
 *
 * Y su premisa central era falsa: el `√factor_sale` de abajo era el punto medio geométrico entre
 * "costo por pieza" y "costo por caja" **porque no se sabía en qué peldaño estaba `cost_with_tax`**.
 * U.0 (2026-09-03) lo midió: `cost_with_tax = u1_cost × (1 + impuesto)` — está en el peldaño
 * BASE/SUELTO, con las razones agrupadas en 1.0000 / 1.0800 / 1.1600 / 1.2400 exactas a 4 decimales
 * sobre 6,626 SKUs. Ya no hay ambigüedad que promediar: el ancla es `cost_with_tax` a secas.
 * Ver docs/UNIDADES_DE_MEDIDA.md §8quater.
 *
 * RA-PRO.14 — Normaliza analytics.sales_daily.units → units_base en CAJAS (unidad canónica).
 *
 * `sales_daily.units` mezcla unidades por canal (ver reference_box_factor_factor_sale):
 *   · Wincaja (`wincaja_*`)  → vende CAJAS   → units_base = units (tal cual)
 *   · Kepler POS (`tienda`/`credito`, sin prefijo) → vende PIEZAS sueltas (y a veces cajas).
 *     Resuelve por fila con el punto medio geométrico entre costo/pieza y costo/caja:
 *     fila en PIEZAS si  revenue/units < cost_with_tax / √factor_sale  → units / factor_sale.
 *     Si no (caja, sin ancla de costo, o factor_sale ≤ 1) → units tal cual.
 *
 * stock (kdil), cost_with_tax (costo_civa) y compras (min_order_boxes) viven en CAJAS, por eso
 * la canónica es la caja. Consumido por import-inventory-health (demanda → reorden en cajas).
 *
 * Idempotente: recomputa units_base en toda la ventana (default 400d) cada corrida. Correr
 * DESPUÉS de los feeds de venta (import-sales-fact + Wincaja) y ANTES de import-inventory-health.
 *
 *   node database/importers/kepler/import-sales-units-base.js          # dry-run (muestra impacto)
 *   node database/importers/kepler/import-sales-units-base.js --apply  # commit
 *   RA_UNITSBASE_LOOKBACK_DAYS=730 node ... --apply                    # ventana custom
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const LOOKBACK = Number(process.env.RA_UNITSBASE_LOOKBACK_DAYS || 400);

// Regla híbrida canal + precio (idéntica en dry-run y apply).
const RULE = `
  CASE
    WHEN sd.channel LIKE 'wincaja%' THEN sd.units
    WHEN p.factor_sale > 1 AND p.cost_with_tax > 0 AND sd.units > 0
         AND (sd.revenue / sd.units) < p.cost_with_tax / sqrt(p.factor_sale)
      THEN sd.units / p.factor_sale
    ELSE sd.units
  END`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== sales_daily.units_base → CAJAS (${APPLY ? 'APPLY' : 'DRY-RUN'}) · ventana ${LOOKBACK}d ===\n`);

    // Impacto: cuánto colapsa la venta al normalizar (piezas → cajas), por canal.
    const { rows: imp } = await db.query(`
      SELECT sd.channel,
             count(*) filas,
             round(sum(sd.units)) AS units_crudo,
             round(sum(${RULE})) AS units_base,
             round(sum(sd.units) - sum(${RULE})) AS colapso
        FROM analytics.sales_daily sd
        JOIN catalog.products p ON p.tenant_id = sd.tenant_id AND p.id = sd.product_id
       WHERE sd.tenant_id = $1 AND sd.sale_date >= current_date - $2::int
       GROUP BY sd.channel ORDER BY colapso DESC NULLS LAST`, [M, LOOKBACK]);
    console.table(imp);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Quitá --dry-run… corré con --apply.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const res = await db.query(`
      UPDATE analytics.sales_daily sd
         SET units_base = ${RULE}
        FROM catalog.products p
       WHERE sd.tenant_id = $1 AND p.tenant_id = sd.tenant_id AND p.id = sd.product_id
         AND sd.sale_date >= current_date - $2::int
         AND sd.units_base IS DISTINCT FROM (${RULE})`, [M, LOOKBACK]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} filas normalizadas.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
