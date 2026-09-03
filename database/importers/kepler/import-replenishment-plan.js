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
// costo 13.5: son cajas). RA-PRO.43: la línea trae su PROPIA conversión declarada (`c58` = unidades
// de la línea por caja, `c55` = unidad de caja, `c57` = costo de esa caja; verificado `c12 × c58 =
// c57` exacto), y ésa manda cuando el costo de caja del documento cuadra con el nuestro. Si no
// cuadra —o el documento no la trae— se cae al fallback que infiere por costo. A/B sobre las 2,558
// líneas abiertas: 84.4 % usan el factor declarado y sólo 5 líneas cambian ($3.1k sobre $21.3M), o
// sea el dato confirma la heurística; se prefiere igual porque declarado > inferido.
// `t` sale en CAJAS, con los MISMOS factores que el resto del fact (`econ`) — la conversión
// ocurre UNA sola vez, acá.
//
// Esto reemplazó a `import-in-transit.js` + `analytics.purchase_in_transit` (2026-08-28): mientras
// fueron un importer y una tabla aparte, el rename `qty_in_transit` → `transit_cajas` se comió la
// conversión y el motor restaba ~bf veces de más. Ver GOTCHAS §25.
const IN_TRANSIT_DAYS = Math.max(1, Number(process.env.IN_TRANSIT_DAYS) || 120);

// RA-PRO.45 — NO TODO EL TRÁNSITO LLEGA. En Kepler la OC `X-A-35` se captura CUANDO SE RECIBE
// (81% de las del CEDIS y 95–100% de las de sucursal cierran el MISMO día), así que una OC que
// sigue abierta no es "el pipeline normal": es un documento estancado. Medido 2026-08-29 sobre las
// OCs de hace 180–400 d (ya todas resueltas, sin censura): de las que seguían abiertas al día 45
// sólo el 13.6% terminó recibiéndose. Restar el 100% de esas OCs sobrecreditaba $10.4M de $20.3M
// (51%) y dejaba 420 filas producto×almacén en piso CERO sin pedir. Ver reporte del 2026-08-29.
//
// En vez de un tope de antigüedad arbitrario, el motor pesa cada OC por P(llega | edad) — y esa
// curva se DERIVA del propio ODS cada corrida (cero captura manual, misma tesis que el lead time
// y la estación). Monótona no creciente por construcción; si un bucket no junta muestra (n<25)
// cae a la curva medida. Se guardan las dos cantidades: `t` = lo que dicen los papeles (lo que ve
// el comprador en la columna "En camino") y `te` = lo que el motor descuenta de verdad.
const SURV_MIN_N = 25;
// ⚠ MATERIALIZED en las dos: sin eso el planner las inlinea y re-evalúa `surv_raw` (2 s, barrido de
// 220 días de OCs con subconsulta correlacionada) POR CADA línea de OC del tránsito — la corrida
// pasó de 30 s a >15 min. Con MATERIALIZED se calcula una vez y el join contra 8 filas es gratis.
// RA-PRO.45.1 — FECHA DE ENTRADA por OC. Es el ÚNICO decode de la cadena que queda escrito a mano,
// y a propósito: `analytics.erp_purchase_orders` expone `cerrada` (booleano) pero NO la fecha,
// porque exponerla como columna de la vista costaba 213 s (un min() no corta al primer match como
// el EXISTS). Acá el barrido está acotado a la ventana histórica y corre UNA vez por corrida.
// De este CTE salen las DOS señales que necesitan la fecha: la curva y el lead time.
const ocHist = `
  oc_hist AS MATERIALIZED (
    SELECT o.sucursal, o.c1 AS almacen, o.c6 AS folio, o.c9::date AS f_oc,
           COALESCE(o.c43, 'N') AS estatus,
           (SELECT min(oe.c9::date)
              FROM kepler_ods.kdm1 vale
              JOIN kepler_ods.kdm1 oe ON oe.sucursal=vale.sucursal AND oe.c1=vale.c1
                                     AND oe.c2='X' AND oe.c3='A' AND oe.c4='40'
                                     AND oe.c37='37' AND oe.c39=vale.c6
             WHERE vale.sucursal=o.sucursal AND vale.c1=o.c1 AND vale.c2='X' AND vale.c3='A'
               AND vale.c4='37' AND vale.c37='35' AND vale.c39=o.c6) AS f_ent
      FROM kepler_ods.kdm1 o
     WHERE o.sucursal=o.c1 AND o.c2='X' AND o.c3='A' AND o.c4='35'
       AND o.c9::date >= CURRENT_DATE - 400
  )`;

