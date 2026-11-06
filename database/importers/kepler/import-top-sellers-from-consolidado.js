/* eslint-disable no-console */
/**
 * Best-sellers VIVOS de la red → catalog.top_sellers_live (consumido por el
 * portal: home/carrusel/orden por popularidad).
 *
 * Reemplaza la fuente stale (erp.ranking_productos vía FDW, ETL por archivos)
 * por la venta real consolidada de mart.ventas (6 sucursales, 90d).
 *
 * NO toca el MV viejo catalog.products_top_sellers (sigue ahí intacto). El
 * endpoint del portal apunta a esta tabla nueva. READ-ONLY sobre las sucursales
 * (mart.ventas ya es local). TRUNCATE+INSERT (tabla propia, top 1000 por venta).
 *
 * `[CANON.5.15]` (2026-11-06) — por default se calcula de `analytics.sales_daily` en prod, no del
 * `mart`. El `mart` contaba DOS veces la venta de las rutas de Padre Hidalgo: la trae la base de la
 * `01` (almacenes `01-00N`) y otra vez el push `ruta_NN` ($6.4 M en 90 días, 4.2 %); `sales_daily`
 * ya la deduplica (`import-sales-fact`). Comparación en seco (90 días sin hoy): quitada esa doble
 * cuenta del `mart`, 5,333 de 5,413 SKUs iguales al peso, top-100 idéntico y 999 de 1,000 en el
 * top; los 80 distintos (Δ $25 mil de $145 M) son filas viejas de `sales_daily` que su upsert no
 * borra. Control sin deduplicar: 1,675 SKUs distintos. Mismo universo que antes: sin los canales
 * `wincaja_*` (el `mart` no los trae). `units_sold` pasa a ser la unidad canónica del producto
 * (`sales_daily.units`): el `mart` sumaba `cantidad` cruda, cajas y piezas juntas, y el portal la
 * rotula «piezas vendidas». `max()` por llave aguanta la venta escrita a nombre de una fila borrada
 * y de su gemela viva (H9 bis) mientras no se limpie. `--source=mart` conserva la fuente vieja.
 *
 *   node database/importers/kepler/import-top-sellers-from-consolidado.js          # dry-run
 *   node database/importers/kepler/import-top-sellers-from-consolidado.js --apply  # commit
 *   node database/importers/kepler/import-top-sellers-from-consolidado.js --source=mart
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const TOP_N = 1000;
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'sales_daily';
if (!['sales_daily', 'mart'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (sales_daily | mart)`);

const TOP_SQL = {
  sales_daily: `
    SELECT sku, round(sum(units))::numeric AS units_sold, round(sum(revenue),2) AS revenue,
           round(sum(units))::numeric AS units_total
      FROM (SELECT pr.sku, max(d.units) AS units, max(d.revenue) AS revenue
              FROM analytics.sales_daily d
              JOIN catalog.products pr ON pr.id = d.product_id
             WHERE d.tenant_id = '${M}' AND d.sale_date >= current_date - 90 AND d.channel NOT LIKE 'wincaja%'
             GROUP BY pr.sku, d.warehouse_id, d.channel, d.sale_date) x
     GROUP BY sku
     ORDER BY sum(revenue) DESC
     LIMIT $1`,
  mart: `
    SELECT sku,
           round(sum(cantidad))::numeric AS units_sold,
           round(sum(importe),2)         AS revenue,
           round(sum(cantidad))::numeric AS units_total
      FROM mart.ventas
     WHERE fecha >= current_date - 90 AND sku IS NOT NULL
     GROUP BY sku
     ORDER BY sum(importe) DESC
     LIMIT $1`,
};

(async () => {
  const db = new Client({ connectionString: DST });
  const src = SOURCE === 'mart' ? new Client({ connectionString: SRC }) : db;
  if (src !== db) await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Best-sellers vivos red (90d, ${SOURCE}) → catalog.top_sellers_live (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Top N por venta (importe) en 90d.
    const { rows: top } = await src.query(TOP_SQL[SOURCE], [TOP_N]);
    console.log(`Best-sellers calculados: ${top.length}`);

    // Metadata de catálogo por sku (base table: la vista public.products no expone is_promo).
    // Tolerante a prod sin la migración 20260706150000 todavía (columna ausente → false).
    const hasPromo = (await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema='catalog' AND table_name='products' AND column_name='is_promo'`)).rowCount > 0;
    const { rows: prods } = await db.query(
      `SELECT id, sku, nombre, brand_id, barcode, category_id, cost_base, image_url,
              ${hasPromo ? 'is_promo' : 'false AS is_promo'}
         FROM catalog.products WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]);
    const bySku = new Map(prods.map((p) => [p.sku, p]));

    const finalRows = [];
    let rank = 0, unmatched = 0, promos = 0;
    for (const r of top) {
      const p = bySku.get(r.sku);
      if (!p) { unmatched++; continue; }
      if (p.is_promo) { promos++; continue; } // marcador de promo, no producto vendible
      rank++;
      finalRows.push({ ...p, units_sold: r.units_sold, revenue: r.revenue, units_total: r.units_total, sales_rank: rank });
    }
    console.log(`Con match catálogo: ${finalRows.length} (sin match: ${unmatched}, promos excluidas: ${promos})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }
    // Guarda: sin best-sellers (consolidado vacío/caído) no toques la tabla del portal.
    if (!finalRows.length) { console.log('\n[APPLY] 0 best-sellers — tabla intacta.'); return; }

    // Refresco IDEMPOTENTE sin churn: staging TEMP → UPSERT solo-cambios (por tenant_id,id=product)
    // → DELETE solo lo que salió del top. Antes: TRUNCATE+INSERT reescribía las 1000 filas cada noche.
    const BATCH = 500;
    const PPR = 12; // params por fila hacia stg_ts (cases_sold va literal 0, no es param)
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_ts (id uuid, sku text, nombre text, brand_id uuid, barcode text,
      category_id uuid, cost_base numeric, image_url text, units_sold numeric, revenue numeric, cases_sold numeric,
      units_total numeric, sales_rank int) ON COMMIT DROP`);
    for (let i = 0; i < finalRows.length; i += BATCH) {
      const chunk = finalRows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((f, ri) => {
        const b = ri * PPR;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},0,$${b+11},$${b+12})`);
        params.push(f.id, f.sku, f.nombre, f.brand_id, f.barcode, f.category_id, f.cost_base, f.image_url,
          f.units_sold, f.revenue, f.units_total, f.sales_rank);
      });
      await db.query(
        `INSERT INTO stg_ts (id, sku, nombre, brand_id, barcode, category_id, cost_base, image_url,
           units_sold, revenue, cases_sold, units_total, sales_rank) VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(
      `INSERT INTO catalog.top_sellers_live AS t
         (id, tenant_id, sku, nombre, brand_id, barcode, category_id, cost_base, image_url,
          units_sold, revenue, cases_sold, units_total, sales_rank)
       SELECT id, $1, sku, nombre, brand_id, barcode, category_id, cost_base, image_url,
          units_sold, revenue, cases_sold, units_total, sales_rank FROM stg_ts
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, brand_id=EXCLUDED.brand_id, barcode=EXCLUDED.barcode,
         category_id=EXCLUDED.category_id, cost_base=EXCLUDED.cost_base, image_url=EXCLUDED.image_url,
         units_sold=EXCLUDED.units_sold, revenue=EXCLUDED.revenue, cases_sold=EXCLUDED.cases_sold,
         units_total=EXCLUDED.units_total, sales_rank=EXCLUDED.sales_rank
       WHERE (t.sku, t.nombre, t.brand_id, t.barcode, t.category_id, t.cost_base, t.image_url,
              t.units_sold, t.revenue, t.cases_sold, t.units_total, t.sales_rank)
             IS DISTINCT FROM
             (EXCLUDED.sku, EXCLUDED.nombre, EXCLUDED.brand_id, EXCLUDED.barcode, EXCLUDED.category_id,
              EXCLUDED.cost_base, EXCLUDED.image_url, EXCLUDED.units_sold, EXCLUDED.revenue, EXCLUDED.cases_sold,
              EXCLUDED.units_total, EXCLUDED.sales_rank)`, [M]);
    const del = await db.query(
      `DELETE FROM catalog.top_sellers_live t
        WHERE t.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM stg_ts s WHERE s.id=t.id)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} salieron del top · ${finalRows.length} best-sellers.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    if (src !== db) await src.end();
    await db.end();
  }
})();
