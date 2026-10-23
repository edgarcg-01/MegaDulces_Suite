'use strict';

/**
 * [AB.25] Medir antes de construir — READ-ONLY contra pg-prod (transacción READ ONLY + statement_timeout).
 *
 * Por almacén, sobre lo que la mesa de Autoabasto lista (Falta > 0):
 *   · renglones que la mesa vuelve a pedir aunque ya vienen (lo que «Mi pedido» resta y la mesa no);
 *   · renglones donde la «Acción» de la mesa contradice a quién se le pide en «Mi pedido»;
 *   · cuánto de la falta neta cubre el plan de Compras (el árbitro de ADR-100).
 *
 * Reproduce con el TEXTO de las expresiones del motor (commercial-replenishment.service.ts:
 * demandTarget · onHand('plan') · networkSurplus · transferIn · accionExpr · cajaFactor) y el
 * agrupado de autoabasto-pedido.service.ts. NO corre el servicio (regla: nada de backend local),
 * así que el cruce contra la API queda NO MEDIDO.
 *
 * Uso:  node database/scripts/ab25-mesa-vs-pedido.js [--ventana=7|30]
 *       (lee PROD_DB_URL del .env; --ventana = días del plan de Compras, default 7 como «Mi pedido»;
 *        con 30 incluye también las requisiciones 'ordered')
 */
const path = require('path');
const R = path.join(__dirname, '..', '..');
const VENTANA = Number((process.argv.find((a) => a.startsWith('--ventana=')) || '--ventana=7').split('=')[1]) === 30 ? 30 : 7;
const ESTADOS = VENTANA === 30 ? "'pending_approval','approved','ordered'" : "'pending_approval','approved'";
require(path.join(R, 'node_modules/dotenv')).config({ path: path.join(R, '.env'), quiet: true });
const { Client } = require(path.join(R, 'node_modules/pg'));
const T = '00000000-0000-0000-0000-00000000d01c';

// coberturaAutoabastoSql('w.code') — mismo mapa que libs/contracts (COBERTURA_AUTOABASTO).
const COV = `(CASE upper(btrim(w.code)) WHEN '02' THEN 21 WHEN '03' THEN 21 WHEN '04' THEN 21 WHEN '05' THEN 21 WHEN '07' THEN 21 ELSE 30 END)`;

