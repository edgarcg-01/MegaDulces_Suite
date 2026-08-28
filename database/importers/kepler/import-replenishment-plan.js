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

// LEAD TIME PROVEEDOR — DERIVADO del ODS (RA-PRO.41, cero captura manual). Kepler captura la cadena
// de un jalón (84% de las OCs cierran el MISMO día → lag 0, sin señal); la señal real vive en el
// ~16% de OCs capturadas ANTES de recibir: mediana del lag OC(X-A-35)→entrada(X-A-40) por proveedor
// (n≥5; medido: mediana global 4d, p90 8d, 108 proveedores con señal). El fallback global viene en
// la fila `supplier_id IS NULL`; el motor remata con COALESCE(..., 4).
const leadOds = `
  lead_raw AS (
    SELECT DISTINCT p.supplier_id, o.sucursal, o.c6 AS folio, (x.f_in - o.c9::date) AS d
      FROM kepler_ods.kdm1 o
      JOIN kepler_ods.kdm2 l
        ON l.sucursal=o.sucursal AND l.c1=o.c1 AND l.c2=o.c2 AND l.c3=o.c3 AND l.c4=o.c4 AND l.c6=o.c6
      JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=l.c8 AND p.supplier_id IS NOT NULL
      CROSS JOIN LATERAL (
        SELECT min(oe.c9::date) AS f_in
          FROM kepler_ods.kdm1 vale
          JOIN kepler_ods.kdm1 oe ON oe.sucursal=vale.sucursal AND oe.c1=vale.c1
                                 AND oe.c2='X' AND oe.c3='A' AND oe.c4='40'
                                 AND oe.c37='37' AND oe.c39=vale.c6
         WHERE vale.sucursal=o.sucursal AND vale.c1=o.c1 AND vale.c2='X' AND vale.c3='A'
           AND vale.c4='37' AND vale.c37='35' AND vale.c39=o.c6) x
     WHERE o.sucursal=o.c1 AND o.c2='X' AND o.c3='A' AND o.c4='35'
       AND o.c9::date >= CURRENT_DATE - 240 AND x.f_in > o.c9::date
  ),
  lead AS (
    SELECT supplier_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS lead_d
      FROM lead_raw GROUP BY supplier_id HAVING count(*) >= 5
    UNION ALL
    SELECT NULL, percentile_cont(0.5) WITHIN GROUP (ORDER BY d) FROM lead_raw
  )`;
const leadEmpty = `lead AS (SELECT NULL::uuid AS supplier_id, NULL::numeric AS lead_d WHERE false)`;

