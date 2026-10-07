'use strict';
/**
 * `[VEC.4]` — **El importe del mes sale de la CABECERA, y lo que las líneas no explican se
 * DECLARA en vez de perderse.**
 *
 * Corrige a `[VEC.0]` (`20261006230000`), que derivaba el mes sumando líneas. Lo encontró su
 * propio candado el mismo día: **6 de 36 pares ruta×mes no cuadraban** contra `kdm1.c16`, y las
 * diferencias iban **en los dos sentidos** — señal de que eran dos causas, no una.
 *
 * ── Causa 1: documentos cuya cabecera está y cuyas líneas NO ────────────────────────────────
 *
 *     1V003 agosto-2026   401 documentos en kdm1   ·   383 con líneas en kdm2   ·  Δ $11,270.37
 *     3V001 agosto-2026   240 documentos           ·   234 con líneas          ·  Δ $14,745.76
 *
 * Las diferencias coinciden **al centavo** con el importe de los documentos sin líneas. Sumando
 * líneas, esa venta simplemente no existe: el ticket se cobró y el reporte no lo ve. ⛔ Y es un
 * hueco **de la fuente**, no del join — por eso no se arregla con SQL, se declara y se vigila.
 *
 * ── Causa 2: el descuento del documento ─────────────────────────────────────────────────────
 *
 * `kdm1.c13` es el descuento de la cabecera, y las líneas vienen **en bruto**. En las rutas de
 * Morelia la suma de líneas supera al total cobrado (2V003 septiembre: $352,054.09 de líneas
 * contra $350,393.18 de total, con $1,532.88 de descuento declarado). Publicar el bruto es
 * cobrarle al reporte un dinero que el cliente no pagó.
 *
 * ── La decisión ─────────────────────────────────────────────────────────────────────────────
 *
 *   **`revenue` = Σ `kdm1.c16`** — lo que el ticket dice que se cobró. Incluye los documentos
 *   sin líneas y ya viene neto de descuento. Es, además, la cifra con la que cualquiera puede
 *   contrastar: es el total impreso en el ticket.
 *
 *   **`units` sigue saliendo de las líneas**, porque no hay otra forma de contar piezas — y
 *   cuando hay documentos sin líneas esa cuenta está incompleta. No se estima ni se prorratea:
 *   se publican al lado `docs`, `docs_con_lineas` e `importe_sin_lineas` para que el consumidor
 *   sepa exactamente cuánta venta no tiene desglose.
 *
 * ⚠️ `revenue_lineas` se conserva como columna propia. No es redundante: es la **segunda
 * derivación** del mismo hecho, y es lo que permite que el candado compare dos caminos en vez de
 * comparar la vista consigo misma. La descomposición que debe cerrar es
 *
 *     revenue  ==  revenue_lineas  −  descuento  +  importe_sin_lineas   (± centavos)
 *
 * y cuando no cierre, el residuo se ve en vez de repartirse solo.
 *
 * ── Y de paso, la pantalla ──────────────────────────────────────────────────────────────────
 *
 * El rollup anterior obligaba a tocar `kdm2` (2.3 GB) para cualquier total. Separar la cabecera
 * en su propia vista deja que el importe del año se responda leyendo sólo `kdm1`.
 *
 * @param { import("knex").Knex } knex
 */

const T = `'00000000-0000-0000-0000-00000000d01c'::uuid`;

const DOCS = 'analytics.v_kepler_vecinal_sales_docs';
const LINEAS = 'analytics.v_kepler_vecinal_sales_lines';
const MENSUAL = 'analytics.v_kepler_vecinal_monthly';

/** Un documento de venta de ruta vecinal. Mismas reglas de universo que `[VEC.0]`. */
const DEF_DOCS = `
SELECT
  ${T}                                                    AS tenant_id,
  btrim(h.sucursal)                                       AS warehouse_code,
  btrim(h.c12)                                            AS route_no,
  'WIN-' || btrim(h.c12)                                  AS route_code,
  NULLIF(btrim(COALESCE(v.c3, '')), '')                   AS route_name,
  (h.c9)::date                                            AS business_date,
  btrim(h.c6)                                             AS folio,
  btrim((h.c5)::text)                                     AS caja,
  NULLIF(NULLIF(btrim(COALESCE(h.c10, '')), ''), '0001')  AS cliente,
  (h.c16)::numeric                                        AS total,
  COALESCE((h.c13)::numeric, 0)                           AS descuento,
  COALESCE((h.c14)::numeric, 0)                           AS impuesto
FROM kepler_ods.kdm1 h
LEFT JOIN kepler_ods.kduv v
  ON  btrim(v.sucursal) = btrim(h.sucursal)
  AND btrim(v.c2)       = btrim(h.c12)
WHERE h.c2 = 'U'
  AND h.c3 = 'D'
  AND (h.c4)::integer = 10
  AND btrim(COALESCE(h.c12, '')) ~ '^[0-9]V[0-9]'
  AND btrim(COALESCE(h.c1, '')) = btrim(h.sucursal)
  AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
  AND (h.c9)::date <= ((now() AT TIME ZONE 'America/Mexico_City'))::date`;

