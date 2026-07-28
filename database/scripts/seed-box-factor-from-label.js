/* eslint-disable no-console */
/**
 * RA-PRO.29.4 — Barrido GLOBAL: corrige el factor de caja del dulce/chicle vendido SUELTO.
 *
 * Problema: `catalog.products.factor_sale` guarda PAQUETES por caja (c81 de Kepler), pero la
 * demanda limpia (`analytics.product_demand.pieces`) se cuenta en PIEZAS individuales (el dulce
 * se vende suelto en retail). El motor divide la demanda por factor_sale (paquetes) en vez del
 * Pz/Cja real (piezas por caja) → infla el pedido 6-40×. El piso de costo (RA-PRO.29.2) solo
 * atrapa el caso donde el precio suelto cae por debajo del costo (NUCITA); estos quedan por
 * encima y se colaban (tag `unit_source='revisar'`).
 *
 * Fuente del Pz/Cja: `commercial.product_label_prices.box_size` = factor de la etiqueta 'CJA' de
 * Kepler (kdii, ver import-label-data.js). Cumple `box_size = factor_sale × pack_size`.
 *
 * Fix: sembrar `commercial.product_unit_overrides.box_factor = box_size` (SUF=1) para los SKUs
 * donde `box_size > factor_sale > 1` (factor_sale=paquetes) con demanda. Guardas:
 *   - `box_size = factor_sale × pack_size` (relación limpia; descarta datos raros).
 *   - excluye EXH/EXHIBIDOR (los displays traen conteo de exhibidor ≠ caja de compra → sobre-corrigen).
 *   - solo con demanda 30d y sin override activo (idempotente).
 * Validado: la demanda/mes resultante queda del mismo orden que la compra real (purchase_velocity).
 * Control: SARAMEL (box_size NULL) y salsas (box_size=factor_sale) NO entran — su factor ya es correcto.
 *
 *   PGURL=<prod>  node database/scripts/seed-box-factor-from-label.js          # dry-run
 *   PGURL=<prod>  node database/scripts/seed-box-factor-from-label.js --apply  # commit
 */

const { Pool } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.PGURL || process.env.DATABASE_URL_NEW;
const APPLY = process.argv.includes('--apply');

const SELECT = `
  SELECT p.id, p.sku, left(p.nombre, 34) AS nombre, p.factor_sale AS fs, l.box_size, l.pack_size
    FROM catalog.products p
    JOIN commercial.product_label_prices l ON l.tenant_id = p.tenant_id AND l.product_id = p.id
   WHERE p.tenant_id = $1 AND p.activo = true
     AND COALESCE(p.factor_sale, 1) > 1 AND l.box_size > p.factor_sale
     AND l.pack_size > 1 AND l.box_size = p.factor_sale * l.pack_size
     AND p.nombre !~* 'EXH|EXHIB'
     AND EXISTS (SELECT 1 FROM analytics.product_demand d
                  WHERE d.tenant_id = p.tenant_id AND d.product_id = p.id AND d.window_days = 30 AND d.pieces > 0)
     AND NOT EXISTS (SELECT 1 FROM commercial.product_unit_overrides u
                      WHERE u.tenant_id = p.tenant_id AND u.product_id = p.id AND u.deleted_at IS NULL)`;

(async () => {
  if (!DST) { console.error('Falta PGURL / DATABASE_URL_NEW'); process.exit(2); }
  const pool = new Pool({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  const cli = await pool.connect();
  try {
    const rows = (await cli.query(SELECT, [T])).rows;
    console.log(`\n=== box_factor = Pz/Cja (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${rows.length} SKU(s) ===\n`);
    rows.slice(0, 12).forEach((r) => console.log(`  ${r.sku}  ${String(r.nombre).padEnd(35)} fs=${String(r.fs).padStart(3)} → box_factor=${r.box_size}`));
    if (rows.length > 12) console.log(`  … +${rows.length - 12} más`);
    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }
    let ins = 0;
    for (const r of rows) {
      await cli.query(
        `INSERT INTO commercial.product_unit_overrides(tenant_id, product_id, pieces_per_unit, box_factor, sold_as, note)
         VALUES ($1, $2, 1, $3, 'box', 'RA-PRO.29.4 global box_size=Pz/Cja')`, [T, r.id, r.box_size]);
      ins++;
    }
    console.log(`\n[APPLY] ${ins} overrides insertados.`);
  } catch (e) {
    console.error('ERROR:', e.message); process.exitCode = 1;
  } finally { cli.release(); await pool.end(); }
})();