const survOds = `
  surv_raw AS MATERIALIZED (
    SELECT f_oc, f_ent FROM oc_hist
     WHERE estatus <> 'C'                                  -- las canceladas no son "no llegó"
       AND f_oc BETWEEN CURRENT_DATE - 400 AND CURRENT_DATE - 180
  ),
  surv AS MATERIALIZED (
    SELECT edad, n,
           min(p_raw) OVER (ORDER BY edad ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS p
      FROM (
        SELECT b.d AS edad,
               count(*) FILTER (WHERE s.f_ent IS NULL OR s.f_ent - s.f_oc > b.d) AS n,
               CASE WHEN count(*) FILTER (WHERE s.f_ent IS NULL OR s.f_ent - s.f_oc > b.d) >= ${SURV_MIN_N}
                    THEN count(*) FILTER (WHERE s.f_ent IS NOT NULL AND s.f_ent - s.f_oc > b.d)::numeric
                       / count(*) FILTER (WHERE s.f_ent IS NULL OR s.f_ent - s.f_oc > b.d)
                    ELSE (CASE b.d WHEN 0 THEN 0.85 WHEN 4 THEN 0.75 WHEN 8 THEN 0.60 WHEN 15 THEN 0.50
                                   WHEN 22 THEN 0.45 WHEN 31 THEN 0.25 WHEN 46 THEN 0.13 ELSE 0.10 END)::numeric
               END AS p_raw
          FROM surv_raw s
         CROSS JOIN (VALUES (0),(4),(8),(15),(22),(31),(46),(61)) b(d)
         GROUP BY b.d) z
  )`;
// Bucket de edad de una OC → arista de la curva. Se toma la arista INFERIOR (probabilidad al
// ENTRAR al bucket, la más alta del tramo): conservador, acredita de más antes que de menos.
const survBucket = (age) => `(CASE WHEN ${age} <= 3 THEN 0 WHEN ${age} <= 7 THEN 4 WHEN ${age} <= 14 THEN 8
                                   WHEN ${age} <= 21 THEN 15 WHEN ${age} <= 30 THEN 22 WHEN ${age} <= 45 THEN 31
                                   WHEN ${age} <= 60 THEN 46 ELSE 61 END)`;

