'use strict';
/**
 * `[PQ.150]` segundo tramo — **La historia de `[PQ.148]` aprende de la liga factura ↔ aplicación de PQ.150**,
 * sólo de los pares con el total igual. `commercial.v_supplier_item_code_history` deja de emparejar la factura
 * con su aplicación por su cuenta (RFC de Kepler + total ±$1 + ±20 días, uno a uno) y lee los pares de
 * `analytics.mv_supplier_invoice_application` con `abs(diferencia) < 1`. El resto de la vista —el XML, el
 * renglón ↔ renglón por importe ±0.5 % uno a uno, las guardas del código— es el de PQ.148, sin cambio.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_PROVEEDOR_AVISO_DE_ENTREGA.md` §3.10 y §7 (`[PQ.150]`).
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────────
 *  · La regla de PQ.148 necesita el RFC del acreedor en Kepler (`kdxd.c10`), y falta en 6 de cada 10
 *    aplicaciones. La liga de PQ.150 casa también por el folio del proveedor en la referencia, sin RFC.
 *  · ⛔ SÓLO total igual: la liga por folio acepta una factura entre la mitad y el doble de su aplicación
 *    (las entregas parciales, el caso de PQ.157), y ahí los renglones no se corresponden uno a uno.
 *    Medido en la simulación (2026-11-25): aprender de TODAS las ligas bajaba la cobertura del universo de
 *    PQ.148 de 60.0 % a 49.3 %; sólo con total igual sube a 60.8 %.
 *  · La matvista y no la vista: la liga entera cuesta ~8 s y decide el uno a uno contra todos los
 *    candidatos, así que filtrarla por proveedor no es más barato (PQ.150). La historia se lee por
 *    proveedor en cada conciliación de Recepción. Una liga de la última hora todavía no enseña: es historia.
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-27) ──
 *  Con ESTE texto de SQL contra el de PQ.148, el mismo método de PQ.148 (aprende de lo anterior a hace 30
 *  días —la liga recortada a esa fecha— y prueba sobre los 30 siguientes; placebo = el renglón vecino):
 *  · Equivalencias: **1,547 (1,449 estables) de 61 proveedores → 2,539 (2,373) de 133**.
 *  · Acierto con datos que no vio: 1,173 de 1,176 (99.7 %) → **1,644 de 1,649 (99.7 %)**; placebo 0 de
 *    1,140 → 0 de 1,592. Las mismas columnas y tipos que la vista viva (comprobado en prod).
 *  · Lo que paga cada conciliación (filtrar por un proveedor): 525–1,030 ms → **137–398 ms**. La vista
 *    entera (esta compuerta): 5.7–8.9 s.
 *  · Renglones de factura de 30 días (sin CL005) con propuesta: con RFC en Kepler 59.5 % → 60.2 %; con
 *    TODOS los ligados (+ los acreedores sin RFC en Kepler) **39.4 % → 57.1 %**, que Recepción sólo alcanza
 *    si busca con el RFC de la factura (el otro cambio de este tramo, en `goods-receipt-proofs.service.ts`).
 *
 * ⚠️ Aplicar ANTES de soltar. Sin re-login; no toca permisos (`app_runtime` ya lee la matvista y la vista).
 *
 * Idempotente (`CREATE OR REPLACE VIEW`, mismas columnas y tipos). El `down` restaura la de PQ.148.
 *
 * @param { import("knex").Knex } knex
 */

/** Texto → numérico sin reventar por basura (mismo criterio que las vistas `erp_*`). */
const NUM = (x) => `nullif(regexp_replace((${x})::text, '[^0-9.-]', '', 'g'), '')::numeric`;
/** Un atributo del concepto, des-escapado (`xpath()` devuelve `&amp;`, no `&`). */
const ATR = (a) => `replace(replace(replace(replace(replace((xpath('/*/@${a}', k.x))[1]::text,
      '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&amp;', '&')`;

/** La liga de PQ.150, materializada (la refresca `AnalyticsRefreshService` cada hora). */
const MV = 'analytics.mv_supplier_invoice_application';
const VISTA = 'commercial.v_supplier_item_code_history';

/**
 * El cuerpo de la vista.
 *  · `hasta` (fecha ISO) recorta lo que se aprende a lo anterior a ese día (la medición aprende del pasado y
 *    prueba sobre los últimos 30 días). La vista va SIN `hasta`.
 *  · `renglones: true` devuelve cada emparejamiento, no la suma por código.
 *  · `pares`: de dónde salen los pares factura ↔ aplicación (columnas de la vista de PQ.150). La vista lee la
 *    matvista; la medición le pasa `(cuerpo de PQ.150 con antesDe)`, que decide el uno a uno sólo con el
 *    pasado. La prueba le pasa la vista de PQ.150 armada sobre `VALUES`.
 */
