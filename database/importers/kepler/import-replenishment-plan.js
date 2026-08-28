/* eslint-disable no-console */
/**
 * RA-PRO.31 — Refresca analytics.replenishment_plan (fact del pedido, almacén × producto).
 *
 * Materializa UNA VEZ las primitivas que /compras/pedido recomputaba en cada carga ×3 endpoints:
 * ratio de canal (scan sales_daily 90d), demanda 30d, existencia, tránsito, econ (suf/bf/uxc/costo),
 * topología y demanda efectiva (sucursal=propia; CEDIS=Σ hijos). Product_id ya CANÓNICO (aliases
 * plegados). Sin Kepler → corre directo contra la DB nueva (Railway o local).
 * Lo dispara el runner on-prem (nightly + ciclo stock-live), igual que import-demand-clean.
 *
 * Refresco IDEMPOTENTE sin churn: staging TEMP → UPSERT que solo escribe filas cambiadas
 * (IS DISTINCT FROM) → DELETE solo de lo que ya no viene. Antes hacía DELETE-all+INSERT
 * (reescribía toda la tabla cada 15-30 min); ese churn era costo Railway (WAL/bloat/autovacuum).
 *
 *   DATABASE_URL_NEW=…   node database/importers/kepler/import-replenishment-plan.js          # dry-run
 *   DST_URL=…railway     node database/importers/kepler/import-replenishment-plan.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// RA-PRO.38: el factor de caja ya NO se resuelve aquí. Viene del RESOLVEDOR CANÓNICO
// `analytics.v_product_box_factor` (override > c84 Kepler > etiquetera > factor_sale, con
// guarda anti-pallet) — la MISMA fuente que lee sell-out. uxc = box_factor de la vista.
const uxc = `GREATEST(COALESCE(kbf.bf, 1), 1)`;

const urBody = `SELECT z.product_id,
    (sum(z.rev) FILTER (WHERE z.ch='mayoreo')/NULLIF(sum(z.u) FILTER (WHERE z.ch='mayoreo'),0))
    / NULLIF(sum(z.rev) FILTER (WHERE z.ch='retail')/NULLIF(sum(z.u) FILTER (WHERE z.ch='retail'),0),0) AS ratio
  FROM (SELECT sd.product_id,
               CASE WHEN w.code LIKE 'MD-%' THEN 'mayoreo' WHEN w.code ~ '^[0-9]+$' AND w.code<>'00' THEN 'retail' ELSE 'other' END AS ch,
               sum(sd.units) u, sum(sd.revenue) rev
          FROM analytics.sales_daily sd
          JOIN commercial.warehouses w ON w.id=sd.warehouse_id AND w.tenant_id=sd.tenant_id
         WHERE sd.tenant_id=$1 AND sd.sale_date >= now() - interval '90 days' AND sd.units>0 AND sd.revenue>0
         GROUP BY sd.product_id, ch) z
  GROUP BY z.product_id`;

// TRÁNSITO (OC a recibir) — DERIVADO del ODS acá mismo, sin importer ni tabla intermedia.
// Cadena Kepler: OC `X-A-35` sin orden de entrada `X-A-40` aguas abajo vía su vale `X-A-37`
// (back-pointer c37=grupo / c39=folio). Ventana de 120 d: una OC abierta es reciente, y sin el
// filtro el NOT EXISTS correlacionado barre todo el histórico de kdm1.
//
// ⚠ UNIDAD: `kdm2.c9` viene en la unidad de `c11` — PAQ/PZA/KG/CJA mezcladas en la MISMA OC — y el
// NOMBRE de la unidad no sirve para convertir (en la sucursal 03 las líneas 'PZA' traen ratio de
// costo 13.5: son cajas). El DINERO sí: `c9 × c12` es invariante a la unidad, así que
// `c12 / costo_por_unidad_de_stock` = cuántas unidades de stock trae la línea. Debajo de 1.5× ya
// está en unidad de stock (~95 % de las líneas, mediana 1.00); arriba se usa el ratio topado en el
// factor de caja. Se divide por `bf` acá, con los MISMOS factores que el resto del fact (`econ`),
// así la conversión ocurre UNA vez y `t` ya sale en CAJAS.
//
// Esto reemplazó a `import-in-transit.js` + `analytics.purchase_in_transit` (2026-08-28): mientras
// fueron un importer y una tabla aparte, el rename `qty_in_transit` → `transit_cajas` se comió la
// conversión y el motor restaba ~bf veces de más. Ver GOTCHAS §25.
const IN_TRANSIT_DAYS = Math.max(1, Number(process.env.IN_TRANSIT_DAYS) || 120);
const trOds = `
  tr AS (
    SELECT w.id AS warehouse_id, COALESCE(al.canonical_product_id, e.product_id) AS product_id,
           SUM((l.c9 * CASE
                 WHEN e.real_cost <= 0 OR l.c12::numeric <= 0 THEN 1
                 WHEN l.c12::numeric / e.real_cost < 1.5 THEN 1
                 ELSE LEAST(l.c12::numeric / e.real_cost, GREATEST(e.bf, 1)) END
               ) / GREATEST(e.bf, 1)) AS t
      FROM kepler_ods.kdm1 oc
      JOIN kepler_ods.kdm2 l
        ON l.sucursal=oc.sucursal AND l.c1=oc.c1 AND l.c2=oc.c2 AND l.c3=oc.c3 AND l.c4=oc.c4 AND l.c6=oc.c6
      JOIN commercial.warehouses w
        ON w.tenant_id=$1 AND w.deleted_at IS NULL AND COALESCE(w.kepler_code, w.code)=oc.c1
      JOIN econ e ON e.sku = l.c8
      LEFT JOIN commercial.product_aliases al
        ON al.tenant_id=$1 AND al.alias_product_id=e.product_id AND al.deleted_at IS NULL
     WHERE oc.sucursal=oc.c1 AND oc.c2='X' AND oc.c3='A' AND oc.c4='35'
       AND oc.c9::date >= CURRENT_DATE - ${IN_TRANSIT_DAYS}
       AND NOT EXISTS (
         SELECT 1 FROM kepler_ods.kdm1 vale
         JOIN kepler_ods.kdm1 oe
           ON oe.sucursal=vale.sucursal AND oe.c1=vale.c1
          AND oe.c2='X' AND oe.c3='A' AND oe.c4='40' AND oe.c37='37' AND oe.c39=vale.c6
        WHERE vale.sucursal=oc.sucursal AND vale.c1=oc.c1
          AND vale.c2='X' AND vale.c3='A' AND vale.c4='37' AND vale.c37='35' AND vale.c39=oc.c6)
     GROUP BY 1, 2)`;
// Sin ODS (dev local sin réplica) el fact se arma igual, con tránsito 0 — no revienta.
const trEmpty = `tr AS (SELECT NULL::uuid AS warehouse_id, NULL::uuid AS product_id, 0::numeric AS t WHERE false)`;

const cte = (tr) => `
  WITH ur AS (${urBody}),
  pf AS (SELECT id AS product_id, sku, nombre, supplier_id, category_id,
                COALESCE(factor_sale,1)::numeric fs, COALESCE(cost_with_tax,0)::numeric cwt
           FROM catalog.products WHERE tenant_id=$1 AND activo=true AND deleted_at IS NULL),
  lbl AS (SELECT product_id, max(box_size) bs, max(pack_size) ps
            FROM commercial.product_label_prices WHERE tenant_id=$1 GROUP BY product_id),
  uov AS (SELECT product_id, pieces_per_unit, box_factor
            FROM commercial.product_unit_overrides WHERE tenant_id=$1 AND deleted_at IS NULL),
  kbf AS (SELECT product_id, box_factor AS bf
            FROM analytics.v_product_box_factor WHERE tenant_id=$1),
  pv AS (SELECT COALESCE(al.canonical_product_id, v.product_id) AS product_id,
                sum(v.daily_rate) AS buy_rate,
                sum(v.qty_90d * v.real_unit_cost)/NULLIF(sum(v.qty_90d),0) AS cost,
                max(v.last_purchase) AS last_purchase, max(v.order_days) AS order_days,
                (array_agg(v.warehouse_id ORDER BY v.qty_90d DESC))[1] AS primary_wh
           FROM analytics.purchase_velocity v
           LEFT JOIN commercial.product_aliases al ON al.tenant_id=v.tenant_id AND al.alias_product_id=v.product_id AND al.deleted_at IS NULL
          WHERE v.tenant_id=$1 GROUP BY 1),
  econ AS (
    SELECT pf.product_id, pf.sku, pf.nombre, pf.supplier_id, pf.category_id,
           ${uxc} AS uxc,
           GREATEST(COALESCE(uov.pieces_per_unit, CASE WHEN ${uxc} <= 1 AND ur.ratio >= 3 THEN ur.ratio ELSE 1 END), 1) AS suf,
           GREATEST(COALESCE(uov.box_factor,      CASE WHEN ${uxc} <= 1 AND ur.ratio >= 3 THEN 1 ELSE ${uxc} END), 1) AS bf,
           ur.ratio,
           (uov.product_id IS NOT NULL) AS is_manual,
           COALESCE(pv.cost, pf.cwt, 0) AS real_cost,
           pv.buy_rate, pv.last_purchase, pv.order_days, pv.primary_wh
      FROM pf
      LEFT JOIN lbl ON lbl.product_id = pf.product_id
      LEFT JOIN uov ON uov.product_id = pf.product_id
      LEFT JOIN kbf ON kbf.product_id = pf.product_id
      LEFT JOIN ur  ON ur.product_id  = pf.product_id
      LEFT JOIN pv  ON pv.product_id  = pf.product_id
  ),
  dem AS (SELECT COALESCE(al.canonical_product_id, pd.product_id) AS product_id, pd.warehouse_id,
                 sum(pd.daily_pieces) AS daily_pieces, sum(pd.revenue) AS revenue30
            FROM analytics.product_demand pd
            LEFT JOIN commercial.product_aliases al ON al.tenant_id=pd.tenant_id AND al.alias_product_id=pd.product_id AND al.deleted_at IS NULL
           WHERE pd.tenant_id=$1 AND pd.window_days=30 GROUP BY 1,2),
  stk AS (SELECT COALESCE(al.canonical_product_id, s.product_id) AS product_id, s.warehouse_id, sum(s.quantity) AS quantity
            FROM commercial.stock s
            LEFT JOIN commercial.product_aliases al ON al.tenant_id=s.tenant_id AND al.alias_product_id=s.product_id AND al.deleted_at IS NULL
           WHERE s.tenant_id=$1 GROUP BY 1,2),
  ${tr},
  whs AS (SELECT w.id, w.source_warehouse_id,
                 -- hub REAL = tiene sucursales que surte (source_warehouse_id NULL solo no basta:
                 -- RUTA/aislados sin hijos NO son hub → su stock no es "sobrante de red")
                 EXISTS(SELECT 1 FROM commercial.warehouses c
                         WHERE c.tenant_id=w.tenant_id AND c.source_warehouse_id=w.id AND c.deleted_at IS NULL) AS is_hub
            FROM commercial.warehouses w WHERE w.tenant_id=$1 AND w.deleted_at IS NULL),
  child_dem AS (SELECT w.source_warehouse_id AS hub, d.product_id, sum(d.daily_pieces) AS eff
                  FROM dem d JOIN whs w ON w.id=d.warehouse_id AND w.source_warehouse_id IS NOT NULL
                 GROUP BY 1,2),
  base AS (
    SELECT warehouse_id, product_id FROM dem
    UNION SELECT warehouse_id, product_id FROM stk
    UNION SELECT warehouse_id, product_id FROM tr
  )`;

const PROJECT = `
    SELECT $1::uuid AS tenant_id, b.warehouse_id, b.product_id, e.sku, e.nombre, e.supplier_id, e.category_id,
           w.source_warehouse_id, COALESCE(w.is_hub, false) AS is_hub,
           COALESCE(d.daily_pieces, 0) AS daily_pieces,
           COALESCE(d.revenue30, 0) AS revenue30,
           -- demanda efectiva: sucursal (tiene source) mide vs SU venta; hub PURO (sin source, con hijos)
           -- mide vs Σ hijos; el resto vs propia. Precedencia sucursal (igual que overstockList).
           CASE WHEN w.source_warehouse_id IS NOT NULL THEN COALESCE(d.daily_pieces, 0)
                WHEN w.is_hub THEN COALESCE(cd.eff, 0)
                ELSE COALESCE(d.daily_pieces, 0) END AS eff_daily,
           COALESCE(s.quantity, 0) AS stock_pz,
           round(COALESCE(t.t, 0)::numeric, 2) AS transit_cajas,   -- ya viene en CAJAS del CTE tr
           e.suf, e.bf,
           e.real_cost * e.bf AS caja_cost,
           round(e.ratio, 4) AS price_ratio,
           CASE WHEN e.is_manual THEN 'manual'
                WHEN e.uxc <= 1 AND e.ratio >= 3 THEN 'granel'
                WHEN e.uxc > 1 AND e.ratio >= 3 AND (e.ratio/e.uxc < 0.5 OR e.ratio/e.uxc > 2) THEN 'revisar'
                ELSE 'catalog' END AS unit_source,
           e.buy_rate, e.real_cost AS real_buy_cost, e.last_purchase, e.order_days, e.primary_wh, now() AS computed_at
      FROM base b
      JOIN econ e ON e.product_id = b.product_id
      LEFT JOIN whs w      ON w.id = b.warehouse_id
      LEFT JOIN dem d      ON d.warehouse_id = b.warehouse_id AND d.product_id = b.product_id
      LEFT JOIN stk s      ON s.warehouse_id = b.warehouse_id AND s.product_id = b.product_id
      LEFT JOIN tr  t      ON t.warehouse_id = b.warehouse_id AND t.product_id = b.product_id
      LEFT JOIN child_dem cd ON cd.hub = b.warehouse_id AND cd.product_id = b.product_id`;

// Orden EXACTO del INSERT. Key = PK; DATA = lo que se compara para saltar filas idénticas.
const COLS = ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'nombre', 'supplier_id', 'category_id',
  'source_warehouse_id', 'is_hub', 'daily_pieces', 'revenue30', 'eff_daily', 'stock_pz', 'transit_cajas',
  'suf', 'bf', 'caja_cost', 'price_ratio', 'unit_source', 'buy_rate', 'real_buy_cost', 'last_purchase',
  'order_days', 'primary_wh', 'computed_at'];
const KEY = ['tenant_id', 'warehouse_id', 'product_id'];
const DATA = COLS.filter((c) => !KEY.includes(c) && c !== 'computed_at');
const SET_CLAUSE = DATA.map((c) => `${c}=EXCLUDED.${c}`).join(', ') + ', computed_at=now()';
const DIST_T = `(${DATA.map((c) => `t.${c}`).join(', ')})`;
const DIST_E = `(${DATA.map((c) => `EXCLUDED.${c}`).join(', ')})`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== REPLENISHMENT PLAN → analytics.replenishment_plan (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    // El tránsito se deriva del ODS (no hay tabla ni importer). Sin ODS el fact igual se arma.
    const hasOds = !!(await db.query(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0].t;
    const CTE = cte(hasOds ? trOds : trEmpty);
    if (!hasOds) console.log('  ⚠ sin kepler_ods → tránsito = 0 (dev local sin réplica)');

    const s = await db.query(`${CTE} SELECT count(*)::int filas, count(DISTINCT b.product_id)::int prods,
                                     count(DISTINCT b.warehouse_id)::int whs FROM base b JOIN econ e ON e.product_id=b.product_id`, [M]);
    console.log(`  filas almacén×producto=${Number(s.rows[0].filas).toLocaleString()} · productos=${s.rows[0].prods} · almacenes=${s.rows[0].whs}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    const t0 = Date.now();
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_rplan ON COMMIT DROP AS ${CTE} ${PROJECT}`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.replenishment_plan AS t (${COLS.join(', ')})
       SELECT ${COLS.join(', ')} FROM stg_rplan
       ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET ${SET_CLAUSE}
       WHERE ${DIST_T} IS DISTINCT FROM ${DIST_E}`);
    const del = await db.query(
      `DELETE FROM analytics.replenishment_plan t
        WHERE t.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM stg_rplan s
                           WHERE s.warehouse_id = t.warehouse_id AND s.product_id = t.product_id)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (desaparecidas) en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