// ÍNDICE ESTACIONAL (RA-PRO.41) — razón desestacionalizar→re-estacionalizar por producto (grano RED):
//   season_ratio = idx(próximos 30 días) / idx(últimos 30 días)
// El trailing-30d que usa el motor YA trae la estación del mes que pasó; multiplicar por el índice del
// horizonte SIN dividir por el del trailing duplica la estación (backtest: enero quedaba +35% en vez
// de −5%). Construcción: revenue mensual normalizado DENTRO de cada año (mata la deriva de crecimiento
// 2026>2025), jerárquico SKU→categoría→global con shrinkage n/(n+1) por años observados, mezcla de
// meses del horizonte ponderada por días, banda muerta 0.85–1.15 → 1 (los meses planos no se tocan),
// cap [0.5, 2.0]. Backtest ene–ago 2026: bias enero +39.6% → −4.7%; |bias| medio 9.4% → 5.0%.
const seasonCte = `
  hist AS (
    SELECT sd.product_id, p.category_id, extract(month from sd.sale_date)::int mes,
           extract(year from sd.sale_date)::int anio, sum(sd.revenue) rev
      FROM analytics.sales_daily sd
      JOIN catalog.products p ON p.id=sd.product_id AND p.tenant_id=sd.tenant_id
     WHERE sd.tenant_id=$1 AND sd.sale_date >= '2025-01-01' AND sd.sale_date < date_trunc('month', CURRENT_DATE)
     GROUP BY 1,2,3,4),
  gy  AS (SELECT anio, mes, sum(rev) rev_mes FROM hist GROUP BY 1,2),
  gyn AS (SELECT anio, avg(rev_mes) prom FROM gy GROUP BY 1),
  gidx AS (SELECT gy.mes, count(*) n, avg(gy.rev_mes / NULLIF(gyn.prom,0)) idx
             FROM gy JOIN gyn ON gyn.anio=gy.anio GROUP BY gy.mes),
  cy  AS (SELECT category_id, anio, mes, sum(rev) rev_mes FROM hist GROUP BY 1,2,3),
  cyn AS (SELECT category_id, anio, avg(rev_mes) prom FROM cy GROUP BY 1,2),
  cidx AS (SELECT cy.category_id, cy.mes, count(*) n, avg(cy.rev_mes / NULLIF(cyn.prom,0)) raw
             FROM cy JOIN cyn ON cyn.category_id=cy.category_id AND cyn.anio=cy.anio
            GROUP BY cy.category_id, cy.mes),
  sy  AS (SELECT product_id, anio, mes, sum(rev) rev_mes FROM hist GROUP BY 1,2,3 HAVING sum(rev) > 500),
  syn AS (SELECT product_id, anio, avg(rev_mes) prom FROM sy GROUP BY 1,2),
  sidx_m AS (SELECT sy.product_id, sy.mes, count(*) n, avg(sy.rev_mes / NULLIF(syn.prom,0)) raw
               FROM sy JOIN syn ON syn.product_id=sy.product_id AND syn.anio=sy.anio
              GROUP BY sy.product_id, sy.mes),
  mdays AS (  -- mezcla de meses de cada ventana de 30 días, ponderada por días calendario
    SELECT 'next' lado, extract(month from d)::int mes, count(*)/30.0 w
      FROM generate_series(CURRENT_DATE, CURRENT_DATE + 29, interval '1 day') d GROUP BY 2
    UNION ALL
    SELECT 'prev', extract(month from d)::int, count(*)/30.0
      FROM generate_series(CURRENT_DATE - 30, CURRENT_DATE - 1, interval '1 day') d GROUP BY 2),
  sprod AS (SELECT DISTINCT product_id, category_id FROM hist),
  slvl AS (  -- índice por (producto, lado): Σ w_mes × idx_jerárquico(mes)
    SELECT pr.product_id, md.lado,
           sum(md.w * COALESCE(
             (s.n::numeric/(s.n+1))*s.raw + (1-s.n::numeric/(s.n+1))*COALESCE((c.n::numeric/(c.n+1))*c.raw+(1-c.n::numeric/(c.n+1))*g.idx, g.idx, 1),
             (c.n::numeric/(c.n+1))*c.raw + (1-c.n::numeric/(c.n+1))*g.idx,
             g.idx, 1)) idx,
           (array_agg(CASE WHEN s.raw IS NOT NULL THEN 'sku' WHEN c.raw IS NOT NULL THEN 'cat' ELSE 'global' END ORDER BY md.w DESC))[1] src
      FROM sprod pr
     CROSS JOIN mdays md
      LEFT JOIN gidx g   ON g.mes=md.mes
      LEFT JOIN cidx c   ON c.category_id=pr.category_id AND c.mes=md.mes
      LEFT JOIN sidx_m s ON s.product_id=pr.product_id AND s.mes=md.mes
     GROUP BY pr.product_id, md.lado),
  season AS (
    SELECT n.product_id,
           CASE WHEN n.idx/NULLIF(p.idx,0) BETWEEN 0.85 AND 1.15 THEN 1
                ELSE LEAST(2.0, GREATEST(0.5, n.idx/NULLIF(p.idx,0))) END AS season_ratio,
           n.src AS season_src
      FROM slvl n JOIN slvl p ON p.product_id=n.product_id AND p.lado='prev'
     WHERE n.lado='next')`;

