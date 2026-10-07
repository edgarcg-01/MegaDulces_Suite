'use strict';
/**
 * `[COT.1.0]` — `analytics.v_erp_discount_rules`: los CUATRO descuentos de producto que autoriza
 * el ERP, en UNA vista, para TODAS las tiendas.
 *
 * ── Por qué una vista nueva y no la que ya había ────────────────────────────────────────────
 * `analytics.erp_promotions` ya une los cuatro `kdpv_*`… **pero filtra `sucursal = '03'`
 * hardcodeada** (y el `tenant_id` también). Sirve para lo que nació —la señal "hay promo" de
 * Thot— y **no sirve para cotizar**, porque una cotización se arma desde la sucursal del cliente.
 * No se toca esa vista: tiene sus propios consumidores. Esta es la que usa el motor de precio.
 *
 * Tampoco alcanzaba `analytics.v_label_promotions`: resuelve muy bien el caso difícil
 * —vigencia, tienda y **presentación**, con su `pct` verificado contra ventas (113 vs 2)— pero
 * sólo cubre `kdpv_descuxq`, uno de los cuatro. Esta vista **calca su técnica** (el `DISTINCT ON`
 * que deduplica y la resolución de la unidad contra `kdii`) y la extiende a los otros tres.
 *
 * ── Decode verificado con datos reales (2026-09-22) ─────────────────────────────────────────
 * Las cuatro tablas comparten la forma de `c1` a `c8`. Medido fila por fila, no supuesto:
 *
 *   c1  = TIENDA a la que aplica la regla  ⚠️ NO es la columna `sucursal` del ODS: una fila
 *         replicada desde la rama `00` puede aplicar a la tienda `02`. Por eso el orden del
 *         DISTINCT ON prefiere la fila cuya rama coincide con su tienda (igual que la vista de
 *         etiquetas).
 *   c2  = SKU
 *   c3  = UNIDAD / presentación (PAQ, CJA, PZA…) — ⚠️ el descuento es POR UNIDAD, no por
 *         producto: el mismo SKU tiene reglas distintas en PAQ y en CJA (ADR-055/057).
 *   c4  = descripción del producto (rótulo, no llave)
 *   c5  = UMBRAL — cantidad en los `*xq`, MONTO en los `*xm`
 *   c6  = BENEFICIO — **% de descuento** en `descu*`, **SKU del producto gratis** en `gratis*`
 *   c7/c8 = vigencia desde / hasta
 *   c9/c10 = control de saldo (asignado / restante)
 *   c11 = cantidad gratis  ·  c12 = unidad del producto gratis   (sólo en `gratis*`)
 *
 * Ejemplos que sostienen el decode:
 *   descuxm : c1=02 c2=70070 c3=PAQ c5=2.00  c6=5.00  → "a partir de $2.00 → 5%"
 *   gratisxq: c1=02 c2=27115 c3=PAQ c5=3.00  c6=27100 c11=1.00 c12=PAQ → "3 → te doy 1 de 27100"
 *   gratisxm: c1=02 c2=88124 c3=PAQ c5=5.00  c6=88124 c11=1.00 c12=PAQ → el gratis es el MISMO SKU
 *
 * ⛔ **Lo que esta vista NO afirma, a propósito:**
 *   · **La unidad del UMBRAL de monto.** `c5 = 2.00` en un descuento por monto es un umbral
 *     sospechosamente bajo para pesos. No hay forma de contrastarlo: `descuxm` tiene **0 reglas
 *     vigentes** hoy, así que no existe una venta con la que cuadrarlo. Se publica el número
 *     crudo y `umbral_verificado = false`. El motor **no aplica** un mecanismo no verificado sin
 *     que alguien lo habilite — mejor no descontar que descontar por una unidad inventada.
 *   · **Que las reglas NO se traslapen.** El aviso de Kepler ("No debe traslapar promociones
 *     activas") es una instrucción a la persona, no una restricción del sistema: hay
 *     combinaciones con 3 filas idénticas vigentes. El `DISTINCT ON` se queda con UNA —si no,
 *     un JOIN triplica el renglón— y `reglas_duplicadas` dice cuántas había.
 *
 * ⚠️ `saldo_estado` se publica, no se filtra (decisión de `[ETQ-PROMO.6]`, 2026-09-19): la
 * sucursal 08 no llena `c9`/`c10` en ninguna de sus 5,333 filas, y filtrar por saldo le borraba
 * sus 117 promos en silencio. Cero no es "agotada", es "no lleva ese control".
 *
 * @param { import("knex").Knex } knex
 */

