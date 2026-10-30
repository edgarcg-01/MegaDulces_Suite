'use strict';
/**
 * `[AX.18]` — `analytics.erp_shipment_billing` deja de tardar más de 60 s. Mismo negocio, mismas
 * columnas, mismo orden y tipos (por eso `CREATE OR REPLACE`): sólo cambia CÓMO se cruza el
 * embarque con sus facturas y su cargo. El WHERE y el diagnóstico son los de `20260831130000`.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-29) ────────────────────────────────────────
 *  · `SELECT … WHERE serie=1 AND fecha >= hoy-90 AND diagnostico IN ('sin_factura',
 *    'facturado_en_cero')` → **cancelada a los 60 s** (y a los 90 s).
 *  · Cada pieza sola, completa: embarques `U-D-41` 9,504 filas en 52 ms · facturas `U-D-8` con
 *    padre 41 (agrupadas) 5,539 en 35 ms · cargos de `kdue` 1,095 en 4 ms.
 *  · El EXPLAIN dice por qué: estima **15 filas** de embarques y **1** de facturas (el filtro de
 *    dedupe `btrim(c1)=btrim(sucursal)` compara dos expresiones y recibe la selectividad por
 *    defecto: ninguna estadística lo corrige), elige `Nested Loop Left Join` y compara 9.5k × 5.5k.
 *  · ⛔ `MATERIALIZED` solo NO alcanza — medido: cada CTE se calcula una vez, pero el cruce sigue
 *    siendo nested loop sobre los CTE y también pasa de 90 s.
 *
 * ── El arreglo ──────────────────────────────────────────────────────────────────────────────
 * Las tres piezas van a UNA lista (`UNION ALL`, cada fila con su origen `src`) y una ventana por
 * `(sucursal, folio)` le reparte a cada embarque lo de su factura y su cargo. Ordenar ~16k filas
 * no depende de ninguna estimación. Es el mismo LEFT JOIN: `fac` tiene a lo sumo una fila por
 * `(sucursal, origen)` (es un GROUP BY) y `cargo` una por `(sucursal, folio)` (DISTINCT), así que
 * cada embarque recibe exactamente lo que el join le daba — y, como el join, sin mirar la serie.
 * Las facturas sin padre (`origen` NULL) se dejan fuera de la lista: en el join tampoco casaban.
 *
 * ⭐ Quién lo sufría sin saberlo: el detector `cxc_embarcado_sin_facturar`
 *    (`customer-receivables-scanner.service.ts`) lee esta vista y, ante un error, registra un warn
 *    y devuelve `[]` — una consulta que no termina se ve igual que «sin hallazgos».
 *
 * Idempotente (`CREATE OR REPLACE VIEW`). Sin escritura de datos.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;

// ── Las tres piezas: idénticas a 20260831130000 ──────────────────────────────────────────────
const EMB = `
  SELECT DISTINCT ON (btrim(h.c1), (h.c5)::int, btrim(h.c6::text))
    btrim(h.c1) AS sucursal,
    (h.c5)::int AS serie,
    btrim(h.c6::text) AS folio,
    h.c9::date AS fecha,
    NULLIF(btrim(h.c10::text),'') AS cliente_code,
    NULLIF(btrim(h.c32::text),'') AS cliente_nombre,
    NULLIF(btrim(h.c11::text),'') AS estatus,
    NULLIF(btrim(h.c39::text),'') AS pedido_folio,
    ${money('h.c16')} AS total_embarcado
  FROM kepler_ods.kdm1 h
  WHERE h.c2='U' AND h.c3='D' AND (h.c4)::int=41 AND btrim(h.c1)=btrim(h.sucursal)
  ORDER BY btrim(h.c1), (h.c5)::int, btrim(h.c6::text), h.c9
`;
const FAC = `
  SELECT btrim(f.c1) AS sucursal, btrim(f.c39::text) AS origen,
         count(*)::int AS n_facturas,
         sum(${money('f.c16')}) AS total_facturado,
         sum(${money('f.c13')}) AS descuento,
         jsonb_agg(jsonb_build_object(
           'folio', btrim(f.c6::text), 'fecha', f.c9::date::text, 'total', ${money('f.c16')}
         ) ORDER BY btrim(f.c6::text)) AS facturas
  FROM (
    SELECT DISTINCT ON (btrim(c1), (c5)::int, btrim(c6::text)) c1,c5,c6,c9,c13,c16,c39
    FROM kepler_ods.kdm1
    WHERE c2='U' AND c3='D' AND (c4)::int=8 AND (c37)::int=41 AND btrim(c1)=btrim(sucursal)
    ORDER BY btrim(c1), (c5)::int, btrim(c6::text), c9
  ) f
  GROUP BY 1,2
`;
const CARGO = `
  SELECT DISTINCT btrim(c1) AS sucursal, btrim(c6) AS folio
  FROM kepler_ods.kdue WHERE c29='C' AND btrim(c4::text)='41'
`;

/** La salida, sobre un alias que trae las columnas del embarque y las de su factura/cargo. */
const salida = (x) => `
SELECT
  '${M}'::uuid AS tenant_id,
  ${x.e}.sucursal, ${x.e}.serie,
  CASE ${x.e}.serie WHEN 1 THEN 'Embarque Telemarketing' WHEN 2 THEN 'Embarque Sucursal' ELSE 'Embarque' END AS serie_label,
  ${x.e}.folio,
  ${x.e}.sucursal||'UD41'||lpad(${x.e}.serie::text,2,'0')||'-'||${x.e}.folio AS folio_digital,
  ${x.e}.fecha, ${x.e}.cliente_code, ${x.e}.cliente_nombre, ${x.e}.estatus, ${x.e}.pedido_folio,
  -- Cuenta interna = traspaso a sucursal disfrazado de venta; no es cobranza.
  (${x.e}.cliente_code LIKE 'TI%' OR COALESCE(${x.e}.cliente_nombre,'') ILIKE '%SUCURSAL%'
     OR COALESCE(${x.e}.cliente_nombre,'') ILIKE '%TRASPASO%') AS cuenta_interna,
  ${x.cargoCol} AS cargo_en_kdue,
  ${x.e}.total_embarcado,
  COALESCE(${x.n}, 0) AS n_facturas,
  COALESCE(${x.total}, 0) AS total_facturado,
  COALESCE(${x.desc}, 0) AS descuento,
  ${x.facturasCol},
  round(${x.e}.total_embarcado - COALESCE(${x.total},0), 2) AS diferencia,
  CASE
    WHEN ${x.e}.serie <> 1 THEN 'no_aplica'
    WHEN ${x.cargoCond} THEN 'cargo_directo'
    WHEN COALESCE(${x.n},0) = 0 THEN 'sin_factura'
    WHEN ${x.total} = 0 THEN 'facturado_en_cero'
    WHEN ${x.total} > ${x.e}.total_embarcado * 1.5 THEN 'facturado_de_mas'
    -- Tolerancia de $1: el redondeo por renglón hace que embarque y factura difieran centavos.
    WHEN abs(${x.e}.total_embarcado - ${x.total}) > 1 THEN 'diferencia'
    ELSE 'ok'
  END AS diagnostico,
  now() AS computed_at`;

