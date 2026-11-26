'use strict';
/**
 * `[PQ.148]` — **Lo que la historia enseña del catálogo de cada proveedor**, derivado (`derive-no-copy`,
 * regla 1 / ADR-056): `commercial.v_supplier_item_code_history`. Una fila por (proveedor, SU código):
 * a qué SKU nuestro corresponde según las facturas que ya se aplicaron en Kepler, cuántas veces, y si
 * siempre cayó en el mismo producto. NO es una copia: se recalcula al leerla, de `fiscal.cfdis` (el
 * XML del SAT) y de las aplicaciones `X-A-20` del ODS.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md` §3.2 y §7 (`[PQ.148]`).
 *
 * ── El método (el mismo de la medición del anexo P §3.2) ──────────────────────────────────────
 *  1. Factura ↔ aplicación: mismo proveedor (RFC del CFDI → `kdxd.c10` → `kdm1.c10` por sucursal),
 *     total ±$1, fecha ±20 días, y **uno a uno en los dos sentidos** (una factura con dos aplicaciones
 *     candidatas, o una aplicación con dos facturas, no enseña nada).
 *  2. Dentro del par: renglón de la factura (`Importe − Descuento`) ↔ renglón de Kepler (`kdm2.c13`)
 *     ±0.5 %, otra vez uno a uno en los dos sentidos.
 *  3. Llave = `NoIdentificacion` normalizado como `normCodigo` (recortado, mayúsculas, espacios
 *     colapsados) con las guardas de `[PQ.148]`: 3+ caracteres (1–2 son número de renglón: «1» lo usan
 *     8 proveedores) y único dentro de su factura.
 *  4. `estable` = el código cayó siempre en el mismo SKU. Sólo esas proponen solas; las que cambian de
 *     producto van a revisión (anexo P §7).
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-24) ──
 *  · 60 días: 522 facturas se juntan 1 a 1 con su aplicación; 3,427 de 4,429 renglones con el suyo;
 *    1,198 equivalencias. Códigos vistos 2+ veces que caen siempre en el mismo SKU: 722 de 733
 *    (98.5 %) contra 27 de 733 (3.7 %) del placebo (renglón al azar del mismo documento).
 *  · `fiscal.cfdis.xml`: 2,059 de 2,302 XML de 60 días empiezan con BOM (U+FEFF) y Postgres no los
 *    toma como documento → se recorta antes de parsear. `xpath()` devuelve los atributos ESCAPADOS
 *    (`P&amp;G`) → se des-escapan. Los 2,302 son CFDI 4.0; el camino usa `local-name()` para no
 *    depender del espacio de nombres (3.3 o 4.0).
 *  · `emisor_rfc` viene limpio (0 de 143,759 con minúsculas o espacios): se usa tal cual para que el
 *    filtro por proveedor alcance el índice `(tenant_id, emisor_rfc, fecha)`.
 *  · CL005 se excluye (anexo P §3: emite el 98 % de los renglones, con unidad `ACT`, y no se parece al
 *    resto); se identifica por su clave de acreedor en `kdxd`, no por RFC escrito aquí.
 *  · `fiscal.cfdis` tiene RLS forzado por tenant → la vista es `security_invoker` (como las otras 4 de
 *    `commercial`): quien la lee ve sólo lo de su tenant. `app_runtime` ya lee las cuatro fuentes.
 *
 * Sin tablas, sin filas, sin índices. Idempotente (`CREATE OR REPLACE VIEW`).
 *
 * @param { import("knex").Knex } knex
 */

/** Texto → numérico sin reventar por basura (mismo criterio que las vistas `erp_*`). */
const NUM = (x) => `nullif(regexp_replace((${x})::text, '[^0-9.-]', '', 'g'), '')::numeric`;
/** Un atributo del concepto, des-escapado (`xpath()` devuelve `&amp;`, no `&`). */
const ATR = (a) => `replace(replace(replace(replace(replace((xpath('/*/@${a}', k.x))[1]::text,
      '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&amp;', '&')`;

/**
 * El cuerpo de la vista. `hasta` (fecha ISO) recorta lo que se aprende a lo anterior a ese día: la
 * medición antes/después aprende del pasado y prueba sobre los últimos 30 días, para no medirse contra
 * sí misma. La vista va SIN `hasta`. `renglones: true` devuelve cada emparejamiento (no la suma por
 * código): es lo que la medición compara contra lo que la historia propone.
 */
