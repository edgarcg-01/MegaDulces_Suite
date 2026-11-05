'use strict';
/**
 * `[VEC.39]` — **Los combos Producto y Cliente de `/comercial/ventas-por-ruta` estaban congelados
 * desde el 2026-09-29**, y además armaban la vecinal con el importer retirado.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-05) ────────────────────────────────────────
 *  · `analytics.mv_route_filter_options` (`[AUD-DAT.17]`): `computed_at` = 2026-09-29 23:42 en
 *    TODAS sus filas. Nunca entró a ningún carril de refresco (su candado ya declaraba la
 *    frescura NO MEDIDA). Seguía en 6,298 clientes / $88,125,359.60, la cifra del día que nació.
 *  · Vendido del 29-sep al 5-nov que el combo NO ofrece: 586 de 886 clientes vecinales
 *    (≈ $2.0 M), 72 de 1,282 clientes de camioneta (≈ $100 k) y 163 SKU (≈ $206 k). Un cliente
 *    que no está en la lista se lee como «no le vendimos».
 *  · Su pierna vecinal sale de `route_push_lines`, lo que escribió el importer retirado (2.07×
 *    inflado, `[VEC.9]`); la vecinal correcta es `analytics.v_kepler_vecinal_sales_lines` (ODS).
 *
 * ── POR QUÉ DOS MATVISTAS Y NO REFRESCAR LA QUE HAY ─────────────────────────────────────────
 * El costo de la vieja lo pone `wincaja.v_sales_lines` (~12.5 s), y esa pierna ya no se mueve:
 * Wincaja dejó de vender por ruta el **2026-08-12** (`mv_rd_route_daily_200d`, venta derivada
 * > 0) y la rama `VEC-PH-H` está cortada en el código al 2026-06-28. Refrescar 12 s cada media
 * hora para recalcular historia quieta es justo el barrido que el PM prohibió (2026-10-27).
 *
 *  · `mv_route_filter_options_wincaja` — la historia de Wincaja, POR MES, poblada aquí una vez y
 *    **sin carril de refresco a propósito**: su fuente está congelada. La ventana de 2 años la
 *    aplica quien la lee (`month >= …`), así que envejece sola sin recalcular. Lleva `last_date`
 *    para el árbitro: si Wincaja volviera a vender por ruta después de esa fecha, el candado
 *    `test-newdb-route-filter-options.js` se pone rojo (debe encontrar 0).
 *  · `mv_route_filter_options_live` — camionetas (push, sin la vecinal del importer) + vecinal
 *    del ODS. Leída en vivo cuesta ~720 ms por combo (medido), sobre el techo de 500 ms; como
 *    matvista entra al ciclo de 30 min que YA refresca a sus hermanas de esta misma pantalla
 *    (`mv_kepler_vecinal_monthly`, `mv_rd_route_daily_200d`): mismo rezago que el resto del
 *    reporte, sin cron nuevo.
 *
 * El nombre del cliente vecinal sale de `kepler_ods.kdud` en la sucursal DEL RENGLÓN (`kdud` es
 * por sucursal: el mismo código es otra persona en otra, `[VEC.35]`); el de camioneta, de
 * `wincaja.clientes`. Sin nombre en la fuente, el rótulo es el código (no se inventa).
 *
 * ── Verificado contra la consulta en vivo del servicio (prod, sólo lectura) ─────────────────
 * Con la ventana acotada a 2026-07-01 (cubre el final de Wincaja), las dos matvistas juntas
 * contra el respaldo en vivo de `routeFilterOptions`: **3,104 = 3,104 clientes ·
 * $24,438,886.26 = $24,438,886.26 · 3,475 = 3,475 SKU · $28,361,412.11 · 0 diferencias por
 * código**. Cuerpo vivo: 3.4 s (lo paga el ciclo de 30 min). Wincaja jul–ago: 19.9 s.
 *
 * ⚠️ EXPAND: la vieja `mv_route_filter_options` NO se toca — la API desplegada la sigue leyendo
 *    hasta que llegue el código nuevo. Retirarla es el CONTRACT, en otra migración.
 * ⚠️ Aplicar ANTES de desplegar la API: el ciclo de refresco nuevo la busca y, sin ella, marca
 *    error.
 * ⛔ Y FUERA DE HORARIO HÁBIL: poblar la de Wincaja lee 2 años de `v_sales_lines`, que cuesta
 *    ~15 s POR MES de historia con el plan medido (dos meses: 19.9 s). Los 2 años **NO MEDIDOS**
 *    — estimado, varios minutos con el candado de migraciones tomado. El dueño (sin RLS) puede
 *    planearlo mejor; no se probó.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const WCJ = 'analytics.mv_route_filter_options_wincaja';
const LIVE = 'analytics.mv_route_filter_options_live';
const VECINAL_RX = '^[0-9]V[0-9]';

/** Wincaja: venta de ruta + la rama vecinal histórica de PH (las dos de `v_route_sales_lines`). */
const LINEAS_WCJ = `
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe, vl.business_date
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'ruta_venta'
     AND vl.business_date >= (CURRENT_DATE - INTERVAL '2 years')
  UNION ALL
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe, vl.business_date
    FROM wincaja.v_sales_lines vl
   WHERE vl.sale_channel = 'preventa_vecinal' AND vl.source_branch = '10'
     AND vl.business_date < '2026-06-28'::date
     AND vl.business_date >= (CURRENT_DATE - INTERVAL '2 years')`;

