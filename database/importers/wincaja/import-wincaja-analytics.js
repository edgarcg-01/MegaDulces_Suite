/**
 * W.5 (gold) - Feed: venta de las sucursales CIEGAS de Wincaja (30/32/50) ->
 * `analytics.sales_daily`, la tabla canonica que consumen los tableros.
 *
 * Regla de fuente autoritativa (ADR-031): solo las wincaja_only (30/32/50), que
 * Kepler NO ve -> cero doble conteo. Las compartidas (00/10/40/44/54) las sigue
 * alimentando Kepler. Tag `channel='wincaja'` = lineage + reversible (idempotente
 * por DELETE del canal + INSERT). Solo SKUs con product_id (99.1% de la venta).
 *
 * NO fusiona raw: lee la capa silver (wincaja.v_sales_daily) y proyecta al shape
 * canonico (product_id/warehouse_id UUID). analytics.* no tiene RLS (filtro tenant
 * explicito). Corre como owner (DATABASE_URL_NEW).
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-wincaja-analytics.js            # dry-run (cuenta)
 *   node importers/wincaja/import-wincaja-analytics.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// channel preserva el SUB-CANAL del silver (v_sales_daily.sale_channel), namespaced
// 'wincaja_*' para no colisionar con Kepler (mostrador/credito/preventa/ruta):
//   mostrador→wincaja_mostrador · mayoreo_credito→wincaja_credito ·
//   preventa_vecinal→wincaja_preventa · ruta_venta→wincaja_ruta.
// Sell-Out mapea cada uno a su canal real (antes todo caía en 'Otro'). Todos suman
// al total; separables por channel. W.8/W.10 + RS (sub-canal 2026-07-14).
const SELECT_SRC = `
  SELECT
    p.id                         AS product_id,
    w.id                         AS warehouse_id,
    s.business_date              AS sale_date,
    'wincaja_' || CASE s.sale_channel
       WHEN 'mayoreo_credito'  THEN 'credito'
       WHEN 'preventa_vecinal' THEN 'preventa'
       WHEN 'ruta_venta'       THEN 'ruta'
       WHEN 'mostrador'        THEN 'mostrador'
       ELSE s.sale_channel END   AS channel,
    SUM(s.qty)                   AS units,
    SUM(s.importe)               AS revenue,
    SUM(s.costo)                 AS cost,
    SUM(s.importe) - SUM(s.costo) AS margin,
    SUM(s.tickets)               AS tickets
  FROM wincaja.v_sales_daily s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.code = s.warehouse_code AND w.deleted_at IS NULL
  WHERE s.tenant_id = ? AND s.wincaja_only = true
  GROUP BY p.id, w.id, s.business_date, channel
`;

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);

  const [pre] = (await db.raw(`SELECT count(*)::int rows, coalesce(round(sum(revenue)::numeric,0),0) rev FROM (${SELECT_SRC}) x`, [TENANT])).rows;
  console.log(`origen (30/32/50, SKU mapeable): ${pre.rows} filas producto-almacen-dia, revenue $${Number(pre.rev).toLocaleString()}`);

  if (!APPLY) { console.log('(dry-run - usar --apply)'); await db.destroy(); return; }

  await db.transaction(async (trx) => {
    const del = await trx('analytics.sales_daily').where({ tenant_id: TENANT }).where('channel', 'like', 'wincaja%').del();
    const ins = await trx.raw(
      `INSERT INTO analytics.sales_daily (tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, updated_at)
       SELECT ?, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, now()
       FROM (${SELECT_SRC}) src`,
      [TENANT, TENANT],
    );
    console.log(`analytics.sales_daily: -${del} (canales wincaja*) +${ins.rowCount} filas`);
  });

  const chk = (await db.raw(
    `SELECT channel, count(*)::int n, coalesce(round(sum(revenue)::numeric,0),0) rev, count(distinct warehouse_id) wh
     FROM analytics.sales_daily WHERE tenant_id = ? AND channel LIKE 'wincaja%' GROUP BY channel ORDER BY channel`, [TENANT])).rows;
  for (const r of chk) console.log(`✅ ${r.channel}: ${r.n} filas, ${r.wh} almacenes, revenue $${Number(r.rev).toLocaleString()}`);

  // Refresca la MV de KPIs por sucursal (overview instantaneo). Depende del bronze,
  // no del gold, pero corre aqui como paso final del feed. CONCURRENTLY si ya esta
  // poblada; plain el primer refresh (WITH NO DATA no admite CONCURRENTLY).
  const mv = await db.raw(`SELECT ispopulated FROM pg_matviews WHERE schemaname = 'wincaja' AND matviewname = 'mv_branch_kpis'`);
  if (mv.rows.length) {
    const t = Date.now();
    await db.raw(`REFRESH MATERIALIZED VIEW ${mv.rows[0].ispopulated ? 'CONCURRENTLY ' : ''}wincaja.mv_branch_kpis`);
    console.log(`✅ REFRESH wincaja.mv_branch_kpis (${Date.now() - t}ms)`);
  } else {
    console.log('⚠ wincaja.mv_branch_kpis no existe aun (aplicar migracion 20260713200000)');
  }
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