function cuerpo(hasta = null, { renglones = false } = {}) {
  if (hasta != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(hasta))) throw new Error(`hasta inválido: ${hasta}`);
  const corte = (col) => (hasta ? `AND ${col} < DATE '${hasta}'` : '');
  return `
WITH prov AS (
  SELECT DISTINCT d.sucursal, btrim(d.c2) AS prov, upper(btrim(d.c10)) AS rfc
    FROM kepler_ods.kdxd d
   WHERE btrim(coalesce(d.c10, '')) <> ''
),
aparte AS (SELECT DISTINCT rfc FROM prov WHERE prov = 'CL005'),
-- MATERIALIZED a propósito: son ~15 mil aplicaciones con su RFC y salen en una lectura. Sin esta
-- barrera Postgres empezaba por las facturas (estima 1 fila) y recorría todas las aplicaciones de la
-- sucursal por cada una: medido, 4.5 M comparaciones y 16 s para UN proveedor.
ap AS MATERIALIZED (
  SELECT m.sucursal, m.c1, m.c5, m.c6, p.rfc, m.c16 AS total, m.c9::date AS fecha,
         -- los límites ya calculados: con RLS, una condición con AT TIME ZONE (no leakproof) no entra
         -- al índice y cada búsqueda recorría ~1,300 facturas del proveedor (medido)
         ((m.c9::date - 21)::timestamp AT TIME ZONE 'America/Mexico_City') AS desde_ts,
         ((m.c9::date + 22)::timestamp AT TIME ZONE 'America/Mexico_City') AS hasta_ts
    FROM kepler_ods.kdm1 m
    JOIN prov p ON p.sucursal = m.sucursal AND p.prov = btrim(m.c10)
   WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 20
     AND btrim(m.c1) = m.sucursal
     AND btrim(coalesce(m.c43, '')) <> 'C'
     AND NOT EXISTS (SELECT 1 FROM aparte a WHERE a.rfc = p.rfc)
     ${corte('m.c9::date')}
),
cand AS (
  -- Desde cada aplicación, sus facturas por el índice (tenant_id, emisor_rfc, fecha): el rango va
  -- sobre la columna CRUDA, ±21/22 días (más ancho que la regla); la regla exacta, ±20 días en la
  -- fecha de México, se aplica después.
  SELECT c.tenant_id, c.id AS cfdi_id, ap.rfc, (c.fecha AT TIME ZONE 'America/Mexico_City')::date AS fecha,
         ap.sucursal, ap.c1, ap.c5, ap.c6
    FROM ap
    JOIN fiscal.cfdis c
      ON c.emisor_rfc = ap.rfc AND c.rol = 'recibidas' AND c.tipo_comprobante = 'I'
     AND c.fecha >= ap.desde_ts AND c.fecha < ap.hasta_ts
   WHERE c.xml IS NOT NULL
     AND coalesce(c.estatus_sat, '') NOT ILIKE 'cancel%'
     AND abs(ap.total - c.total) < 1
     AND abs(ap.fecha - (c.fecha AT TIME ZONE 'America/Mexico_City')::date) <= 20
     ${corte("(c.fecha AT TIME ZONE 'America/Mexico_City')::date")}
),
par AS (
  SELECT * FROM (
    SELECT cand.*,
           count(*) OVER (PARTITION BY rfc, cfdi_id) AS n_cfdi,
           count(*) OVER (PARTITION BY rfc, sucursal, c1, c5, c6) AS n_ap
      FROM cand) x
   WHERE n_cfdi = 1 AND n_ap = 1
),
con AS (
  SELECT par.tenant_id, par.rfc, par.cfdi_id, par.fecha, k.ord,
         upper(regexp_replace(btrim(${ATR('NoIdentificacion')}), '\\s+', ' ', 'g')) AS cod,
         ${NUM(ATR('Importe'))} - coalesce(${NUM(ATR('Descuento'))}, 0) AS imp,
         ${NUM(ATR('Cantidad'))} AS cantidad,
         upper(NULLIF(btrim(${ATR('ClaveUnidad')}), '')) AS unidad,
         NULLIF(btrim(${ATR('Descripcion')}), '') AS descripcion
    FROM par
    JOIN fiscal.cfdis c ON c.tenant_id = par.tenant_id AND c.id = par.cfdi_id
    CROSS JOIN LATERAL unnest(xpath(
      '/*[local-name()="Comprobante"]/*[local-name()="Conceptos"]/*[local-name()="Concepto"]',
      CASE WHEN xml_is_well_formed_document(ltrim(c.xml, chr(65279)))
           THEN ltrim(c.xml, chr(65279))::xml END)) WITH ORDINALITY AS k(x, ord)
),
con2 AS (
  SELECT con.*,
         CASE WHEN length(cod) >= 3 THEN cod END AS codigo,
         count(*) OVER (PARTITION BY rfc, cfdi_id, cod) AS rep_en_factura
    FROM con
),
lin AS (
  SELECT par.rfc, par.cfdi_id, l.c7 AS linea, btrim(l.c8) AS sku, NULLIF(btrim(l.c10), '') AS nombre,
         l.c9::numeric AS cantidad, l.c13 AS imp, upper(NULLIF(btrim(l.c11), '')) AS unidad
    FROM par
    JOIN kepler_ods.kdm2 l
      ON l.sucursal = par.sucursal AND l.c1 = par.c1 AND l.c2 = 'X' AND l.c3 = 'A'
     AND l.c4 = 20 AND l.c5 = par.c5 AND l.c6 = par.c6
   WHERE l.c13 > 0 AND btrim(coalesce(l.c8, '')) <> ''
),
mt AS (
  SELECT k.tenant_id, k.rfc, k.cfdi_id, k.fecha, k.ord, k.codigo, k.rep_en_factura, k.cantidad,
         k.unidad, k.descripcion, l.linea, l.sku, l.nombre, l.cantidad AS cantidad_kepler, l.unidad AS unidad_kepler
    FROM con2 k
    JOIN lin l ON l.rfc = k.rfc AND l.cfdi_id = k.cfdi_id
   WHERE k.imp > 0 AND abs(k.imp / l.imp - 1) < 0.005
),
uno AS (
  SELECT * FROM (
    SELECT mt.*,
           count(*) OVER (PARTITION BY rfc, cfdi_id, ord) AS n_renglon,
           count(*) OVER (PARTITION BY rfc, cfdi_id, linea) AS n_linea
      FROM mt) x
   WHERE n_renglon = 1 AND n_linea = 1 AND codigo IS NOT NULL AND rep_en_factura = 1
)
${renglones ? 'SELECT * FROM uno' : AGREGADO}`;
}