function cuerpo(hasta = null, { renglones = false, pares = MV } = {}) {
  if (hasta != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(hasta))) throw new Error(`hasta inválido: ${hasta}`);
  const corte = hasta ? `AND v.fecha_cfdi < DATE '${hasta}' AND v.fecha_aplicacion < DATE '${hasta}'` : '';
  return `
WITH par AS (
  -- Uno a uno en los dos sentidos ya lo garantiza la liga (sus UNIQUE). Aquí sólo el total igual.
  SELECT v.tenant_id, v.cfdi_id, v.proveedor_rfc::text AS rfc, v.fecha_cfdi AS fecha,
         v.sucursal, v.almacen AS c1, v.subtipo AS c5, v.folio AS c6
    FROM ${pares} v
   WHERE abs(v.diferencia) < 1
     ${corte}
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

/** La salida de PQ.148, columna por columna (CREATE OR REPLACE exige los mismos nombres, orden y tipos). */
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

/** Piso de la compuerta, con el ODS de prod: la simulación dio 2,514 equivalencias; PQ.148 sola, 1,494. */
const PISO = 1800;
/** Con menos aplicaciones `X-A-20` en el ODS es una base de pruebas: el piso no se puede exigir (se declara). */
const APLICACIONES_DE_PROD = 5000;

exports.cuerpo = cuerpo;
exports.SELECT_SQL = cuerpo();
exports.MV = MV;
exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${exports.SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PQ.148] Equivalencias (proveedor, SU codigo NoIdentificacion) -> SKU aprendidas de la historia. [PQ.150] Los pares factura <-> aplicacion X-A-20 salen de analytics.mv_supplier_invoice_application (RFC + folio, folio + total, RFC + total; uno a uno), SOLO con el total igual (abs(diferencia) < 1); renglon <-> renglon por importe +-0.5 % 1 a 1. proveedor_rfc = el RFC de la FACTURA (emisor del CFDI), no el de Kepler. estable = siempre el mismo SKU (solo esas proponen solas). factor_kepler = cantidad de Kepler por unidad facturada (informativo).'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  // Compuerta: con el ODS de prod la historia NO puede quedar más pobre que la de PQ.148. Si la matvista
  // estuviera vacía (el refresco en un rol sin BYPASSRLS, GOTCHAS §87.1), la vista se vería «bien» con cero.
  const [{ aps }] = (await knex.raw(`SELECT count(*)::int AS aps FROM kepler_ods.kdm1 WHERE c2 = 'X' AND c3 = 'A' AND c4 = 20`)).rows;
  if (aps >= APLICACIONES_DE_PROD) {
    await knex.raw(`SET LOCAL statement_timeout = '120s'`);
    const [{ n, estables }] = (await knex.raw(`SELECT count(*)::int AS n, count(*) FILTER (WHERE estable)::int AS estables FROM ${VISTA}`)).rows;
    if (!(n >= PISO)) {
      throw new Error(`[PQ.150] ${VISTA} quedó con ${n} equivalencias (se esperaban ~2,500; PQ.148 sola daba 1,494). ` +
        `¿${MV} está vacía o sin refrescar?`);
    }
    console.log(`  ✓ [PQ.150] ${VISTA} aprende de la liga (total igual): ${n} equivalencias, ${estables} estables`);
  } else {
    console.log(`  · [PQ.150] NO MEDIDO: ${aps} aplicaciones en el ODS de esta base; el piso de ${PISO} equivalencias se exige con las de prod`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista vuelve a la definición de PQ.148, con su comentario. */
exports.down = async function down(knex) {
  const pq148 = require('./20261124231441_pq148_v_supplier_item_code_history.js');
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${pq148.SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[PQ.148] Equivalencias (proveedor, SU codigo NoIdentificacion) -> SKU aprendidas de la historia: factura del SAT <-> aplicacion X-A-20 1 a 1 (RFC, total +-1, +-20 d), renglon <-> renglon por importe +-0.5 % 1 a 1. derive-no-copy sobre fiscal.cfdis y kdm1/kdm2/kdxd; sin CL005. estable = siempre el mismo SKU (solo esas proponen solas). factor_kepler = cantidad de Kepler por unidad facturada (informativo).'`);
};
