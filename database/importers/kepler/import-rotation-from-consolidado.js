/* eslint-disable no-console */
/**
 * Feed de ROTACIÓN real → catalog.products (consumido por Thot y dead-stock),
 * desde la CONSOLIDACIÓN VIVA de las 6 sucursales (kepler_consolidado.mart.ventas).
 *
 * Reemplaza a `import-kepler-rotation.js` (que tomaba 1 sucursal, serie 10).
 * Acá la rotación es de TODA LA RED (todas las sucursales y series), así un
 * producto "muerto" en una sucursal pero que rota en otra NO cae como dead.
 *
 * Tiers por percentil de unidades vendidas 90d (entre los que vendieron):
 *   alta = >= p75 · media = p40..p75 · baja = 1..p40 · dead (0 ventas) = null.
 *
 * Universo = SKUs con venta 90d ∪ SKUs con existencia (dic.stock). Join a
 * catálogo por sku; solo actualiza los que matchean (no clobber).
 *
 *   node database/importers/kepler/import-rotation-from-consolidado.js          # dry-run
 *   node database/importers/kepler/import-rotation-from-consolidado.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC =
  process.env.DATABASE_URL_KEPLER_CONSOLIDADO ||
  'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST =
  process.env.DATABASE_URL_NEW ||
  'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Feed rotación RED (6 sucursales) → products (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Venta 30d / 90d por SKU (toda la red) ∪ universo en existencia.
    const { rows: vrows } = await src.query(
      `WITH s AS (
         SELECT sku,
                sum(cantidad) FILTER (WHERE fecha >= CURRENT_DATE - 30) AS u30,
                sum(cantidad) FILTER (WHERE fecha >= CURRENT_DATE - 90) AS u90
           FROM mart.ventas
          WHERE fecha >= CURRENT_DATE - 90
          GROUP BY sku
       ),
       stocked AS (SELECT DISTINCT sku FROM dic.stock WHERE existencia > 0)
       SELECT COALESCE(s.sku, st.sku) AS sku,
              COALESCE(round(s.u30),0)::int AS u30,
              COALESCE(round(s.u90),0)::int AS u90
         FROM s FULL OUTER JOIN stocked st ON st.sku = s.sku`,
    );

    const sellers = vrows.filter((r) => r.u90 > 0).map((r) => r.u90).sort((a, b) => a - b);
    const p40 = percentile(sellers, 40);
    const p75 = percentile(sellers, 75);
    const tierOf = (u90) => (u90 <= 0 ? null : u90 >= p75 ? 'alta' : u90 >= p40 ? 'media' : 'baja');
    console.log(`SKUs con dato: ${vrows.length} · vendedores: ${sellers.length} · umbral media>=${p40}u/90d · alta>=${p75}u/90d`);

    // Catálogo: sku → id
    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    // BULK (staging + un solo UPDATE FROM). El loop per-fila contra prod remoto
    // (~1.2s/query) tomaba ~1.7h; staging+merge = segundos.
    const BATCH = 1000;
    const dist = { alta: 0, media: 0, baja: 0, dead: 0 };
    const rows = []; let unmatched = 0;
    for (const r of vrows) {
      const id = skuToId.get(r.sku);
      if (!id) { unmatched++; continue; }
      const tier = tierOf(r.u90);
      dist[tier ?? 'dead']++;
      rows.push([id, tier, r.u30, r.u90]);
    }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // Reset atómico: evita rotación STALE en productos fuera del universo de red
    // (el importer viejo de 1 sucursal no clobbeaba → dejaba 'alta' fantasma que
    // engañaba a Thot). Tras el reset, solo el universo real (venta∪stock) queda
    // clasificado; el resto = null/dead, que es lo correcto.
    const { rowCount: reset } = await db.query(
      `UPDATE catalog.products SET rotation_tier=NULL, sales_units_30d=0, sales_units_90d=0
        WHERE tenant_id=$1 AND (rotation_tier IS NOT NULL OR COALESCE(sales_units_30d,0)<>0 OR COALESCE(sales_units_90d,0)<>0)`,
      [M]);
    console.log(`Reset previo (limpieza de stale): ${reset} productos`);

    await db.query(`CREATE TEMP TABLE stg_rot (id uuid, tier text, u30 int, u90 int) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => { vals.push(`($${ri*4+1},$${ri*4+2},$${ri*4+3},$${ri*4+4})`); params.push(...row); });
      await db.query(`INSERT INTO stg_rot (id, tier, u30, u90) VALUES ${vals.join(',')}`, params);
    }
    const { rowCount: updated } = await db.query(
      `UPDATE catalog.products p
          SET rotation_tier=s.tier, sales_units_30d=s.u30, sales_units_90d=s.u90, updated_at=now()
         FROM stg_rot s WHERE p.id=s.id AND p.tenant_id=$1`, [M]);

    console.log(`\nActualizados: ${updated} (sin match catálogo: ${unmatched})`);
    console.log(`Distribución tier: alta=${dist.alta} · media=${dist.media} · baja=${dist.baja} · dead(null)=${dist.dead}`);

    if (APPLY) {
      await db.query('COMMIT');
      console.log('\n[APPLY] COMMIT — rotación de red alimentada a Thot + dead-stock.');
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
