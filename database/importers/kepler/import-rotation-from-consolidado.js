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
const { buildModel, toCanonical } = require('./unit-normalization');

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

    // Catálogo: sku → id + MODELO DE UNIDAD (RS.3). Necesario para convertir cada
    // bucket de `unidad` al canónico del producto antes de rankear rotación.
    const { rows: prods } = await db.query(
      `SELECT p.id, btrim(coalesce(p.sku,'')) AS sku,
              upper(btrim(coalesce(p.unit_sale,''))) AS unit_sale, p.factor_sale,
              l.pack_size, l.box_size, l.unit_base, l.content
         FROM catalog.products p
         LEFT JOIN commercial.product_label_prices l ON l.product_id=p.id AND l.tenant_id=p.tenant_id
        WHERE p.tenant_id=$1 AND btrim(coalesce(p.sku,''))<>''`, [M]);
    const skuToId = new Map();
    const modelBySku = new Map();
    for (const p of prods) { skuToId.set(p.sku, p.id); modelBySku.set(p.sku, buildModel(p)); }

    // Venta 30d / 90d por SKU × UNIDAD (toda la red) ∪ universo en existencia.
    const { rows: raw } = await src.query(
      `WITH s AS (
         SELECT sku, upper(btrim(coalesce(unidad,''))) AS unidad,
                sum(cantidad) FILTER (WHERE fecha >= CURRENT_DATE - 30) AS u30,
                sum(cantidad) FILTER (WHERE fecha >= CURRENT_DATE - 90) AS u90
           FROM mart.ventas
          WHERE fecha >= CURRENT_DATE - 90
          GROUP BY sku, upper(btrim(coalesce(unidad,'')))
       ),
       stocked AS (SELECT DISTINCT sku FROM dic.stock WHERE existencia > 0)
       SELECT COALESCE(s.sku, st.sku) AS sku, s.unidad,
              COALESCE(s.u30,0)::numeric AS u30, COALESCE(s.u90,0)::numeric AS u90
         FROM s FULL OUTER JOIN stocked st ON st.sku = s.sku`,
    );

    // Convertir cada bucket (sku,unidad) → canónico y sumar por sku. Guardamos kind
    // para rankear PIEZA vs PESO en escalas separadas (no comparar kg contra piezas).
    const bySku = new Map(); // sku → { u30, u90, kind }
    for (const r of raw) {
      const m = modelBySku.get(r.sku);
      const kind = m ? m.kind : 'piece';
      const c30 = m ? toCanonical(m, r.unidad, Number(r.u30)).qty : Number(r.u30);
      const c90 = m ? toCanonical(m, r.unidad, Number(r.u90)).qty : Number(r.u90);
      let a = bySku.get(r.sku);
      if (!a) { a = { u30: 0, u90: 0, kind }; bySku.set(r.sku, a); }
      a.u30 += c30 || 0; a.u90 += c90 || 0;
    }
    const vrows = Array.from(bySku, ([sku, a]) => ({ sku, u30: Math.round(a.u30), u90: Math.round(a.u90), kind: a.kind }));

    // Percentiles SEPARADOS por kind (piezas vs kg no son comparables).
    const sortedBy = (k) => vrows.filter((r) => r.kind === k && r.u90 > 0).map((r) => r.u90).sort((a, b) => a - b);
    const th = {
      piece: { p40: percentile(sortedBy('piece'), 40), p75: percentile(sortedBy('piece'), 75) },
      weight: { p40: percentile(sortedBy('weight'), 40), p75: percentile(sortedBy('weight'), 75) },
    };
    const tierOf = (u90, kind) => {
      if (u90 <= 0) return null;
      const t = th[kind] || th.piece;
      return u90 >= t.p75 ? 'alta' : u90 >= t.p40 ? 'media' : 'baja';
    };
    console.log(`SKUs con dato: ${vrows.length} · pieza media>=${th.piece.p40}/alta>=${th.piece.p75} · peso(kg) media>=${th.weight.p40}/alta>=${th.weight.p75}`);

    // BULK (staging + un solo UPDATE FROM). El loop per-fila contra prod remoto
    // (~1.2s/query) tomaba ~1.7h; staging+merge = segundos.
    const BATCH = 1000;
    const dist = { alta: 0, media: 0, baja: 0, dead: 0 };
    const rows = []; let unmatched = 0;
    for (const r of vrows) {
      const id = skuToId.get(r.sku);
      if (!id) { unmatched++; continue; }
      const tier = tierOf(r.u90, r.kind);
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
