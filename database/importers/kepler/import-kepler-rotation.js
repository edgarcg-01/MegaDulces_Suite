/* eslint-disable no-console */
/**
 * Feed de ROTACIÓN real (Kepler ventas) → catalog.products (consumido por Thot).
 *
 * Thot lee `catalog.products.rotation_tier` (alta/media/baja → peso 1/0.6/0.2;
 * null → 0.1) y `sales_units_30d`. Este importer los puebla con la venta REAL
 * de Kepler (kdm1/kdm2, doc venta c2='U' c3='D' c4=10) de la sucursal indicada.
 *
 * Tiers por percentil de unidades vendidas 90d (entre los que vendieron):
 *   alta = >= p75 · media = p40..p75 · baja = 1..p40 · dead (0 ventas) = null.
 * Así el stock muerto cae al peso mínimo en Thot automáticamente.
 *
 * Universo = SKUs con existencia en la sucursal (kdil) ∪ SKUs con venta 90d.
 * Join a catálogo por sku. Solo actualiza productos que matchean (no clobber).
 *
 *   node database/importers/kepler/import-kepler-rotation.js          # dry-run
 *   node database/importers/kepler/import-kepler-rotation.js --apply  # commit
 *   ... [--branch 03]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');
const bi = process.argv.indexOf('--branch');
const BRANCH = bi !== -1 ? process.argv[bi + 1] : '03';

const SALES = `h.c2='U' AND h.c3='D' AND h.c4=10`;

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
    console.log(`\n=== Feed rotación Kepler suc ${BRANCH} → products (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Venta 30d / 90d por SKU + universo en existencia.
    const { rows: vrows } = await src.query(
      `WITH s AS (
         SELECT d.c8 AS sku,
                sum(d.c9) FILTER (WHERE h.c9 >= CURRENT_DATE - 30) AS u30,
                sum(d.c9) FILTER (WHERE h.c9 >= CURRENT_DATE - 90) AS u90
           FROM md.kdm2 d JOIN md.kdm1 h
             ON h.c1=d.c1 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
          WHERE ${SALES} AND h.c1=$1 AND h.c9 >= CURRENT_DATE - 90
          GROUP BY d.c8)
       SELECT COALESCE(s.sku, l.c3) AS sku,
              COALESCE(s.u30,0)::int AS u30, COALESCE(s.u90,0)::int AS u90
         FROM s FULL OUTER JOIN (SELECT DISTINCT c3 FROM md.kdil WHERE c1=$1 AND c9>0) l
           ON l.c3 = s.sku`,
      [BRANCH]);

    const sellers = vrows.filter((r) => r.u90 > 0).map((r) => r.u90).sort((a, b) => a - b);
    const p40 = percentile(sellers, 40);
    const p75 = percentile(sellers, 75);
    const tierOf = (u90) => (u90 <= 0 ? null : u90 >= p75 ? 'alta' : u90 >= p40 ? 'media' : 'baja');
    console.log(`Vendedores: ${sellers.length} · umbral media>=${p40}u/90d · alta>=${p75}u/90d`);

    // Catálogo: sku → id
    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    const dist = { alta: 0, media: 0, baja: 0, dead: 0 };
    let updated = 0, unmatched = 0;
    for (const r of vrows) {
      const id = skuToId.get(r.sku);
      if (!id) { unmatched++; continue; }
      const tier = tierOf(r.u90);
      dist[tier ?? 'dead']++;
      await db.query(
        `UPDATE catalog.products SET rotation_tier=$1, sales_units_30d=$2, sales_units_90d=$3, updated_at=now() WHERE id=$4 AND tenant_id=$5`,
        [tier, r.u30, r.u90, id, M]);
      updated++;
    }

    console.log(`\nActualizados: ${updated} (sin match catálogo: ${unmatched})`);
    console.log(`Distribución tier: alta=${dist.alta} · media=${dist.media} · baja=${dist.baja} · dead(null)=${dist.dead}`);

    if (APPLY) {
      await db.query('COMMIT');
      console.log('\n[APPLY] COMMIT — rotación real alimentada a Thot.');
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