// COLCHÓN POR CUANTILES (RA-PRO.41) — robusto a la intermitencia. El 77% de los pares SKU×almacén
// venden <1/3 de los días → el CV clásico no discrimina (89% caía en clase Z y todo recibía el mismo
// 20%). En su lugar: sumas rodantes de 4 semanas (26 semanas, grano RED — la compra es de red) y el
// colchón = cuánto se aparta el cuantil de la media, por clase ABC (Pareto revenue 90d):
//   A → p90 cap 50% · B → p80 cap 35% · C → p70 cap 25%   (medido: A mediana 29%, C promedio 18% —
// más protección donde se pierde venta, menos capital muerto en la cola). NULL si <8 semanas con venta.
const safetyCte = `
  swk AS (SELECT product_id, date_trunc('week', sale_date)::date w, sum(revenue) rev
            FROM analytics.sales_daily
           WHERE tenant_id=$1 AND sale_date >= date_trunc('week', CURRENT_DATE) - interval '26 weeks'
             AND sale_date < date_trunc('week', CURRENT_DATE)
           GROUP BY 1,2),
  sgrid AS (SELECT p.product_id, g.w::date w
              FROM (SELECT DISTINCT product_id FROM swk) p
             CROSS JOIN generate_series(date_trunc('week', CURRENT_DATE) - interval '26 weeks',
                                        date_trunc('week', CURRENT_DATE) - interval '1 week', interval '1 week') g(w)),
  sfill AS (SELECT g.product_id, g.w, COALESCE(swk.rev,0) rev,
                   count(*) FILTER (WHERE swk.rev > 0) OVER (PARTITION BY g.product_id) wv
              FROM sgrid g LEFT JOIN swk ON swk.product_id=g.product_id AND swk.w=g.w),
  sroll AS (SELECT product_id, wv,
                   sum(rev) OVER (PARTITION BY product_id ORDER BY w ROWS BETWEEN 3 PRECEDING AND CURRENT ROW) s4,
                   row_number() OVER (PARTITION BY product_id ORDER BY w) rn
              FROM sfill),
  sq AS (SELECT product_id, max(wv) wv,
                percentile_cont(0.90) WITHIN GROUP (ORDER BY s4) p90,
                percentile_cont(0.80) WITHIN GROUP (ORDER BY s4) p80,
                percentile_cont(0.70) WITHIN GROUP (ORDER BY s4) p70,
                avg(s4) mean4
           FROM sroll WHERE rn >= 4 GROUP BY product_id),
  sabc AS (SELECT product_id, CASE WHEN pct <= 0.80 THEN 'A' WHEN pct <= 0.95 THEN 'B' ELSE 'C' END cls
             FROM (SELECT product_id, sum(r) OVER (ORDER BY r DESC)/NULLIF(sum(r) OVER (),0) pct
                     FROM (SELECT product_id, sum(revenue) r FROM analytics.sales_daily
                            WHERE tenant_id=$1 AND sale_date >= CURRENT_DATE - 90 GROUP BY 1) z0) z),
  saf AS (SELECT q.product_id,
                 CASE WHEN q.wv < 8 OR q.mean4 <= 0 THEN NULL
                      WHEN a.cls='A' THEN LEAST(0.50, GREATEST(0, q.p90/q.mean4 - 1))
                      WHEN a.cls='B' THEN LEAST(0.35, GREATEST(0, q.p80/q.mean4 - 1))
                      ELSE            LEAST(0.25, GREATEST(0, q.p70/q.mean4 - 1)) END AS safety_pct_q
            FROM sq q LEFT JOIN sabc a ON a.product_id=q.product_id)`;