const trOds = `
  ${survOds},
  -- MATERIALIZED: la vista trae un EXISTS por OC (la cadena). Sin la barrera el planner lo mete
  -- adentro del join con las líneas y lo evalúa una vez POR RENGLÓN. Acá se resuelve el conjunto
  -- de OC abiertas primero (~180 filas, 0.3 s) y el resto es un join contra folios.
  oc_open AS MATERIALIZED (
    SELECT sucursal, folio, dias_abierta
      FROM analytics.erp_purchase_orders
     WHERE doc_date >= CURRENT_DATE - ${IN_TRANSIT_DAYS}
       AND NOT cerrada
       -- El propio ERP ya la dio por cerrada: F=finalizada, C=cancelada, R=recibida. La cadena de
       -- documentos quedó rota pero no viene nada — 22 OCs / $1.28M de puro fantasma (2026-08-29).
       AND estatus NOT IN ('F', 'C', 'R')
  ),
  tr_ln AS (
    SELECT w.id AS warehouse_id, COALESCE(al.canonical_product_id, e.product_id) AS product_id,
           (CASE
                 -- 1) FACTOR DECLARADO POR EL DOCUMENTO. La línea de la OC trae su propia
                 --    conversión (unidad_caja / unidades_por_caja / costo_caja, normalizadas en
                 --    analytics.erp_purchase_doc_lines desde c55/c58/c57). Se acepta sólo
                 --    si la caja del documento CUADRA con la nuestra por dinero (±15% de
                 --    real_cost × bf) — si el proveedor empaca distinto a como lo tenemos en
                 --    catálogo, el costo de caja no cuadra y no se usa (cae al fallback).
                 WHEN l.unidades_por_caja > 0
                      AND e.real_cost > 0
                      AND l.costo_caja > 0
                      AND abs(l.costo_caja - e.real_cost * e.bf) <= 0.15 * (e.real_cost * e.bf)
                   THEN l.cantidad / l.unidades_por_caja
                 -- 2) FALLBACK — inferir la unidad por costo (lo único que había antes de RA-PRO.43):
                 --    cantidad × costo_unitario es invariante a la unidad, así que
                 --    costo_unitario / costo_por_unidad_de_stock dice cuántas unidades de stock
                 --    trae la línea; ÷bf la lleva a cajas.
                 ELSE (l.cantidad * CASE
                         WHEN e.real_cost <= 0 OR l.costo_unitario <= 0 THEN 1
                         WHEN l.costo_unitario / e.real_cost < 1.5 THEN 1
                         ELSE LEAST(l.costo_unitario / e.real_cost, GREATEST(e.bf, 1)) END
                      ) / GREATEST(e.bf, 1)
               END) AS cj,
           sv.p AS w
      FROM oc_open oc
      JOIN analytics.erp_purchase_doc_lines l
        ON l.doctype='XA3501' AND l.sucursal=oc.sucursal AND l.folio=oc.folio
      JOIN commercial.warehouses w
        ON w.tenant_id=$1 AND w.deleted_at IS NULL AND COALESCE(w.kepler_code, w.code)=oc.sucursal
      JOIN econ e ON e.sku = l.sku
      LEFT JOIN commercial.product_aliases al
        ON al.tenant_id=$1 AND al.alias_product_id=e.product_id AND al.deleted_at IS NULL
      JOIN surv sv ON sv.edad = ${survBucket('oc.dias_abierta')}
     WHERE l.cantidad > 0
  ),
  tr AS (
    SELECT warehouse_id, product_id, sum(cj) AS t, sum(cj * w) AS te
      FROM tr_ln GROUP BY 1, 2)`;
// Sin ODS (dev local sin réplica) el fact se arma igual, con tránsito 0 — no revienta.
const trEmpty = `tr AS (SELECT NULL::uuid AS warehouse_id, NULL::uuid AS product_id,
                              0::numeric AS t, 0::numeric AS te WHERE false)`;

// LEAD TIME PROVEEDOR — DERIVADO del ODS (RA-PRO.41, cero captura manual). Kepler captura la cadena
// de un jalón (84% de las OCs cierran el MISMO día → lag 0, sin señal); la señal real vive en el
// ~16% de OCs capturadas ANTES de recibir: mediana del lag OC(X-A-35)→entrada(X-A-40) por proveedor
// (n≥5; medido: mediana global 4d, p90 8d, 108 proveedores con señal). El fallback global viene en
// la fila `supplier_id IS NULL`; el motor remata con COALESCE(..., 4).
// RA-PRO.45.1: reusa `oc_hist` (la fecha de entrada ya está resuelta ahí) en vez de repetir el
// barrido de la cadena. Antes esta consulta era la TERCERA copia del mismo decode.
const leadOds = `
  lead_raw AS (
    SELECT DISTINCT p.supplier_id, o.sucursal, o.folio, (o.f_ent - o.f_oc) AS d
      FROM oc_hist o
      JOIN analytics.erp_purchase_doc_lines l
        ON l.doctype='XA3501' AND l.sucursal=o.sucursal AND l.folio=btrim(o.folio)
      JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=l.sku AND p.supplier_id IS NOT NULL
     WHERE o.f_oc >= CURRENT_DATE - 240 AND o.f_ent > o.f_oc
  ),
  lead AS (
    SELECT supplier_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY d) AS lead_d
      FROM lead_raw GROUP BY supplier_id HAVING count(*) >= 5
    UNION ALL
    SELECT NULL, percentile_cont(0.5) WITHIN GROUP (ORDER BY d) FROM lead_raw
  )`;
