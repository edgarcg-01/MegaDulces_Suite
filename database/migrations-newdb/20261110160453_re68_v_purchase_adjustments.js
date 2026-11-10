'use strict';
/**
 * `[RE.68]` — `analytics.v_purchase_adjustments`: las notas de crédito (X-D-55) y devoluciones de compra
 * (X-D-40) de Kepler, leídas del ODS (derive-no-copy), de TODAS las sucursales. Reemplaza al importer
 * `import-purchase-adjustments.js` y a su tabla `analytics.erp_purchase_adjustments` (Edgar, 2026-11-10:
 * «retiremos el importer y el cron. todo del ods»). La tabla vieja NO se toca: queda congelada.
 *
 * POR QUÉ: el importer copiaba sólo el CEDIS (`sucursal = '00'` fijo). Tras el corte del 1-oct cada
 * sucursal recibe sus propias notas y el importer no las veía; además contaba las CANCELADAS (166) e
 * inventaba «descuento_comercial» en las notas sin motivo (`categoria_source = 'doctype_default'`).
 *
 * Una fila por documento, con las columnas de la tabla vieja (mismo nombre y sentido) + `grupo`:
 *   · categoria: el clasificador del motivo de RE.64 (traducción exacta de `categorize()` del importer,
 *     sobre el motivo con los espacios colapsados como él). NULL = sin motivo; nunca se inventa.
 *   · grupo: comercial | operativo | sin_clasificar | traslado. `traslado` (RE.66) = la nota de sucursal
 *     que cubre ≥95 % de una entrada A·20 cuya compra se pagó por la copia del CEDIS (o dice «blanqueo»):
 *     no es rebaja, es el pago que se fue a otro lado. Quien sume dinero la excluye.
 *   · entrada_folio: `c39` si viene; si no, la entrada A·20 a la que `kdxf` la aplicó (cuando es una sola).
 *     entrada_c39: sólo la liga ESCRITA en el documento (lo que el importer llamaba entrada_folio); la usa
 *     la aprobación en lote, que no debe ampliarse por cambiar de fuente (decisión D2 de RE.65).
 *   · kepler_c1/c4/c5/c6/c10: las llaves crudas para cruzar con `kdxf` (las usa el primitivo de RE.64).
 *   · proveedor_interno: el «proveedor» es otra sucursal o el CEDIS (códigos `TI000`–`TI009` de Kepler, los 10
 *     llamados «SUCURSAL …» / «CENTRO DE DISTRIBUCIÓN»; `kdxd` no trae una marca: `c12` es el grupo contable).
 *     Sus notas son traspasos entre sucursales —desde el corte, cierres de $2–18 M—, no ajustes de un
 *     proveedor: quien analiza descuentos o margen las excluye.
 *   · Sin canceladas (`c43 = 'C'`) y sin las réplicas de otras ramas (`btrim(c1) = sucursal`).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-10) ────────────────────────────────────────
 *  · 2,098 documentos. Contra el primitivo en prod (`NOTAS_KEPLER_DOC_SQL`): 0 diferencias en categoría,
 *    grupo, monto, proveedor y fecha.
 *  · Contra el importer (CEDIS): 1,540 en ambos con 0 diferencias en monto, IVA, nombre, RFC, factura,
 *    fecha, motivo y categoría por palabra clave; las 166 que sólo tiene el importer son canceladas;
 *    entrada ligada nueva en 1,223 (el importer sólo tenía `c39`).
 *  · ~200 ms por consulta (agregado, por folio, por entrada). Con LATERAL fila por fila eran 12–29 s:
 *    las CTE van MATERIALIZED porque el planificador estima 1 fila donde hay miles.
 *
 * ⛔ Sin «?» en el texto: `knex.raw` lo toma por parámetro (GOTCHAS §71). Los opcionales van `{0,1}`.
 * `String.raw` conserva las «\» de los regex. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = String.raw`
WITH doc AS MATERIALIZED (
  SELECT m.sucursal, m.c1, m.c4, m.c5, m.c6, m.c10, btrim(m.c6) AS folio, m.c9::date AS fecha,
         m.c16 AS total,
         CASE WHEN btrim(m.c82) ~ '^-{0,1}[0-9]+(\.[0-9]+){0,1}$' THEN btrim(m.c82)::numeric END AS iva,
         NULLIF(btrim(m.c39), '') AS c39, NULLIF(btrim(m.c10), '') AS proveedor_code,
         NULLIF(btrim(m.c32), '') AS proveedor_nombre, NULLIF(btrim(m.c22), '') AS proveedor_rfc,
         NULLIF(btrim(m.c11), '') AS factura_ref,
         NULLIF(btrim(regexp_replace(COALESCE(m.c24, ''), '\s+', ' ', 'g')), '') AS motivo
    FROM kepler_ods.kdm1 m
   WHERE m.c2 = 'X' AND m.c3 = 'D' AND m.c4 IN (55, 40) AND btrim(m.c1) = m.sucursal AND m.c43 IS DISTINCT FROM 'C'
), apl AS MATERIALIZED (
  SELECT d.sucursal, d.c4, d.folio, btrim(x.c9) AS entrada, sum(x.c10)::numeric AS aplicado
    FROM doc d
    JOIN kepler_ods.kdxf x
      ON x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.c4 AND x.c5 = d.c5 AND x.c6 = d.c6
   WHERE x.c7 = '20' AND btrim(x.c1) = x.sucursal
   GROUP BY 1, 2, 3, 4
), u AS (
  SELECT sucursal, c4, folio, entrada, aplicado FROM apl
  UNION ALL
  SELECT d.sucursal, d.c4, d.folio, d.c39, d.total FROM doc d
   WHERE d.c39 IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdxf x
                      WHERE x.sucursal = d.sucursal AND x.c1 = d.c1 AND x.c2 = d.c10 AND x.c4 = d.c4 AND x.c5 = d.c5 AND x.c6 = d.c6)
), ent AS MATERIALIZED (
  SELECT k.sucursal, btrim(k.c6) AS folio, max(k.c11)::numeric AS importe FROM kepler_ods.kdxe k
   WHERE btrim(k.c1) = k.sucursal AND k.c3 = 'A' AND k.c4 = '20' GROUP BY 1, 2
), copia AS MATERIALIZED (
  SELECT DISTINCT dup_of_sucursal, dup_of_folio FROM analytics.erp_goods_receipt_dedup
   WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c' AND status IN ('auto', 'confirmado')
), liga AS MATERIALIZED (
  SELECT u.sucursal, u.c4, u.folio,
         CASE WHEN count(*) = 1 THEN min(u.entrada) END AS unica,
         bool_or(u.sucursal <> '00' AND e.importe > 0 AND u.aplicado >= 0.95 * e.importe
                 AND (upper(COALESCE(d.motivo, '')) ~ 'BLANQ' OR c.dup_of_folio IS NOT NULL)) AS traslado
    FROM u
    JOIN doc d ON d.sucursal = u.sucursal AND d.c4 = u.c4 AND d.folio = u.folio
    LEFT JOIN ent e ON e.sucursal = u.sucursal AND e.folio = u.entrada
    LEFT JOIN copia c ON c.dup_of_sucursal = u.sucursal AND c.dup_of_folio = u.entrada
   GROUP BY 1, 2, 3
), cat AS (
  SELECT d.*, CASE
  WHEN btrim(coalesce(d.motivo, '')) = '' THEN NULL
  WHEN upper(d.motivo) ~ 'NO SE SOLICIT|NO SOLICIT' THEN 'no_solicitado'
  WHEN upper(d.motivo) ~ 'MAL ESTADO|DA[ÑN]AD|CADUC|ROTO|PONCH|PES[OÓ] DE MENOS|MALTRAT' THEN 'mal_estado'
  WHEN upper(d.motivo) ~ 'FALT' THEN 'faltante'
  WHEN upper(d.motivo) ~ 'CAMBIAD|EQUIVOC|LLEGO CAMB|NO TRA[IÍ]A' THEN 'cambiada'
  WHEN upper(d.motivo) ~ 'DUPLICAD|FACTURAS DOBLES|COMPRAS DOBLES|DOBLE FACTUR' THEN 'factura_duplicada'
  WHEN upper(d.motivo) ~ 'DIFERENCIA (EN|DE) (MONTO|PRECIO)|DIF\.{0,1} (MONTO|PRECIO)|MAL APLICAD' THEN 'diferencia_monto'
  WHEN upper(d.motivo) ~ 'PRONTO PAGO|\yPP\y|%\s{0,1}PP|PP\s{0,1}\d' THEN 'pronto_pago'
  WHEN upper(d.motivo) ~ 'APOYO|MKT|MARKETING|MERCADOTECNIA' THEN 'apoyo_marca'
  WHEN upper(d.motivo) ~ 'RAPPEL|INCENTIVO|PROMOCION|\yPROMO\y|NEGOCIAD' THEN 'descuento_comercial'
  WHEN upper(d.motivo) ~ 'DESCUENTO|DESCEUNTO|DESCUETO|DESCUNTO|DESCTO|\yDESC\y|\yDTO\y|PLAN|PAQUETE|GRANEL|BONIF|\d\s{0,1}%' THEN 'descuento_comercial'
  WHEN upper(d.motivo) ~ 'SALDO A FAVOR' THEN 'saldo_favor'
  WHEN upper(d.motivo) ~ 'DEVOL|REGRES' THEN 'devolucion_otra'
  ELSE 'otro' END AS categoria FROM doc d
)
SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
       'XD' || c.c4::int::text AS doctype,
       c.sucursal, c.folio,
       c.fecha AS adjustment_date,
       c.proveedor_code, c.proveedor_nombre, c.proveedor_rfc, c.factura_ref,
       COALESCE(c.c39, l.unica) AS entrada_folio,
       COALESCE(c.total, 0) AS monto,
       COALESCE(c.iva, 0) AS iva,
       c.motivo, c.categoria,
       CASE WHEN c.categoria IS NOT NULL AND c.categoria <> 'otro' THEN 'keyword' END AS categoria_source,
       'md_' || c.sucursal AS source_branch,
       CASE WHEN COALESCE(l.traslado, false) THEN 'traslado'
            WHEN c.categoria IN ('descuento_comercial', 'pronto_pago', 'apoyo_marca') THEN 'comercial'
            WHEN c.categoria IN ('no_solicitado', 'mal_estado', 'faltante', 'cambiada', 'devolucion_otra') OR c.c4 = 40 THEN 'operativo'
            ELSE 'sin_clasificar' END AS grupo,
       c.c4::int::text AS tipo, c.c1 AS kepler_c1, c.c4 AS kepler_c4, c.c5 AS kepler_c5, c.c6 AS kepler_c6, c.c10 AS kepler_c10,
       c.c39 AS entrada_c39,
       COALESCE(c.proveedor_code ~ '^TI[0-9]{3}$', false) AS proveedor_interno
  FROM cat c
  LEFT JOIN liga l ON l.sucursal = c.sucursal AND l.c4 = c.c4 AND l.folio = c.folio
`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_purchase_adjustments AS ` + VISTA);
  await knex.raw(`COMMENT ON VIEW analytics.v_purchase_adjustments IS '[RE.68] Notas de credito (X-D-55) y devoluciones de compra (X-D-40) de Kepler, todas las sucursales, sin canceladas. Columnas de la vieja erp_purchase_adjustments + grupo (comercial|operativo|sin_clasificar|traslado: quien sume dinero excluye traslado). Reemplaza al importer import-purchase-adjustments.js.'`);
  await knex.raw(`GRANT SELECT ON analytics.v_purchase_adjustments TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
    EXECUTE 'GRANT SELECT ON analytics.v_purchase_adjustments TO dev_ro'; END IF; END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_purchase_adjustments`);
};
