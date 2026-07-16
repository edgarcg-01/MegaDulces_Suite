/* eslint-disable no-console */
/**
 * KV.1 — Fact de VENTA REAL → analytics.sales_daily, MODO BULK.
 *
 * Fuente: mart.ventas_enriched (consolidación on-prem, 6 sucursales, con channel).
 * Agrega por (almacen, sku, channel, día) en ventana de 13 meses, resuelve
 * sku→product_id y almacen→warehouse_id contra el destino, calcula costo con
 * catalog.products.cost_base (costo actual; sale-time cost = refinamiento futuro),
 * carga staging temp y hace DELETE-ventana + INSERT server-side (atómico).
 *
 *   node database/importers/kepler/import-sales-fact.js          # dry-run
 *   node database/importers/kepler/import-sales-fact.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;
const MONTHS = 13;

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Fact de ventas → analytics.sales_daily (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}, ${MONTHS}m) ===\n`);

    // Lookups del destino.
    const prods = (await db.query(
      `SELECT id, sku, markup_pct FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p]));
    const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));
    console.log(`  lookup destino: ${skuTo.size} products c/sku · ${whTo.size} warehouses`);

    // Origen agregado (consolidado).
    // PH ('01'): Wincaja manda `< 2026-07-01` (venta real ene–jun), Kepler desde jul 1
    // (Kepler recién tomó PH). Excluir el pre-julio de PH aquí cierra el solape de junio
    // con el feed Wincaja → cero doble conteo. Ver import-wincaja-analytics.js (PH_CUTOVER).
    const { rows: agg } = await src.query(
      `SELECT almacen, sku, channel, fecha,
              sum(cantidad)::numeric        AS units,
              round(sum(importe),2)::numeric AS revenue,
              count(DISTINCT folio)::int     AS tickets
         FROM mart.ventas_enriched
        WHERE fecha >= current_date - interval '${MONTHS} months'
          AND NOT (almacen = '01' AND fecha < DATE '2026-07-01')
        GROUP BY almacen, sku, channel, fecha`);
    console.log(`  origen agregado: ${agg.length} filas (almacen×sku×canal×día)`);

    // Transform + match. cost = revenue/(1+markup/100) (KV.4: markup% del ERP,
    // robusto a unidades). NULL si el producto no tiene markup → margen NULL.
    const rows = []; let noSku = 0, noWh = 0, noMarkup = 0;
    const byChannel = {};
    for (const r of agg) {
      const p = skuTo.get(r.sku);
      if (!p) { noSku++; continue; }
      const wid = whTo.get(r.almacen);
      if (!wid) { noWh++; continue; }
      const mk = p.markup_pct != null ? Number(p.markup_pct) : null;
      const cost = mk != null && mk > -100 ? Number(r.revenue) / (1 + mk / 100) : null;
      if (cost == null) noMarkup++;
      rows.push([p.id, wid, r.channel, r.fecha, r.units, r.revenue, cost, r.tickets]);
      const c = (byChannel[r.channel] ||= { filas: 0, revenue: 0 });
      c.filas++; c.revenue += Number(r.revenue);
    }
    console.log(`  (sin markup → cost NULL: ${noMarkup})`);
    console.log(`  a cargar: ${rows.length} (sin sku en catálogo: ${noSku}, sin warehouse: ${noWh})`);
    console.table(Object.fromEntries(Object.entries(byChannel).map(([k, v]) => [k, { filas: v.filas, revenue: Math.round(v.revenue) }])));

    if (!APPLY) {
      console.log('\n[DRY-RUN] nada cambió.');
      return;
    }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_sf (product_id uuid, warehouse_id uuid, channel text, sale_date date, units numeric, revenue numeric, cost numeric, tickets int) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        const b = ri * 8;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
        params.push(...row);
      });
      await db.query(`INSERT INTO stg_sf VALUES ${vals.join(',')}`, params);
    }
    // Refresco full de la ventana: borra + reinserta (agrupado por si hay sku
    // duplicados que colapsan al mismo product_id → evita violar el unique).
    // Scope del DELETE a canales KEPLER (NOT LIKE 'wincaja%'): este feed solo refresca
    // su propia venta. Sin esto borraba TODA la ventana incluyendo los canales wincaja_*
    // → si Kepler corría después de import-wincaja-analytics, dejaba a Wincaja en 0 hasta
    // el próximo sync (causa raíz del "sell-out no muestra Wincaja"). Ahora son independientes.
    await db.query(
      `DELETE FROM analytics.sales_daily WHERE tenant_id=$1 AND sale_date >= current_date - interval '${MONTHS} months' AND channel NOT LIKE 'wincaja%'`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.sales_daily
         (id, tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, channel, sale_date,
              sum(units), sum(revenue), sum(cost), sum(tickets), now()
         FROM stg_sf
        GROUP BY product_id, warehouse_id, channel, sale_date`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas en analytics.sales_daily.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
