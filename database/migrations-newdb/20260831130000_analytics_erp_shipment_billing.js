/**
 * Fase CXC — **lo embarcado contra lo facturado**. Vista en vivo, derive-no-copy.
 *
 * La cartera (`kdue`) dice qué se debe. No dice qué DEBERÍA deberse: si salió mercancía y
 * nadie emitió el cargo, la deuda simplemente no existe y nada la reclama. Esta vista cierra
 * ese eslabón comparando el embarque contra la factura que nació de él.
 *
 * DECODE verificado en prod (2026-08-31, `kdmm` es el catálogo — nunca adivinar el doctype):
 *   U-D-41 = **Embarque**. serie 01 'Embarque Telemarketing' · serie 02 'Embarque Sucursal'.
 *   Cadena: Pedido U-D-40 → Embarque U-D-41 → Factura U-D-8, encadenada por el documento
 *   padre `c37` (tipo) + `c39` (folio). El 100% de las UD08 (1,134 en jun–ago) nace de un
 *   embarque, así que la comparación es 1:1 salvo refacturación.
 *
 * TRES TRAMPAS que esta vista evita, todas verificadas con datos:
 *  1. **El descuento NO se resta.** Parecía que sí: la factura trae `c13`=descuento y uno
 *     supone que el embarque va a precio de lista. Es falso — medido en prod, el embarque ya
 *     viene con el descuento aplicado (JUAN PABLO FONSECA 29-ago: embarcado 163,766.70 vs
 *     facturado 163,764.63, con `c13`=4,689.71). Restarlo generaba 307 falsos positivos por
 *     ~$86k. Se deja `descuento` como columna informativa y `diferencia` = embarcado − facturado.
 *  2. **Un embarque, varias facturas** (79 casos, hasta 11 facturas): se agrega por embarque
 *     ANTES de comparar; si no, el total del embarque se cuenta una vez por factura.
 *  3. **El embarque que YA es el cargo**: en la sucursal 02 el embarque se carga directo a la
 *     cuenta del cliente (`kdue` c29='C' c4=41, 1,095 documentos). Ahí "sin factura" es lo
 *     normal, no una fuga → `cargo_en_kdue` lo marca y el detector lo salta.
 *
 * DEDUPE `btrim(c1)=btrim(sucursal)`: kdm1 arrastra la réplica de cada rama en las demás.
 * PROD-ONLY en cuanto a datos (kepler_ods), pero el DDL corre en cualquier lado.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const money = (col) => `round(coalesce(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,0),2)`;

const VIEW_SQL = `
CREATE OR REPLACE VIEW analytics.erp_shipment_billing AS
WITH emb AS (
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
),
fac AS (
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
),
-- El embarque que ya vive como CARGO en la cuenta corriente (suc 02): no le falta factura.
cargo AS (
  SELECT DISTINCT btrim(c1) AS sucursal, btrim(c6) AS folio
  FROM kepler_ods.kdue WHERE c29='C' AND btrim(c4::text)='41'
)
SELECT
  '${M}'::uuid AS tenant_id,
  e.sucursal, e.serie,
  CASE e.serie WHEN 1 THEN 'Embarque Telemarketing' WHEN 2 THEN 'Embarque Sucursal' ELSE 'Embarque' END AS serie_label,
  e.folio,
  e.sucursal||'UD41'||lpad(e.serie::text,2,'0')||'-'||e.folio AS folio_digital,
  e.fecha, e.cliente_code, e.cliente_nombre, e.estatus, e.pedido_folio,
  -- Cuenta interna = traspaso a sucursal disfrazado de venta; no es cobranza.
  (e.cliente_code LIKE 'TI%' OR COALESCE(e.cliente_nombre,'') ILIKE '%SUCURSAL%'
     OR COALESCE(e.cliente_nombre,'') ILIKE '%TRASPASO%') AS cuenta_interna,
  (c.folio IS NOT NULL) AS cargo_en_kdue,
  e.total_embarcado,
  COALESCE(f.n_facturas, 0) AS n_facturas,
  COALESCE(f.total_facturado, 0) AS total_facturado,
  COALESCE(f.descuento, 0) AS descuento,
  f.facturas,
  round(e.total_embarcado - COALESCE(f.total_facturado,0), 2) AS diferencia,
  CASE
    WHEN e.serie <> 1 THEN 'no_aplica'
    WHEN c.folio IS NOT NULL THEN 'cargo_directo'
    WHEN COALESCE(f.n_facturas,0) = 0 THEN 'sin_factura'
    WHEN f.total_facturado = 0 THEN 'facturado_en_cero'
    WHEN f.total_facturado > e.total_embarcado * 1.5 THEN 'facturado_de_mas'
    -- Tolerancia de $1: el redondeo por renglón hace que embarque y factura difieran centavos.
    WHEN abs(e.total_embarcado - f.total_facturado) > 1 THEN 'diferencia'
    ELSE 'ok'
  END AS diagnostico,
  now() AS computed_at
FROM emb e
LEFT JOIN fac f ON f.sucursal = e.sucursal AND f.origen = e.folio
LEFT JOIN cargo c ON c.sucursal = e.sucursal AND c.folio = e.folio
`;

exports.up = async function up(knex) {
  await knex.raw(VIEW_SQL);
  await knex.raw(`GRANT SELECT ON analytics.erp_shipment_billing TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.erp_shipment_billing`);
};