/** El SELECT de un mecanismo. Los cuatro comparten forma; cambia qué significa `c5` y `c6`. */
function bloque({ tabla, mecanismo, umbralTipo, esGratis }) {
  // En `descu*` el beneficio es el %; en `gratis*` el % no existe y c6 es el SKU regalado.
  const pct = esGratis ? 'NULL::numeric' : `nullif(regexp_replace(d.c6::text,'[^0-9.]','','g'),'')::numeric`;
  const freeSku = esGratis ? `nullif(btrim(d.c6),'')` : 'NULL::text';
  const freeQty = esGratis ? `nullif(regexp_replace(d.c11::text,'[^0-9.]','','g'),'')::numeric` : 'NULL::numeric';
  const freeUnit = esGratis ? `nullif(upper(btrim(d.c12)),'')` : 'NULL::text';

  // El SELECT va envuelto en un subselect: `DISTINCT ON` exige su propio `ORDER BY`, y un
  // `ORDER BY` suelto dentro de un `UNION ALL` pertenece a la unión, no al brazo (42601).
  return `
  SELECT * FROM (
  SELECT DISTINCT ON (btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)))
         btrim(d.c1)                        AS tienda,
         btrim(d.c2)                        AS sku,
         upper(btrim(d.c3))                 AS unidad,
         '${mecanismo}'::text               AS mecanismo,
         '${umbralTipo}'::text              AS umbral_tipo,
         nullif(regexp_replace(d.c5::text,'[^0-9.]','','g'),'')::numeric AS umbral,
         ${pct}                             AS pct,
         ${freeSku}                         AS free_sku,
         ${freeQty}                         AS free_qty,
         ${freeUnit}                        AS free_unidad,
         d.c7::date                         AS valid_from,
         d.c8::date                         AS valid_to,
         d.c10::numeric                     AS saldo,
         CASE WHEN d.c10::numeric > 0 THEN 'con_saldo'
              WHEN d.c9::numeric  > 0 THEN 'agotada'
              ELSE 'sin_control' END        AS saldo_estado,
         count(*) OVER (PARTITION BY btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)))::int AS reglas_duplicadas,
         btrim(d.sucursal::text)            AS rama_ods,
         btrim(d.c4)                        AS raw_name
    FROM kepler_ods.${tabla} d
   WHERE d.c7 <= now() AND d.c8 >= now()
     AND btrim(coalesce(d.c1,'')) <> ''
     AND btrim(coalesce(d.c2,'')) <> ''
   ORDER BY btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)),
            (btrim(d.sucursal::text) = btrim(d.c1)) DESC, d.c8 DESC
  ) AS ${mecanismo}_brazo`;
}

const MECANISMOS = [
  { tabla: 'kdpv_descuxq',  mecanismo: 'descuento_cantidad', umbralTipo: 'cantidad', esGratis: false },
  { tabla: 'kdpv_descuxm',  mecanismo: 'descuento_monto',    umbralTipo: 'monto',    esGratis: false },
  { tabla: 'kdpv_gratisxq', mecanismo: 'gratis_cantidad',    umbralTipo: 'cantidad', esGratis: true  },
  { tabla: 'kdpv_gratisxm', mecanismo: 'gratis_monto',       umbralTipo: 'monto',    esGratis: true  },
];

exports.up = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_discount_rules');
  await knex.raw(`
CREATE VIEW analytics.v_erp_discount_rules AS
WITH reglas AS (
${MECANISMOS.map(bloque).join('\n  UNION ALL\n')}
)
SELECT r.tienda,
       r.sku,
       r.unidad,
       r.mecanismo,
       r.umbral_tipo,
       r.umbral,
       r.pct,
       r.free_sku,
       r.free_qty,
       r.free_unidad,
       r.valid_from,
       r.valid_to,
       r.saldo,
       r.saldo_estado,
       r.reglas_duplicadas,
       r.rama_ods,
       r.raw_name,
       -- El umbral de CANTIDAD se lee en la misma unidad del renglon (c3), que es comparable.
       -- El de MONTO no tiene testigo: ninguna regla vigente con que cuadrarlo contra una venta.
       (r.umbral_tipo = 'cantidad')                AS umbral_verificado,
       -- La unidad de la regla, resuelta contra la escalera del producto en ESA tienda.
       -- NULL = la regla apunta a una unidad que el producto no tiene: no se puede aplicar.
       CASE WHEN r.unidad = upper(btrim(coalesce(k.c11,''))) THEN 'base'
            WHEN r.unidad = upper(btrim(coalesce(k.c80,''))) THEN 'unidad2'
            WHEN r.unidad = upper(btrim(coalesce(k.c83,''))) THEN 'unidad3'
       END                                          AS aplica_a
  FROM reglas r
  LEFT JOIN kepler_ods.kdii k
         ON btrim(k.c1) = r.sku AND btrim(k.sucursal::text) = r.tienda`);

  await knex.raw('GRANT SELECT ON analytics.v_erp_discount_rules TO app_runtime');
  await knex.raw(`
    COMMENT ON VIEW analytics.v_erp_discount_rules IS
    'derive-no-copy sobre los 4 kepler_ods.kdpv_* (descuxq/descuxm/gratisxq/gratisxm): las reglas de descuento de PRODUCTO vigentes hoy, para TODAS las tiendas (c1, no la rama del ODS) y por presentacion. Es la fuente del motor de precio de cotizaciones [COT.1]. NO incluye el descuento del CLIENTE, que es otra capa (kdud.c17 -> capa documento, ERP_KEPLER 3.1). umbral_verificado=false en los mecanismos por MONTO: su umbral no tiene testigo (0 reglas vigentes con que cuadrarlo). aplica_a NULL = la regla apunta a una unidad que el producto no tiene. saldo_estado se publica, no se filtra (la sucursal 08 no lleva ese control).'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_erp_discount_rules');
};