const cte = (tr, lead) => `
  WITH ur AS (${urBody}),
  ${seasonCte},
  ${safetyCte},
  ${lead},
  -- RUTAS → SUCURSAL MADRE (RA-PRO.41): la camioneta vende de su carga y se rellena de SU sucursal,
  -- así que su demanda ES demanda de la sucursal (11% de la red). Antes cada RUTA-* generaba filas
  -- propias de "comprar" (nadie compra para una camioneta) y en la vista por-sucursal se PERDÍAN
  -- (filtro de stock>0). El mapeo se DERIVA del rollup de ventas por ruta: WIN-<n> vive bajo la
  -- sucursal que la reporta (moda por revenue) — 21-28→01 · 501-505→06 · 321/322→MD-32. Cero manual.
  rmap AS (
    SELECT route_wh, home_wh FROM (
      SELECT rw.id route_wh, m.warehouse_id home_wh,
             row_number() OVER (PARTITION BY rw.id ORDER BY sum(m.revenue) DESC NULLS LAST) rn
        FROM commercial.warehouses rw
        JOIN analytics.sales_by_route_monthly m
          ON m.tenant_id = rw.tenant_id AND m.route_code = 'WIN-' || replace(rw.code, 'RUTA-', '')
       WHERE rw.tenant_id=$1 AND rw.code LIKE 'RUTA-%' AND rw.deleted_at IS NULL
       GROUP BY rw.id, m.warehouse_id) z
     WHERE rn = 1),
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
  dem AS (SELECT COALESCE(al.canonical_product_id, pd.product_id) AS product_id,
                 COALESCE(rm.home_wh, pd.warehouse_id) AS warehouse_id,   -- ruta → su sucursal madre
                 sum(pd.daily_pieces) AS daily_pieces, sum(pd.revenue) AS revenue30
            FROM analytics.product_demand pd
            LEFT JOIN commercial.product_aliases al ON al.tenant_id=pd.tenant_id AND al.alias_product_id=pd.product_id AND al.deleted_at IS NULL
            LEFT JOIN rmap rm ON rm.route_wh = pd.warehouse_id
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
           e.buy_rate, e.real_cost AS real_buy_cost, e.last_purchase, e.order_days, e.primary_wh,
           round(se.season_ratio::numeric, 3) AS season_ratio,
           se.season_src,
           round(sa.safety_pct_q::numeric, 3) AS safety_pct_q,
           round(COALESCE(sl.lead_d, lg.lead_d)::numeric, 1) AS lead_days,
           now() AS computed_at
      FROM base b
      JOIN econ e ON e.product_id = b.product_id
      LEFT JOIN whs w      ON w.id = b.warehouse_id
      LEFT JOIN dem d      ON d.warehouse_id = b.warehouse_id AND d.product_id = b.product_id
      LEFT JOIN stk s      ON s.warehouse_id = b.warehouse_id AND s.product_id = b.product_id
      LEFT JOIN tr  t      ON t.warehouse_id = b.warehouse_id AND t.product_id = b.product_id
      LEFT JOIN child_dem cd ON cd.hub = b.warehouse_id AND cd.product_id = b.product_id
      LEFT JOIN season se  ON se.product_id = b.product_id
      LEFT JOIN saf sa     ON sa.product_id = b.product_id
      LEFT JOIN lead sl    ON sl.supplier_id = e.supplier_id
      LEFT JOIN lead lg    ON lg.supplier_id IS NULL`;

