/* eslint-disable no-console */
/**
 * Puebla analytics.wincaja_product_box_factor = factor de caja de Wincaja (factor_venta) para el
 * DISPLAY de cajas en almacenes ciegos (MD-30/32/50). Su existencia se guarda en la unidad de
 * Wincaja (paquetes en multi-pack); el display de /compras divide por ESTE factor SOLO en esos
 * almacenes (Kepler sigue con el resolver c84). No toca datos ni el reorden (auto-consistente).
 *
 * Set CONFIABLE = doble gate (todo en prod, sin Kepler):
 *   (1) estructural: fv>1 ∧ c84>1 ∧ c81>1 ∧ fv=round(c84/c81)   (la caja de Wincaja anida en Kepler)
 *   (2) costo: costo_promedio de la existencia Wincaja ≈ costo_pieza × c81  (unidad = PAQUETE,
 *       no pieza) — descarta los "vende por pieza aunque tenga paquete".
 *   c84 = analytics.product_box_factor · c81 = product_label_prices.pack_size · costo_pieza = cost_with_tax.
 *
 * Idempotente: UPSERT (IS DISTINCT) + DELETE de lo que ya no califica. Nunca borra si dry-run.
 *
 *   DST_URL=<railway> node database/importers/wincaja/import-wincaja-caja-factor.js --apply
 */
'use strict';

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// Set confiable. Gate de costo: el costo de la existencia (por unidad de stock) debe estar
// MÁS CERCA de costo_pieza×c81 (paquete) que de costo_pieza×1 (pieza) o ×c84 (caja).
const SRC = `
  WITH wf AS (
    SELECT p.id AS product_id, p.sku, max(a.factor_venta::numeric) AS fv
    FROM wincaja.articulos a
    JOIN catalog.products p ON p.tenant_id = a.tenant_id AND p.sku = a.articulo AND p.deleted_at IS NULL
    WHERE a.tenant_id = $1
    GROUP BY p.id, p.sku
  ),
  c81 AS (SELECT product_id, max(pack_size)::numeric AS ps FROM commercial.product_label_prices WHERE tenant_id = $1 GROUP BY product_id),
  wcost AS (
    SELECT p.id AS product_id,
           sum(e.costo_promedio * greatest(e.existencia,0)) / nullif(sum(greatest(e.existencia,0)),0) AS unit_cost
    FROM wincaja.existencias e
    JOIN catalog.products p ON p.tenant_id = e.tenant_id AND p.sku = e.articulo AND p.deleted_at IS NULL
    WHERE e.tenant_id = $1 AND e.almacen IN ('30','32','50') AND e.costo_promedio > 0
    GROUP BY p.id
  )
  SELECT wf.product_id, wf.fv AS factor_venta
  FROM wf
  JOIN analytics.product_box_factor pbf ON pbf.tenant_id = $1 AND pbf.product_id = wf.product_id
  JOIN c81 ON c81.product_id = wf.product_id
  JOIN catalog.products p ON p.id = wf.product_id
  LEFT JOIN wcost ON wcost.product_id = wf.product_id
  WHERE wf.fv > 1 AND pbf.box_factor > 1 AND c81.ps > 1
    AND wf.fv = round(pbf.box_factor / c81.ps)                    -- (1) anida
    AND p.cost_with_tax > 0 AND wcost.unit_cost > 0               -- (2) hay costo para validar
    -- costo por unidad de stock más cerca de piece×c81 (paquete) que de piece×1 o piece×c84
    AND abs(ln(wcost.unit_cost / (p.cost_with_tax * c81.ps)))
      < abs(ln(wcost.unit_cost / p.cost_with_tax))                -- más cerca de paquete que de pieza
    AND abs(ln(wcost.unit_cost / (p.cost_with_tax * c81.ps)))
      < abs(ln(wcost.unit_cost / (p.cost_with_tax * pbf.box_factor)))  -- más cerca de paquete que de caja
`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== WINCAJA CAJA FACTOR → analytics.wincaja_product_box_factor (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const s = await db.query(`SELECT count(*)::int n FROM (${SRC}) x`, [M]);
    console.log(`  set confiable (anida + costo=paquete): ${s.rows[0].n} SKUs`);
    const sample = await db.query(`SELECT p.sku, x.factor_venta FROM (${SRC}) x JOIN catalog.products p ON p.id = x.product_id ORDER BY p.sku LIMIT 8`, [M]);
    console.table(sample.rows);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_wcf ON COMMIT DROP AS ${SRC}`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.wincaja_product_box_factor AS t (tenant_id, product_id, factor_venta, computed_at)
       SELECT $1, product_id, factor_venta, now() FROM stg_wcf
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET factor_venta = EXCLUDED.factor_venta, computed_at = now()
       WHERE t.factor_venta IS DISTINCT FROM EXCLUDED.factor_venta`, [M]);
    const del = await db.query(
      `DELETE FROM analytics.wincaja_product_box_factor t
        WHERE t.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM stg_wcf s WHERE s.product_id = t.product_id)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas/actualizadas · ${del.rowCount} borradas.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