/** `20260831130000` tal cual: LEFT JOIN (el `down` vuelve exactamente a esto). */
const VIEW_ORIGINAL = `
CREATE OR REPLACE VIEW analytics.erp_shipment_billing AS
WITH emb AS (${EMB}),
fac AS (${FAC}),
-- El embarque que ya vive como CARGO en la cuenta corriente (suc 02): no le falta factura.
cargo AS (${CARGO})
${salida({ e: 'e', n: 'f.n_facturas', total: 'f.total_facturado', desc: 'f.descuento', facturasCol: 'f.facturas', cargoCol: '(c.folio IS NOT NULL)', cargoCond: 'c.folio IS NOT NULL' })}
FROM emb e
LEFT JOIN fac f ON f.sucursal = e.sucursal AND f.origen = e.folio
LEFT JOIN cargo c ON c.sucursal = e.sucursal AND c.folio = e.folio
`;

/** `[AX.18]` Mismo resultado, sin join: una lista y una ventana por (sucursal, folio). */
const VIEW_VENTANA = `
CREATE OR REPLACE VIEW analytics.erp_shipment_billing AS
WITH emb AS MATERIALIZED (${EMB}),
fac AS MATERIALIZED (${FAC}),
-- El embarque que ya vive como CARGO en la cuenta corriente (suc 02): no le falta factura.
cargo AS MATERIALIZED (${CARGO}),
u AS (
  SELECT e.sucursal, e.folio, 0 AS src, e.serie, e.fecha, e.cliente_code, e.cliente_nombre,
         e.estatus, e.pedido_folio, e.total_embarcado,
         NULL::int AS n_facturas, NULL::numeric AS total_facturado, NULL::numeric AS descuento,
         NULL::jsonb AS facturas
    FROM emb e
  UNION ALL
  SELECT f.sucursal, f.origen, 1, NULL::int, NULL::date, NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::numeric, f.n_facturas, f.total_facturado, f.descuento, f.facturas
    FROM fac f WHERE f.origen IS NOT NULL
  UNION ALL
  SELECT c.sucursal, c.folio, 2, NULL::int, NULL::date, NULL::text, NULL::text, NULL::text, NULL::text,
         NULL::numeric, NULL::int, NULL::numeric, NULL::numeric, NULL::jsonb
    FROM cargo c WHERE c.folio IS NOT NULL
),
j AS (
  SELECT u.*,
         max(u.n_facturas) OVER k AS f_n,
         max(u.total_facturado) OVER k AS f_total,
         max(u.descuento) OVER k AS f_desc,
         (array_agg(u.facturas) FILTER (WHERE u.src = 1) OVER k)[1] AS f_facturas,
         bool_or(u.src = 2) OVER k AS f_cargo
    FROM u
  WINDOW k AS (PARTITION BY u.sucursal, u.folio)
)
${salida({ e: 'j', n: 'j.f_n', total: 'j.f_total', desc: 'j.f_desc', facturasCol: 'j.f_facturas AS facturas', cargoCol: 'j.f_cargo', cargoCond: 'j.f_cargo' })}
FROM j
WHERE j.src = 0
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VIEW_VENTANA);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_billing TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista de `20260831130000`, con su LEFT JOIN. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VIEW_ORIGINAL);
};