// Orden EXACTO del INSERT. Key = PK; DATA = lo que se compara para saltar filas idénticas.
const COLS = ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'nombre', 'supplier_id', 'category_id',
  'source_warehouse_id', 'is_hub', 'daily_pieces', 'revenue30', 'eff_daily', 'stock_pz', 'transit_cajas',
  'suf', 'bf', 'caja_cost', 'price_ratio', 'unit_source', 'buy_rate', 'real_buy_cost', 'last_purchase',
  'order_days', 'primary_wh', 'season_ratio', 'season_src', 'safety_pct_q', 'lead_days', 'computed_at'];
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
    // El tránsito y el lead time se derivan del ODS (sin tabla ni importer). Sin ODS igual se arma.
    const hasOds = !!(await db.query(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0].t;
    const CTE = cte(hasOds ? trOds : trEmpty, hasOds ? leadOds : leadEmpty);
    if (!hasOds) console.log('  ⚠ sin kepler_ods → tránsito = 0 y lead_days = NULL (dev local sin réplica)');

    const s = await db.query(`${CTE} SELECT count(*)::int filas, count(DISTINCT b.product_id)::int prods,
                                     count(DISTINCT b.warehouse_id)::int whs FROM base b JOIN econ e ON e.product_id=b.product_id`, [M]);
    console.log(`  filas almacén×producto=${Number(s.rows[0].filas).toLocaleString()} · productos=${s.rows[0].prods} · almacenes=${s.rows[0].whs}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    const t0 = Date.now();
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_rplan ON COMMIT DROP AS ${CTE} ${PROJECT}`, [M]);

    // ── Controles de cordura (RA-PRO.41, "que no se nos pase nada") — se imprimen en CADA corrida.
    // El bug del tránsito fantasma vivió 7 semanas porque nadie cruzaba dos magnitudes; ahora el
    // propio feed reporta lo que ve y lo que NO puede ver.
    const chk = (await db.query(`
      SELECT round(sum(transit_cajas*caja_cost)::numeric,0)            AS transito,
             round(sum(stock_pz/GREATEST(bf,1)*caja_cost)::numeric,0)  AS inventario,
             count(DISTINCT product_id) FILTER (WHERE season_ratio IS DISTINCT FROM 1 AND season_ratio IS NOT NULL) AS prods_con_estacion,
             round(min(season_ratio)::numeric,2) AS season_min, round(max(season_ratio)::numeric,2) AS season_max,
             count(DISTINCT product_id) FILTER (WHERE safety_pct_q IS NOT NULL) AS prods_con_colchon,
             count(DISTINCT product_id) FILTER (WHERE lead_days IS NOT NULL)    AS prods_con_lead
        FROM stg_rplan`)).rows[0];
    const rutasResid = (await db.query(`
      SELECT count(*) n FROM stg_rplan s
        JOIN commercial.warehouses w ON w.id = s.warehouse_id
       WHERE w.code LIKE 'RUTA-%'`)).rows[0];
    const rutasSinMapa = (await db.query(`
      SELECT string_agg(rw.code, ', ') codes FROM commercial.warehouses rw
       WHERE rw.tenant_id=$1 AND rw.code LIKE 'RUTA-%' AND rw.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM analytics.sales_by_route_monthly m
                          WHERE m.tenant_id=rw.tenant_id AND m.route_code = 'WIN-' || replace(rw.code,'RUTA-',''))`, [M])).rows[0];
    const mx = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { maximumFractionDigits: 0 });
    console.log(`  cordura: tránsito ${mx(chk.transito)} vs inventario ${mx(chk.inventario)}${Number(chk.transito) > Number(chk.inventario) ? '  ⚠ TRÁNSITO > INVENTARIO — revisar unidad' : ''}`);
    console.log(`  estación: ${chk.prods_con_estacion} productos con ratio≠1 (rango ${chk.season_min}–${chk.season_max}) · colchón cuantílico: ${chk.prods_con_colchon} · lead derivado: ${chk.prods_con_lead}`);
    if (Number(rutasResid.n) > 0) console.log(`  ⚠ ${rutasResid.n} filas de RUTA-* siguen en el fact (el fold a sucursal no cubrió todo)`);
    if (rutasSinMapa.codes) console.log(`  ⚠ rutas sin mapeo a sucursal (demanda se queda en la ruta): ${rutasSinMapa.codes}`);
    console.log(`  puntos ciegos conocidos: tránsito de MD-30/MD-32 (sus compras directas no están en el ODS — pendiente extender la replicación)`);

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