const DEF_MENSUAL = `
WITH d AS (
  SELECT tenant_id, warehouse_code, route_code, route_no,
         date_trunc('month', business_date)::date AS month,
         max(route_name)                          AS route_name,
         sum(total)                               AS revenue,
         sum(descuento)                           AS descuento,
         count(*)                                 AS docs,
         max(business_date)                       AS last_sale_date
    FROM ${DOCS}
   GROUP BY 1,2,3,4,5
), l AS (
  SELECT tenant_id, warehouse_code, route_code,
         date_trunc('month', business_date)::date AS month,
         sum(qty)                                 AS units,
         sum(importe)                             AS revenue_lineas,
         count(DISTINCT (caja, folio))            AS docs_con_lineas
    FROM ${LINEAS}
   GROUP BY 1,2,3,4
)
SELECT
  d.tenant_id, d.warehouse_code, d.route_code, d.route_no, d.route_name, d.month,
  d.revenue,
  COALESCE(l.units, 0)                                      AS units,
  d.docs                                                    AS tickets,
  d.descuento,
  COALESCE(l.revenue_lineas, 0)                             AS revenue_lineas,
  COALESCE(l.docs_con_lineas, 0)                            AS docs_con_lineas,
  d.docs - COALESCE(l.docs_con_lineas, 0)                   AS docs_sin_lineas,
  d.revenue - COALESCE(l.revenue_lineas, 0) + d.descuento   AS importe_sin_lineas,
  d.last_sale_date
FROM d
LEFT JOIN l
  ON  l.tenant_id      = d.tenant_id
  AND l.warehouse_code = d.warehouse_code
  AND l.route_code     = d.route_code
  AND l.month          = d.month`;

const C_DOCS =
  '[VEC.4] Un documento de venta de ruta vecinal (grano ticket), derivado del ODS. total = '
  + 'kdm1.c16 = lo que el ticket dice que se cobro, ya neto del descuento de cabecera (c13). Es '
  + 'la cifra contrastable: la que esta impresa en el ticket.';

const C_MENSUAL =
  '[VEC.4] Rollup mensual vecinal. revenue sale de la CABECERA (incluye los documentos cuyas '
  + 'lineas no llegaron al ODS y viene neto de descuento); units sale de las lineas y por eso '
  + 'esta INCOMPLETA cuando docs_sin_lineas > 0 — no se estima, se declara. La descomposicion '
  + 'revenue = revenue_lineas - descuento + importe_sin_lineas es lo que vigila el candado '
  + 'test-newdb-vecinal-truth.js, comparando dos derivaciones y no la vista consigo misma.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW ${DOCS} AS ${DEF_DOCS}`);
  await knex.raw(`ALTER VIEW ${DOCS} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${DOCS} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${DOCS} IS ${lit(C_DOCS)}`);

  // El mensual cambia de columnas, así que no basta un REPLACE.
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`CREATE VIEW ${MENSUAL} AS ${DEF_MENSUAL}`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${MENSUAL} IS ${lit(C_MENSUAL)}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`CREATE VIEW ${MENSUAL} AS
    SELECT l.tenant_id, l.warehouse_code, l.route_code, l.route_no,
           max(l.route_name) AS route_name,
           date_trunc('month', l.business_date)::date AS month,
           sum(l.qty) AS units, sum(l.importe) AS revenue,
           count(DISTINCT (l.caja, l.folio)) AS tickets,
           max(l.business_date) AS last_sale_date
      FROM ${LINEAS} l
     GROUP BY l.tenant_id, l.warehouse_code, l.route_code, l.route_no,
              date_trunc('month', l.business_date)::date`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`DROP VIEW IF EXISTS ${DOCS}`);
};