const leadEmpty = `lead AS (SELECT NULL::uuid AS supplier_id, NULL::numeric AS lead_d WHERE false)`;
const histEmpty = `oc_hist AS (SELECT NULL::text AS sucursal, NULL::text AS almacen, NULL::text AS folio,
                                     NULL::date AS f_oc, NULL::text AS estatus, NULL::date AS f_ent WHERE false)`;

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

// `hist` = oc_hist (la cadena OC→entrada resuelta una sola vez) o vacío si no hay ODS. Lo comparten
// la curva de supervivencia (dentro de `tr`) y el lead time, que antes lo derivaban por separado.
const cte = (hist, tr, lead) => `
  WITH ur AS (${urBody}),
  ${hist},
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
           pv.buy_rate, pv.last_purchase, pv.order_days, pv.primary_wh,
           -- RA-PRO.46 — EL COSTO DE CAJA SE LEE DE KEPLER, NO SE CALCULA.
           -- "Costo Uni Mayor" (kdpv_prov_prod.c4) YA ES el costo de una caja. Reconstruirlo con
           -- real_cost × bf fallaba por los dos lados:
           --   1. el MULTIPLICADOR: bf no siempre está en el peldaño del costo. En el azúcar 99029
           --      lo pagado está en KG y bf=50 es el factor 500g→costal → $798.57 por un costal
           --      de $415 (+92%);
           --   2. la BASE: real_cost es el promedio ponderado de 90 d, o sea REZAGADO. En los
           --      cerillos 00303 las compras reales son $11.0793 clavado (50 pzas = $553.97
           --      exacto), pero una compra vieja a $11.8774 subía el promedio a $11.3454 →
           --      $567.27 por una caja de $553.97. Multiplicar bien una base podrida sigue dando mal.
           -- Medido: el costo del proveedor sigue a la ÚLTIMA compra con mediana 1.0000 (62.6%
           -- exacto al 0.5%); el promedio de 90 d da 1.0058 y sólo 37.6% exacto. Leerlo sacó $1.1M
           -- de costo inventado del catálogo. bf queda de respaldo para el 1.6% sin escalera.
           -- Ver docs/ERP_KEPLER.md §2.1 y §5 regla 0.
           lad.box_cost AS lad_box_cost
      FROM pf
      LEFT JOIN lbl ON lbl.product_id = pf.product_id
      LEFT JOIN uov ON uov.product_id = pf.product_id
      LEFT JOIN kbf ON kbf.product_id = pf.product_id
      LEFT JOIN ur  ON ur.product_id  = pf.product_id
      LEFT JOIN pv  ON pv.product_id  = pf.product_id
      LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = pf.sku
  ),
  dem AS (SELECT COALESCE(al.canonical_product_id, pd.product_id) AS product_id,
                 COALESCE(rm.home_wh, pd.warehouse_id) AS warehouse_id,   -- ruta → su sucursal madre
                 sum(pd.daily_pieces) AS daily_pieces, sum(pd.revenue) AS revenue30
            FROM analytics.product_demand pd
            LEFT JOIN commercial.product_aliases al ON al.tenant_id=pd.tenant_id AND al.alias_product_id=pd.product_id AND al.deleted_at IS NULL
            LEFT JOIN rmap rm ON rm.route_wh = pd.warehouse_id
           WHERE pd.tenant_id=$1 AND pd.window_days=30 GROUP BY 1,2),
  -- ADR-052 — la existencia se DERIVA del ODS, ya no se lee la copia \`commercial.stock\`.
  -- Medido contra el POS en vivo (2026-09-02): la vista acierta 100.0% y la copia 91.0% (15,324
  -- unidades de error), porque el importer de la copia es delta contra un snapshot en disco que se
  -- desincroniza y deja valores fantasma para siempre.
  -- ⚠️ LA VISTA NO CONVIERTE UNIDADES, Y ESO ES DELIBERADO. Wincaja guarda la existencia en su
  -- unidad de venta (el PAQUETE en multipack) — pero su DEMANDA viene en esa MISMA unidad
  -- (verificado: \`analytics.sales_daily.units\` coincide 1:1 con \`wincaja.v_sales_daily.qty\` en
  -- los 182 multipack de MD-30), y \`reorder_policy\` se deriva de esa demanda. O sea existencia,
  -- demanda y umbrales son AUTO-CONSISTENTES por almacén. Convertir sólo la existencia rompe el
  -- pedido: se ve \`factor\` veces más grande que su demanda y el motor deja de pedir. Ya pasó —
  -- mig 20260902200000 lo revirtió. El problema de Wincaja es de DISPLAY (mostrar cajas), y para
  -- eso está \`display_box_factor\`, que NO se usa acá.
  -- El plegado de aliases se hace ACÁ a propósito: la vista es "existencia por almacén x producto"
  -- y no pliega (una sola responsabilidad).
  stk AS (SELECT COALESCE(al.canonical_product_id, v.product_id) AS product_id, v.warehouse_id, sum(v.qty_stock_units) AS quantity
            FROM analytics.v_erp_stock_on_hand v
            LEFT JOIN commercial.product_aliases al ON al.tenant_id=v.tenant_id AND al.alias_product_id=v.product_id AND al.deleted_at IS NULL
           WHERE v.tenant_id=$1 GROUP BY 1,2),
  ${tr},
  -- RA-PRO.42 — el TRÁNSITO BAJA POR EL ÁRBOL DE ABASTO. La compra está CENTRALIZADA: el 98% del
  -- tránsito se captura en el CEDIS '00' ($13.0M, que vende $0) y en Padre Hidalgo '01' ($8.3M),
  -- mientras Canindo '06' ($8.5M/mes de venta) y MD-30 ($14.6M/mes) tienen CERO. Atribuir el
  -- tránsito al almacén donde se captura hacía dos daños opuestos a la vez: el que captura
  -- sub-pide (su OC de red tapa su propia necesidad) y los demás SOBRE-piden (no reciben crédito
  -- de lo que ya viene para ellos) — y lo parkeado en el CEDIS se perdía del todo, porque el CEDIS
  -- tiene demanda propia 0 y ese crédito no le bajaba a nadie.
  -- Reparto proporcional a la demanda del subárbol que ese almacén surte (mismo criterio con que
  -- transferPlan reparte el stock del CEDIS). Σ tránsito de red se conserva: sólo cambia de manos.
  whtree AS (
    WITH RECURSIVE t AS (
      SELECT w.id AS anc, w.id AS des, 0 AS depth
        FROM commercial.warehouses w WHERE w.tenant_id=$1 AND w.deleted_at IS NULL
      UNION ALL
      SELECT t.anc, c.id, t.depth + 1
        FROM t JOIN commercial.warehouses c
          ON c.tenant_id=$1 AND c.deleted_at IS NULL AND c.source_warehouse_id = t.des
       WHERE t.depth < 5   -- guarda anti-ciclo (el árbol real tiene profundidad 2)
    ) SELECT DISTINCT anc, des FROM t),
  tr_sub AS (   -- demanda del subárbol de cada almacén, por producto
    SELECT wt.anc, d.product_id, sum(d.daily_pieces) AS sub_dem
      FROM whtree wt JOIN dem d ON d.warehouse_id = wt.des
     GROUP BY 1,2),
  tr_eff AS (   -- tránsito EFECTIVO por almacén: lo propio + su parte de lo que baja de sus padres
    SELECT wt.des AS warehouse_id, tr.product_id,
           sum(tr.t * CASE WHEN s.sub_dem > 0 THEN COALESCE(d.daily_pieces, 0) / s.sub_dem
                           WHEN wt.anc = wt.des THEN 1 ELSE 0 END) AS t,
           sum(tr.te * CASE WHEN s.sub_dem > 0 THEN COALESCE(d.daily_pieces, 0) / s.sub_dem
                            WHEN wt.anc = wt.des THEN 1 ELSE 0 END) AS te
      FROM tr
      JOIN whtree wt ON wt.anc = tr.warehouse_id
      LEFT JOIN tr_sub s ON s.anc = tr.warehouse_id AND s.product_id = tr.product_id
      LEFT JOIN dem d ON d.warehouse_id = wt.des AND d.product_id = tr.product_id
     GROUP BY 1,2),
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
    UNION SELECT warehouse_id, product_id FROM tr_eff
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
           -- RA-PRO.45: lo mismo pero pesado por P(llega|edad). transit_cajas es lo que dicen los
           -- papeles (lo que el comprador ve y puede rastrear folio por folio); ESTA es la que el
           -- motor descuenta de la necesidad.
           round(COALESCE(t.te, 0)::numeric, 2) AS transit_eff_cajas,
           e.suf, e.bf,
           -- RA-PRO.46: se LEE de Kepler; bf sólo si el SKU no tiene escalera (ver econ).
           COALESCE(e.lad_box_cost, e.real_cost * e.bf) AS caja_cost,
           -- Se DECLARA de dónde salió: kepler = lo dijo el ERP; bf = reconstruido (puede mezclar
           -- peldaños y arrastra el rezago del promedio de 90 d).
           CASE WHEN e.lad_box_cost IS NOT NULL THEN 'kepler' ELSE 'bf' END AS cost_source,
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
      LEFT JOIN tr_eff t   ON t.warehouse_id = b.warehouse_id AND t.product_id = b.product_id
      LEFT JOIN child_dem cd ON cd.hub = b.warehouse_id AND cd.product_id = b.product_id
      LEFT JOIN season se  ON se.product_id = b.product_id
      LEFT JOIN saf sa     ON sa.product_id = b.product_id
      LEFT JOIN lead sl    ON sl.supplier_id = e.supplier_id
      LEFT JOIN lead lg    ON lg.supplier_id IS NULL`;