/** Lo que se sigue moviendo: camionetas (push) y vecinal (ODS). `suc` = sucursal para `kdud`. */
const LINEAS_LIVE = `
  SELECT rpl.tenant_id, rpl.cliente, rpl.sku, rpl.importe, NULL::text AS producto, NULL::text AS suc
    FROM analytics.route_push_lines rpl
   WHERE rpl.business_date >= (CURRENT_DATE - INTERVAL '2 years')
     AND COALESCE(rpl.route_no, '') !~ '${VECINAL_RX}'
  UNION ALL
  SELECT vl.tenant_id, vl.cliente, vl.sku, vl.importe, vl.producto, vl.warehouse_code
    FROM analytics.v_kepler_vecinal_sales_lines vl
   WHERE vl.business_date >= (CURRENT_DATE - INTERVAL '2 years')`;

const CLIENTE_VALIDO = `l.cliente IS NOT NULL AND btrim(l.cliente) <> '' AND l.cliente <> '0001'`;

// ⚠️ Se AGRUPA primero y se nombra después: con el LATERAL de nombres por renglón (como la vieja)
// la pierna Wincaja pasó de 180 s sin terminar (medido); agrupada, el LATERAL corre una vez por
// opción y no por línea.
const SQL_WCJ = `
  WITH lineas AS MATERIALIZED (${LINEAS_WCJ}),
  agg AS (
    SELECT l.tenant_id, 'cliente'::text AS kind, l.cliente AS value,
           date_trunc('month', l.business_date)::date AS month,
           sum(l.importe) AS rev, max(l.business_date) AS last_date
      FROM lineas l WHERE ${CLIENTE_VALIDO}
     GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT l.tenant_id, 'sku'::text, l.sku, date_trunc('month', l.business_date)::date,
           sum(l.importe), max(l.business_date)
      FROM lineas l WHERE l.sku IS NOT NULL
     GROUP BY 1, 2, 3, 4),
  nom AS (
    SELECT DISTINCT a.tenant_id, a.kind, a.value FROM agg a),
  nom_l AS (
    SELECT n.tenant_id, n.kind, n.value,
           CASE n.kind
             WHEN 'cliente' THEN (SELECT c.nombre FROM wincaja.clientes c
                                   WHERE c.tenant_id = n.tenant_id AND c.cliente = n.value
                                   ORDER BY c.source_dataset DESC LIMIT 1)
             ELSE (SELECT p.nombre FROM catalog.products p
                    WHERE p.tenant_id = n.tenant_id AND p.sku = n.value AND p.deleted_at IS NULL
                    ORDER BY p.sku LIMIT 1)
           END AS name
      FROM nom n)
  SELECT a.tenant_id, a.kind, a.value, a.month, COALESCE(nl.name, a.value) AS label,
         a.rev, a.last_date
    FROM agg a
    JOIN nom_l nl ON nl.tenant_id = a.tenant_id AND nl.kind = a.kind AND nl.value = a.value`;

