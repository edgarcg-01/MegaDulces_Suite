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
// PH (branch 10 = warehouse '01' "Padre Hidalgo") es COMPARTIDA con Kepler, pero
// Kepler recién la tomó (solo tiene jun-jul 2026, ~$3.9M) mientras Wincaja tiene la
// venta real ene–jun (~$57.6M). BLEND por corte de fecha (decisión Edgar): Wincaja
// manda PH `< 2026-07-01`, Kepler desde jul 1. Se remapea el warehouse_code 'MD-10'
// (no existe como almacén) → '01'. El feed Kepler (import-sales-fact.js) excluye '01'
// pre-julio para cerrar el solape de junio → cero doble conteo.
const PH_CUTOVER = "DATE '2026-07-01'";
// La Piedad Abastos (branch 42 = warehouse '02') es el MISMO caso que PH: compartida
// con Kepler, que la tomó el 2025-10-03 (tienda) / 2025-10-10 (credito). El histórico
// ene–sep 2025 vive SOLO en Wincaja. BLEND: Wincaja manda `< 2025-10-01`, Kepler desde
// oct. Se remapea 'MD-42' → '02' (el almacén real que Kepler alimenta). Kepler '02'
// arranca en oct → cero solape sin tocar el feed Kepler.
const LP_CUTOVER = "DATE '2025-10-01'";
// RS.3 — normalización de unidad para Wincaja. Cada artículo tiene UNA unidad de
// venta fija (wincaja.articulos.unidad_venta) → sin mezcla dentro del sku. qty ya
// viene en esa unidad: PZA=piezas, KGS=kg. Solo CJA se convierte a piezas (×factor).
//   · unit_kind = 'weight' si el sku es KGS, si no 'piece'
//   · units     = kg (KGS) · piezas (PZA) · qty×factor_venta (CJA→piezas)
// `am` = modelo del artículo (1 fila por articulo, el dataset más reciente).
const SELECT_SRC = `
  WITH am AS (
    SELECT DISTINCT ON (tenant_id, articulo)
           tenant_id, articulo,
           upper(btrim(coalesce(unidad_venta, ''))) AS uv, factor_venta
      FROM wincaja.articulos
     ORDER BY tenant_id, articulo, source_dataset DESC
  )
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
    SUM(CASE WHEN am.uv = 'CJA' THEN s.qty * COALESCE(NULLIF(am.factor_venta, 0), 1)
             ELSE s.qty END)      AS units,
    CASE WHEN bool_or(am.uv = 'KGS') THEN 'weight' ELSE 'piece' END AS unit_kind,
    SUM(s.importe)               AS revenue,
    SUM(s.costo)                 AS cost,
    SUM(s.importe) - SUM(s.costo) AS margin,
    SUM(s.tickets)               AS tickets
  FROM wincaja.v_sales_daily s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.deleted_at IS NULL
   AND w.code = CASE WHEN s.source_branch = '10' THEN '01'
                     WHEN s.source_branch = '42' THEN '02'
                     ELSE s.warehouse_code END
  LEFT JOIN am ON am.tenant_id = s.tenant_id AND am.articulo = s.sku
  WHERE s.tenant_id = ?
    AND ( s.wincaja_only = true
          OR (s.source_branch = '10' AND s.business_date < ${PH_CUTOVER})
          OR (s.source_branch = '42' AND s.business_date < ${LP_CUTOVER}) )
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
      `INSERT INTO analytics.sales_daily (tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, updated_at)
       SELECT ?, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, now()
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
