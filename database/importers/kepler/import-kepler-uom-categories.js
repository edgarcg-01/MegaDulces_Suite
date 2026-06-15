/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.products: unidad de medida + categorías reales.
 *
 * Decidido con Edgar (2026-06-15):
 *   - UoM: Kepler manda. unit_sale + unit_purchase ← kdii.c11 (catálogo kdid:
 *     PZA/PAQ/CJA/KG). Corrige el over-default a PZA del sync previo.
 *   - Categorías reales (campos nuevos department + product_line):
 *       department  ← kdie (vía kdii.c4)  — DULCES/BEBIDAS/BOTANAS
 *       product_line ← kdif (vía kdii.c5) — CHOCOLATE PASTELITO/AGUA EMBOTELLADA
 *     No toca category_id (=proveedor).
 *
 * Join por sku == kdii.c1. Dry-run/apply con conteos.
 *
 *   node database/importers/kepler/import-kepler-uom-categories.js          # dry-run
 *   node database/importers/kepler/import-kepler-uom-categories.js --apply
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Import UoM + categorías Kepler → products (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Kepler: sku → unidad, departamento, línea
    const { rows: kp } = await src.query(
      `SELECT i.c1 AS sku,
              NULLIF(i.c11,'') AS unit,
              NULLIF(d.c2,'')  AS department,
              NULLIF(f.c2,'')  AS product_line
         FROM md.kdii i
         LEFT JOIN md.kdie d ON d.c1 = i.c4
         LEFT JOIN md.kdif f ON f.c1 = i.c5`);

    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    let uom = 0, cat = 0, unmatched = 0;
    const NOAPLICA = (v) => (v && /^NO APLICA/i.test(v) ? null : v);
    for (const r of kp) {
      const id = skuToId.get(r.sku);
      if (!id) { unmatched++; continue; }
      const dep = NOAPLICA(r.department);
      const line = NOAPLICA(r.product_line);
      const res = await db.query(
        `UPDATE catalog.products
            SET unit_sale = COALESCE($1, unit_sale),
                unit_purchase = COALESCE($1, unit_purchase),
                department = $2,
                product_line = $3,
                updated_at = now()
          WHERE id=$4 AND tenant_id=$5`,
        [r.unit, dep, line, id, M]);
      if (res.rowCount) { if (r.unit) uom++; if (dep || line) cat++; }
    }

    console.log(`Productos actualizados (sin match: ${unmatched})`);
    console.log(`  UoM (unit_sale/purchase) seteado: ${uom}`);
    console.log(`  Con departamento/línea: ${cat}`);

    // Distribuciones resultantes
    const showDist = async (label, col) => {
      const { rows } = await db.query(
        `SELECT ${col} AS v, count(*) n FROM catalog.products WHERE tenant_id=$1 AND ${col} IS NOT NULL GROUP BY ${col} ORDER BY n DESC LIMIT 6`, [M]);
      console.log(`\n${label}:`); rows.forEach((x) => console.log(`  ${String(x.n).padStart(6)}  ${x.v}`));
    };
    await showDist('unit_sale', 'unit_sale');
    await showDist('department', 'department');

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