const SQL_LIVE = `
  WITH lineas AS MATERIALIZED (${LINEAS_LIVE}),
  cli AS (
    SELECT l.tenant_id, l.cliente, l.suc, sum(l.importe) AS rev
      FROM lineas l WHERE ${CLIENTE_VALIDO}
     GROUP BY 1, 2, 3),
  kdud AS (
    SELECT DISTINCT ON (btrim(u.sucursal), btrim(u.c2))
           btrim(u.sucursal) AS suc, btrim(u.c2) AS cliente, NULLIF(btrim(u.c3), '') AS nombre
      FROM kepler_ods.kdud u
     WHERE btrim(u.c2) IN (SELECT cliente FROM cli WHERE suc IS NOT NULL)
     ORDER BY btrim(u.sucursal), btrim(u.c2)),
  cli_nom AS (
    SELECT c.tenant_id, c.cliente, c.rev,
           CASE WHEN c.suc IS NOT NULL THEN k.nombre
                ELSE (SELECT wc.nombre FROM wincaja.clientes wc
                       WHERE wc.tenant_id = c.tenant_id AND wc.cliente = c.cliente
                       ORDER BY wc.source_dataset DESC LIMIT 1) END AS nombre
      FROM cli c
      LEFT JOIN kdud k ON k.suc = c.suc AND k.cliente = c.cliente),
  sku AS (
    SELECT l.tenant_id, l.sku, sum(l.importe) AS rev, max(l.producto) AS producto
      FROM lineas l WHERE l.sku IS NOT NULL
     GROUP BY 1, 2)
  -- Un código que en dos sucursales es otra persona queda en UNA opción (el filtro va por código);
  -- el rótulo es el nombre con más venta.
  SELECT tenant_id, 'cliente'::text AS kind, cliente AS value,
         COALESCE((array_agg(nombre ORDER BY rev DESC) FILTER (WHERE nombre IS NOT NULL))[1], cliente) AS label,
         sum(rev) AS rev, now() AS computed_at
    FROM cli_nom
   GROUP BY tenant_id, cliente
  UNION ALL
  SELECT s.tenant_id, 'sku'::text, s.sku,
         COALESCE((SELECT p.nombre FROM catalog.products p
                    WHERE p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
                    ORDER BY p.sku LIMIT 1), s.producto, s.sku),
         s.rev, now()
    FROM sku s`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${WCJ} AS ${SQL_WCJ} WITH DATA`);
  // ⛔ Esta matvista no se vuelve a refrescar: si nace vacía, se queda vacía. `v_sales_lines`
  // devuelve 0 filas a un rol con RLS sin `app.tenant_id`, así que un poblado VACÍO con la fuente
  // llena (las estadísticas sí ven las filas) es el RLS comiéndose la historia: se aborta.
  const { rows: [chk] } = await knex.raw(
    `SELECT (SELECT count(*) FROM ${WCJ})::int AS filas,
            COALESCE((SELECT reltuples FROM pg_class
                       WHERE oid = to_regclass('wincaja.maestro_mov_almacen')), 0)::bigint AS fuente`);
  if (Number(chk.filas) === 0 && Number(chk.fuente) > 100000) {
    throw new Error(`${WCJ} quedó VACÍA con ${chk.fuente} filas en la fuente: aplicar con el rol dueño (sin RLS).`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_route_filter_options_wincaja
                    ON ${WCJ} (tenant_id, kind, value, month)`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${WCJ} IS
    '[VEC.39] Historia Wincaja de los combos de /comercial/ventas-por-ruta, por mes. SIN refresco a
     proposito: Wincaja dejo de vender por ruta el 2026-08-12. La ventana de 2 anios la aplica quien
     lee. Arbitro: test-newdb-route-filter-options.js (Wincaja sin venta de ruta despues de last_date).'`);

  await knex.raw(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${LIVE} AS ${SQL_LIVE} WITH DATA`);
  // UNIQUE obligatorio: el ciclo de 30 min la refresca CONCURRENTLY.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_route_filter_options_live
                    ON ${LIVE} (tenant_id, kind, value)`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${LIVE} IS
    '[VEC.39] Camionetas (push) + vecinal (ODS) de los combos de /comercial/ventas-por-ruta, 2 anios.
     Refresco: ciclo de 30 min de AnalyticsRefreshService; la frescura viaja en computed_at.'`);

  for (const mv of [WCJ, LIVE]) {
    await knex.raw(`GRANT SELECT ON ${mv} TO app_runtime`).catch(() => { /* rol ausente en dev */ });
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${LIVE}`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${WCJ}`);
};

// Para medir el cuerpo contra prod sin crear nada (scratch / candado).
exports._sql = { SQL_WCJ, SQL_LIVE };