const AGREGADO = `SELECT
  tenant_id,
  rfc                                                                    AS proveedor_rfc,
  codigo                                                                 AS codigo_proveedor,
  (array_agg(sku ORDER BY fecha DESC, cfdi_id))[1]                       AS sku,
  (array_agg(nombre ORDER BY fecha DESC, cfdi_id))[1]                    AS nombre_kepler,
  (array_agg(descripcion ORDER BY fecha DESC, cfdi_id))[1]               AS descripcion_proveedor,
  count(DISTINCT cfdi_id)::int                                           AS facturas,
  count(DISTINCT sku)::int                                               AS skus_distintos,
  (count(DISTINCT sku) = 1)                                              AS estable,
  mode() WITHIN GROUP (ORDER BY round(cantidad_kepler / NULLIF(cantidad, 0), 4)) AS factor_kepler,
  count(DISTINCT round(cantidad_kepler / NULLIF(cantidad, 0), 4))::int    AS factores_distintos,
  mode() WITHIN GROUP (ORDER BY unidad)                                  AS unidad_proveedor,
  mode() WITHIN GROUP (ORDER BY unidad_kepler)                           AS unidad_kepler,
  min(fecha)                                                             AS primera_vez,
  max(fecha)                                                             AS ultima_vez
FROM uno
GROUP BY tenant_id, rfc, codigo`;

const SELECT_SQL = cuerpo();
exports.cuerpo = cuerpo;
exports.SELECT_SQL = SELECT_SQL;

const VISTA = 'commercial.v_supplier_item_code_history';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PQ.148] Equivalencias (proveedor, SU codigo NoIdentificacion) -> SKU aprendidas de la historia: factura del SAT <-> aplicacion X-A-20 1 a 1 (RFC, total +-1, +-20 d), renglon <-> renglon por importe +-0.5 % 1 a 1. derive-no-copy sobre fiscal.cfdis y kdm1/kdm2/kdxd; sin CL005. estable = siempre el mismo SKU (solo esas proponen solas). factor_kepler = cantidad de Kepler por unidad facturada (informativo).'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  console.log(`  ✓ [PQ.148] ${VISTA} creada (security_invoker; se lee por proveedor)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada depende de ella todavía. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
