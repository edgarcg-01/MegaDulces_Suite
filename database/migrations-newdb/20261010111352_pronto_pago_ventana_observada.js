'use strict';
/**
 * `[PP.0]` — **La ventana del pronto pago, DERIVADA de lo que de hecho pasó.**
 *
 * Nace del pedido de Edgar (2026-10-10): *"necesitamos darle eso a Pagos, para que no perdamos
 * acceso a esos privilegios"*. El privilegio se pierde por FECHA: si Tesorería no sabe que una
 * factura trae descuento y hasta cuándo, lo paga tarde y el descuento se evapora sin que nadie
 * registre la pérdida.
 *
 * ── Lo medido antes de escribir esto (prod, sólo lectura, 2026-10-10) ───────────────────────
 *
 * ⭐ **El descuento por pronto pago es dinero grande y nadie lo administra:** `c84` sobre los
 * pagos a proveedor de compra devuelve **$17,094,609 en 12 meses** (2,381 documentos).
 *
 * ⛔ **Y no hay con qué saber la fecha límite.** `commercial.supplier_discount_policy` tiene 147
 * filas, **todas `source='observed'`** (o sea, lo que pasó, no lo pactado), con
 * `expected_discount_rate` ~6.3% y **`discount_days` VACÍO en el 100%**. Sin los días no se puede
 * decir "te quedan 4": sólo "este proveedor a veces da descuento".
 *
 * ⭐ **Pero la ventana SÍ se puede derivar, y derivarla gana:** cruzando los pagos con `c84 > 0`
 * contra la factura que aplicaron (`kdxf` → `kdxe`), la mediana real es **26 días** (promedio 33,
 * p90 72) sobre **4,747 pagos**. Y aparecen **190 proveedores** con ventana observable contra los
 * **147** de la tabla de políticas: la derivación cubre más que el dato capturado a mano.
 *
 * | exigiendo | proveedores | descuento 12m que cubren |
 * |---|---:|---:|
 * | n >= 1 | 190 | $57,250,002 |
 * | **n >= 3** | **157** | **$57,080,805** (99.7%) |
 * | n >= 10 | 101 | $55,546,413 |
 *
 * ⇒ Con **n >= 3** se conserva el 99.7% del dinero y se tiran los proveedores donde una sola
 * coincidencia haría pasar por "ventana" a una casualidad. Ese es el umbral, y está medido.
 *
 * ⚠️ **Por qué matvista y no vista.** La derivación cruza `kdm1 x kdxf x kdxe` sobre 12 meses y
 * tarda **22-25 s** medidos en prod. Una pantalla con gate de 1 s no puede pagarla en vivo. El
 * universo cambia de a poco (es historia de 12 meses), así que nocturno sobra.
 *
 * ⛔ **Lo que esto NO es, y hay que decirlo en pantalla.** Es la ventana **OBSERVADA**, no la
 * pactada. Dice "cuando pagamos a este proveedor y nos dieron descuento, fue a los N días", que es
 * una guía defendible y NO una promesa del proveedor. El acuerdo real no existe como dato en
 * ningún lado (ADR-056: se declara el hueco, no se dibuja). Cuando exista la ficha de acuerdo,
 * ESTA matvista pasa a ser el contraste: *¿nos dan lo que dijeron?*
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_supplier_prompt_discount`);

  // ⚠️ `AS MATERIALIZED` en las CTE NO es decorativo: PG12+ las inlinea si se referencian una sola
  // vez, y acá el planner elegia re-escanear kdm1 entero por cada rama. Medido en la fase: con el
  // inlining la derivacion no bajaba de los 25 s ni con indices.
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_supplier_prompt_discount AS
    WITH pagos AS MATERIALIZED (
      -- Los pagos a proveedor de COMPRA que SE LLEVARON descuento. c84 = descuento al pagar.
      -- El filtro c10 LIKE 'C%' acota al universo de compra: sin el entran nomina (GN), caja
      -- chica (GG) y banco (GB), que no tienen nada que ver con el pronto pago de mercancia.
      SELECT btrim(m.c1) AS suc, btrim(m.c6) AS folio, m.c4::int AS dt,
             btrim(m.c10) AS prov,
             NULLIF(btrim(m.c84),'')::numeric AS descuento,
             NULLIF(btrim(m.c16::text),'')::numeric AS pagado
        FROM kepler_ods.kdm1 m
       WHERE btrim(m.c2) = 'X' AND btrim(m.c3) = 'D' AND m.c4::int IN (26,25,60)
         AND m.c9::date >= CURRENT_DATE - 365
         AND btrim(m.c10) LIKE 'C%'
         AND NULLIF(btrim(m.c84),'')::numeric > 0
    ), apl AS MATERIALIZED (
      -- kdxf liga el documento que APLICA (c4,c5,c6 con fecha c3) con el APLICADO (c7,c8,c9).
      SELECT btrim(f.c1) AS suc, f.c4::int AS dt, btrim(f.c6) AS folio,
             btrim(f.c9) AS fac_folio, f.c7::int AS fac_tipo, f.c3::date AS fecha_pago
        FROM kepler_ods.kdxf f
       WHERE f.c4::int IN (26,25,60) AND f.c3::date >= CURRENT_DATE - 365
    ), fac AS MATERIALIZED (
      -- kdxe c3='A' = los CARGOS del proveedor (las facturas). c7 = su fecha.
      SELECT btrim(e.sucursal) AS suc, btrim(e.c6) AS folio, e.c4::int AS tipo,
             CASE WHEN e.c7 >= '1900-01-01'::timestamp THEN e.c7::date END AS fecha_fac
        FROM kepler_ods.kdxe e
       WHERE e.c3 = 'A'
    ), pares AS (
      SELECT p.prov, p.descuento, p.pagado,
             (a.fecha_pago - fc.fecha_fac) AS dias
        FROM pagos p
        JOIN apl  a  ON a.suc = p.suc AND a.dt = p.dt AND a.folio = p.folio
        JOIN fac  fc ON fc.suc = a.suc AND fc.folio = a.fac_folio AND fc.tipo = a.fac_tipo
       WHERE fc.fecha_fac IS NOT NULL
         -- ⛔ Un pago fechado ANTES de su factura no es una ventana de 'menos cero dias': es un
         -- error de captura o un anticipo. Se excluye en vez de dejarlo arrastrar la mediana.
         AND a.fecha_pago >= fc.fecha_fac
    )
    SELECT
      prov                                                                    AS proveedor_code,
      count(*)::int                                                           AS n_observaciones,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY dias)::int                  AS dias_mediana,
      percentile_disc(0.9) WITHIN GROUP (ORDER BY dias)::int                  AS dias_p90,
      min(dias)::int                                                          AS dias_min,
      max(dias)::int                                                          AS dias_max,
      -- Tasa OBSERVADA: lo que nos descontaron sobre lo que pagamos. Es la que manda sobre el
      -- expected_discount_rate de la tabla de politicas, que tambien es observado pero viejo.
      round(sum(descuento) / NULLIF(sum(pagado + descuento), 0), 4)           AS tasa_observada,
      round(sum(descuento), 2)                                                AS descuento_12m,
      round(sum(pagado + descuento), 2)                                       AS base_12m
      FROM pares
     GROUP BY prov
    WITH NO DATA`);

  // CONCURRENTLY lo exige: sin indice unico el refresco bloquea lecturas.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_supplier_prompt_discount_pk
      ON analytics.mv_supplier_prompt_discount (proveedor_code)`);

  await knex.raw(`GRANT SELECT ON analytics.mv_supplier_prompt_discount TO PUBLIC`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_supplier_prompt_discount IS
      'PP.0 - ventana OBSERVADA del descuento por pronto pago, por proveedor de compra. '
      'Derivada de los pagos con kdm1.c84 > 0 cruzados a su factura por kdxf -> kdxe, 12 meses. '
      'NO es la condicion pactada: el acuerdo con el proveedor no existe como dato. '
      'Usar con n_observaciones >= 3 (medido: conserva 99.7% del descuento con 157 de 190 '
      'proveedores). Refresco nocturno; la derivacion tarda 22-25 s y no cabe en vivo.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_supplier_prompt_discount`);
};