const SQL = `
WITH base AS MATERIALIZED (
  SELECT rp.warehouse_id, w.code, rp.product_id, btrim(pr.sku) AS sku, pr.supplier_id,
         COALESCE(rpl.stock_pz, 0) AS oh,
         (COALESCE(rpl.daily_pieces, 0) * COALESCE(rpl.season_ratio, 1) * ${COV}
           / (COALESCE(rpl.suf, 1) * COALESCE(rpl.bf, 1)) * COALESCE(rpl.display_bf, rpl.bf, 1)) AS target,
         rp.max_stock, GREATEST(COALESCE(vbf.box_factor, 1), 1) AS cf,
         rc.via, rc.source_warehouse_id
    FROM commercial.reorder_policy rp
    JOIN catalog.products pr ON pr.tenant_id = rp.tenant_id AND pr.id = rp.product_id
    JOIN commercial.warehouses w ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
    LEFT JOIN analytics.replenishment_plan rpl ON rpl.tenant_id = rp.tenant_id AND rpl.warehouse_id = rp.warehouse_id AND rpl.product_id = rp.product_id
    LEFT JOIN analytics.v_warehouse_box_factor vbf ON vbf.tenant_id = rp.tenant_id AND vbf.warehouse_id = rp.warehouse_id AND vbf.product_id = rp.product_id
    LEFT JOIN commercial.replenishment_channel rc ON rc.tenant_id = rp.tenant_id AND rc.warehouse_id = rp.warehouse_id AND rc.supplier_id = pr.supplier_id
   WHERE rp.tenant_id = $1),
b2 AS (SELECT *, GREATEST(0, target - oh) AS sug, GREATEST(0, oh - max_stock) AS surh FROM base),
sbp AS (SELECT product_id, SUM(surh) AS surplus_total, SUM(CASE WHEN surh > 0 THEN 0 ELSE sug END) AS need_total FROM b2 GROUP BY 1),
b3 AS (
  SELECT b2.*, CASE WHEN surh > 0 OR COALESCE(s.need_total, 0) <= 0 THEN 0
                    ELSE sug * LEAST(1.0, COALESCE(s.surplus_total, 0) / s.need_total) END AS tin
    FROM b2 LEFT JOIN sbp s USING (product_id)),
mesa AS (
  SELECT *, CASE WHEN surh > 0 THEN 'sobrante' WHEN tin > 0 AND sug - tin <= 0 THEN 'traspaso'
                 WHEN tin > 0 THEN 'traspaso_parcial' WHEN sug > 0 THEN 'comprar' ELSE 'ok' END AS accion,
            CASE WHEN via = 'transfer' AND source_warehouse_id IS NOT NULL THEN 'matriz'
                 WHEN supplier_id IS NOT NULL THEN 'proveedor' ELSE 'sin_ruta' END AS grupo,
            sug / cf AS falta_cajas
    FROM b3),
-- Lo que ya viene, como lo lee «Mi pedido» (PEDIDOS_SUCURSAL_SQL + EMBARCADO_SIN_RECIBIR_SQL), por sucursal × sku.
cat AS (SELECT dest_code, suc_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = $1),
ped AS (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6) k.sucursal, k.c2, k.c3, k.c4, k.c5, k.c6,
         btrim(k.c10::text) AS dest, upper(btrim(k.c11::text)) AS est, k.c9::date AS f
    FROM kepler_ods.kdm1 k
   WHERE k.c2='U' AND k.c3='D' AND (k.c4)::int=40 AND btrim(k.c1)=btrim(k.sucursal)
     AND k.c9 >= current_date - 60 AND upper(btrim(k.c27::text))='SUCURSAL'
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC),
emb AS (
  SELECT h.sucursal, h.c2, h.c3, h.c4, h.c5, h.c6, btrim(h.c10::text) AS dest
    FROM kepler_ods.kdm1 h JOIN cat ON cat.dest_code = btrim(h.c10::text)
   WHERE h.c2='U' AND h.c3='D' AND (h.c4)::int=41 AND btrim(h.c1)=btrim(h.sucursal)
     AND btrim(COALESCE(h.c43,''))<>'C' AND (h.c9)::date >= current_date - 7
     AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 x
                      WHERE x.c2='U' AND x.c3='A' AND (x.c4)::int=50
                        AND btrim(x.sucursal)=cat.suc_code AND btrim(x.c1)=cat.suc_code
                        AND x.c37=41 AND x.c38=h.c5 AND btrim(x.c39::text)=btrim(h.c6::text)
                        AND btrim(COALESCE(x.c43,''))<>'C' AND (x.c9)::date >= (h.c9)::date - 1)),
docs AS (
  SELECT sucursal, c2, c3, c4, c5, c6, dest FROM ped WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f >= current_date - 7
  UNION ALL SELECT sucursal, c2, c3, c4, c5, c6, dest FROM emb),
viene AS (
  SELECT DISTINCT c.suc_code, btrim(x.c8::text) AS sku
    FROM docs d JOIN cat c ON c.dest_code = d.dest
    JOIN kepler_ods.kdm2 x ON x.sucursal=d.sucursal AND x.c2=d.c2 AND x.c3=d.c3 AND x.c4=d.c4 AND x.c5=d.c5 AND x.c6=d.c6
     AND btrim(x.c1)=btrim(x.sucursal)
   WHERE NULLIF(btrim(x.c8::text),'') IS NOT NULL),
-- El plan de Compras para ese almacén (AB.24: pending_approval / approved, 7 días). final_qty en cajas, como lo toma «Mi pedido».
plan AS (
  SELECT r.warehouse_id, l.product_id, SUM(l.final_qty) AS plan_cajas,
         bool_or(r.source_type = 'branch') AS es_traspaso
    FROM commercial.purchase_requisitions r
    JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
   WHERE r.tenant_id = $1 AND r.estado IN (${ESTADOS}) AND r.kepler_folio IS NULL
     AND r.created_at >= now() - interval '${VENTANA} days' AND COALESCE(l.final_qty, 0) > 0
   GROUP BY 1, 2),
j AS (
  SELECT m.*, (v.sku IS NOT NULL) AS viene, p.plan_cajas
    FROM mesa m
    LEFT JOIN viene v ON v.suc_code = m.code AND v.sku = m.sku
    LEFT JOIN plan p ON p.warehouse_id = m.warehouse_id AND p.product_id = m.product_id)
SELECT code AS almacen,
       count(*) FILTER (WHERE sug > 0)                                                    AS mesa_lista,
       count(*) FILTER (WHERE sug > 0 AND viene)                                          AS ya_viene_y_la_mesa_pide,
       count(*) FILTER (WHERE sug > 0 AND accion IN ('traspaso','traspaso_parcial') AND grupo <> 'matriz') AS dice_traspaso_y_surte_otro,
       count(*) FILTER (WHERE sug > 0 AND accion = 'comprar' AND grupo = 'matriz')        AS dice_comprar_y_surte_matriz,
       count(*) FILTER (WHERE sug > 0 AND grupo = 'sin_ruta')                             AS sin_ruta,
       count(*) FILTER (WHERE sug > 0 AND NOT viene)                                      AS nadie_lo_pidio_kepler,
       count(*) FILTER (WHERE sug > 0 AND NOT viene AND plan_cajas > 0)                   AS de_esos_compras_planeo,
       round(SUM(falta_cajas) FILTER (WHERE sug > 0 AND NOT viene))                       AS falta_cajas,
       round(SUM(LEAST(COALESCE(plan_cajas, 0), falta_cajas)) FILTER (WHERE sug > 0 AND NOT viene))    AS cubierto_por_plan_cajas,
       count(*) FILTER (WHERE plan_cajas > 0)                                             AS renglones_en_plan,
       count(*) FILTER (WHERE plan_cajas > 0 AND sug = 0)                                 AS plan_sin_falta
  FROM j GROUP BY code ORDER BY code`;


(async () => {
  const c = new Client({ connectionString: process.env.PROD_DB_URL });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  await c.query("SET LOCAL statement_timeout = '180s'");
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T]);
  const id = (await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  const hoy = (await c.query(`SELECT to_char(now() AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS h`)).rows[0].h;
  console.log(`system_identifier ${id} · ${hoy} MX · plan de Compras: ${VENTANA} días`);
  for (const [k, sql] of [['ab25', SQL]]) {
    const t0 = Date.now();
    const r = await c.query(sql, [T]);
    console.log(`\n## ${k} (${r.rowCount} filas, ${Date.now() - t0} ms)`);
    console.table(r.rows);
  }
  await c.query('ROLLBACK');
  await c.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