// Orden EXACTO del INSERT. Key = PK; DATA = lo que se compara para saltar filas idénticas.
const COLS = ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'nombre', 'supplier_id', 'category_id',
  'source_warehouse_id', 'is_hub', 'daily_pieces', 'revenue30', 'eff_daily', 'stock_pz', 'transit_cajas',
  'transit_eff_cajas',
  'suf', 'bf', 'caja_cost', 'cost_source', 'price_ratio', 'unit_source', 'buy_rate', 'real_buy_cost', 'last_purchase',
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
    const CTE = cte(hasOds ? ocHist : histEmpty, hasOds ? trOds : trEmpty, hasOds ? leadOds : leadEmpty);
    if (!hasOds) console.log('  ⚠ sin kepler_ods → tránsito = 0 y lead_days = NULL (dev local sin réplica)');

    const s = await db.query(`${CTE} SELECT count(*)::int filas, count(DISTINCT b.product_id)::int prods,
                                     count(DISTINCT b.warehouse_id)::int whs FROM base b JOIN econ e ON e.product_id=b.product_id`, [M]);
    console.log(`  filas almacén×producto=${Number(s.rows[0].filas).toLocaleString()} · productos=${s.rows[0].prods} · almacenes=${s.rows[0].whs}`);

    const t0 = Date.now();
    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_rplan ON COMMIT DROP AS ${CTE} ${PROJECT}`, [M]);

    // ── Controles de cordura (RA-PRO.41, "que no se nos pase nada") — se imprimen en CADA corrida.
    // El bug del tránsito fantasma vivió 7 semanas porque nadie cruzaba dos magnitudes; ahora el
    // propio feed reporta lo que ve y lo que NO puede ver.
    const chk = (await db.query(`
      SELECT round(sum(transit_cajas*caja_cost)::numeric,0)            AS transito,
             round(sum(transit_eff_cajas*caja_cost)::numeric,0)        AS transito_eff,
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
    // RA-PRO.45 — la curva de supervivencia se re-deriva cada corrida: hay que poder verla, y se
    // MATERIALIZA para que el motor y la bandeja de OCs abiertas lean la misma (un solo productor).
    if (hasOds) {
      const sv = (await db.query(`WITH ${ocHist}, ${survOds} SELECT edad, n, round(p*100,1) pct FROM surv ORDER BY edad`)).rows;
      const flacos = sv.filter((r) => Number(r.n) < SURV_MIN_N).length;
      console.log(`  supervivencia OC: ${sv.map((r) => `${r.edad}d→${r.pct}%`).join(' ')}${flacos ? `  ⚠ ${flacos} tramos sin muestra (fallback)` : ''}`);
      if (APPLY) {
        await db.query(`DELETE FROM analytics.oc_survival_curve WHERE tenant_id = $1`, [M]);
        for (const r of sv) {
          await db.query(
            `INSERT INTO analytics.oc_survival_curve (tenant_id, edad, muestra, p, fallback, computed_at)
             VALUES ($1, $2, $3, $4, $5, now())`,
            [M, r.edad, r.n, Number(r.pct) / 100, Number(r.n) < SURV_MIN_N]);
        }
      }
      const desc = Number(chk.transito) - Number(chk.transito_eff);
      console.log(`  tránsito descontado: papeles ${mx(chk.transito)} → efectivo ${mx(chk.transito_eff)} (se ignora ${mx(desc)}, ${chk.transito > 0 ? Math.round((desc / chk.transito) * 100) : 0}%)`);
    }
    console.log(`  estación: ${chk.prods_con_estacion} productos con ratio≠1 (rango ${chk.season_min}–${chk.season_max}) · colchón cuantílico: ${chk.prods_con_colchon} · lead derivado: ${chk.prods_con_lead}`);
    if (Number(rutasResid.n) > 0) console.log(`  ⚠ ${rutasResid.n} filas de RUTA-* siguen en el fact (el fold a sucursal no cubrió todo)`);
    if (rutasSinMapa.codes) console.log(`  ⚠ rutas sin mapeo a sucursal (demanda se queda en la ruta): ${rutasSinMapa.codes}`);
    // RA-PRO.43 — el proveedor declara su empaque en la OC (`c58` unidades por caja, `c57` costo de
    // esa caja). La señal accionable NO es "c58 ≠ bf" a secas (la línea puede venir en otra unidad:
    // 1,691 SKUs caen ahí y son ruido), sino la CONTRADICCIÓN: el dinero dice que hablamos de la
    // MISMA caja (c57 ≈ caja_cost) pero el conteo difiere → o el catálogo está mal o el proveedor
    // cambió la presentación. Eso descuadra el pedido ENTERO del SKU, no sólo su tránsito. Medido
    // al introducirlo: 11 de 5,368 cajas verificables por dinero.
    if (hasOds) {
      const bfx = (await db.query(`
        WITH oc AS (
          SELECT DISTINCT l.c8 AS sku,
                 NULLIF(btrim(l.c58::text), '')::numeric AS c58,
                 NULLIF(btrim(l.c57::text), '')::numeric AS c57
            FROM kepler_ods.kdm1 o
            JOIN kepler_ods.kdm2 l
              ON l.sucursal=o.sucursal AND l.c1=o.c1 AND l.c2=o.c2 AND l.c3=o.c3 AND l.c4=o.c4 AND l.c6=o.c6
           WHERE o.sucursal=o.c1 AND o.c2='X' AND o.c3='A' AND o.c4='35'
             AND o.c9::date >= CURRENT_DATE - 60
             AND NULLIF(btrim(l.c58::text), '')::numeric > 0),
        cat AS (SELECT DISTINCT sku, bf, caja_cost FROM stg_rplan)
        SELECT count(*) FILTER (WHERE cat.caja_cost > 0
                                 AND abs(oc.c57 - cat.caja_cost) <= 0.15 * cat.caja_cost
                                 AND abs(oc.c58 - cat.bf) >= 0.01)            AS contradicen,
               count(*) FILTER (WHERE cat.caja_cost > 0
                                 AND abs(oc.c57 - cat.caja_cost) <= 0.15 * cat.caja_cost) AS verificables
          FROM oc JOIN cat ON cat.sku = oc.sku`)).rows[0];
      if (Number(bfx?.contradicen) > 0) {
        console.log(`  ⚠ ${bfx.contradicen} de ${bfx.verificables} SKUs: el proveedor declara la MISMA caja por costo pero distinto conteo → revisar box_factor (descuadra todo el pedido de ese SKU)`);
      }
    }
    console.log(`  puntos ciegos conocidos: tránsito de MD-30/MD-32 (sus compras directas no están en el ODS — pendiente extender la replicación)`);

    // El dry-run ahora sí llega hasta acá: los controles se calculan sobre el staging real y se
    // tiran con el ROLLBACK. Antes salía antes de imprimirlos, que es justo cuando más se necesitan
    // (probar un cambio del motor sin escribir).
    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] nada cambió.'); return; }

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
