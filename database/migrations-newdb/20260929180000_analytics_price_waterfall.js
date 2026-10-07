'use strict';
/**
 * `[PR.W1]` — **La cascada de precio.** De lo que dice la lista a lo que de verdad entra a caja.
 *
 * ── Por qué ────────────────────────────────────────────────────────────────────────────────
 * El margen no se pierde en la lista: se pierde entre la lista y el neto. Es el *pocket price
 * waterfall* con el que Vendavo y Pricefx construyeron su producto, y **el dato ya está en la
 * base** — `analytics.erp_sales_invoice_lines` trae `precio_lista`, `descuento_unitario` y
 * `descuento_linea`, y nadie los mira.
 *
 * Medido el 2026-09-29 sobre 45 días: lista **$17.48M** → neto **$17.17M** = **1.89% de fuga**
 * ≈ **$11.6M/año**, con el **37.2%** de las líneas llevando descuento y un spread por vendedor
 * de **1.41% a 4.17%** (3×). Nada de eso es visible hoy en ninguna pantalla.
 *
 * ── ⛔⛔ LA DECISIÓN QUE DEFINE ESTA VISTA: las dos capas NO SE SUMAN ────────────────────────
 * Kepler tiene **dos capas de descuento que conviven**, y sumarlas infla la fuga:
 *
 *   capa de RENGLÓN   → `precio_lista` vs `precio_unitario` en la línea
 *   capa de DOCUMENTO → `descuento` / `descuento_pct` en la cabecera (cliente, términos)
 *
 * Medido acá (20 días, 2,078 documentos):
 *   · 342 docs con descuento de cabecera · 1,198 con descuento de línea
 *   · ⛔ **271 con LOS DOS** — el 79% de los de cabecera
 *   · ⛔ `subtotal` coincide con la suma de las líneas en **585 de 2,078 = 28.2%**
 *
 * ⭐ Y ese 28.2% **reproduce, sobre otro universo, lo que `quote-pricing.service.ts` ya había
 * decodificado en la Fase TK**: *"de 609 facturas sólo 172 cuadran entre una capa y la otra:
 * 435 difieren. O sea que CONVIVEN: no es 'el mejor de los dos' ni una explica a la otra."*
 * Dos mediciones independientes, el mismo número. Por eso esta vista **expone las dos capas por
 * separado y NUNCA las suma**: quien quiera un total tiene que elegir cuál, a la vista.
 *
 * ── Las identidades verificadas (2026-09-29, 15,004 líneas) ─────────────────────────────────
 *   `importe = precio_unitario × cantidad`                    → **100.00%**
 *   `descuento_linea = descuento_unitario × cantidad`         → **100.00%**
 *   `importe = precio_lista × cantidad − descuento_linea`     → **99.74%**
 *
 * Las **39** líneas que no cierran son exactamente las que tienen `precio_lista < precio_unitario`
 * — se cobró POR ENCIMA de lista. ⛔ Eso **no es un descuento negativo**: es otra cosa (lista
 * desactualizada, precio especial). Va con veredicto propio y **fuera** del total de fuga.
 *
 * ── ADR-056: lo que no se puede medir se DECLARA ────────────────────────────────────────────
 * `precio_lista` nulo ⇒ `veredicto = 'sin_lista'` y **`fuga_linea` va NULL, no 0**. Una línea sin
 * lista no tuvo "cero descuento": no se sabe. Medido: 11 de 15,015 (0.07%), $5.3k.
 *
 * VISTA, no tabla: deriva del ODS y no materializa nada (⭐ regla principal del proyecto).
 * `security_invoker` para que respete la RLS de quien consulta.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_waterfall';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW} AS
    SELECT
      h.tenant_id,
      h.sucursal,
      h.warehouse_id,
      h.fecha,
      h.doc_prefix,
      h.folio,
      l.linea,
      l.sku,
      l.product_id,
      l.descripcion,
      l.unidad,
      h.cliente_code,
      h.cliente_nombre,
      h.vendedor_code,
      h.vendedor_nombre,
      h.canal,

      ---------------------------------------------------------------- CAPA DE RENGLÓN
      l.cantidad,
      l.precio_lista,
      l.precio_unitario,
      -- El bruto a precio de lista. NULL si no hay lista: no se inventa.
      CASE WHEN l.precio_lista > 0 THEN round(l.precio_lista * l.cantidad, 2) END AS bruto_lista,
      l.descuento_unitario,
      l.descuento_linea,
      l.importe                                                        AS neto_linea,
      -- ⭐ La fuga de la capa de RENGLÓN. NULL cuando no hay con qué medirla (ADR-056),
      -- y NULL también cuando se cobró POR ENCIMA de lista: eso no es fuga.
      CASE
        WHEN l.precio_lista IS NULL OR l.precio_lista <= 0 THEN NULL
        WHEN l.precio_unitario > l.precio_lista             THEN NULL
        ELSE round(l.precio_lista * l.cantidad - l.importe, 2)
      END                                                              AS fuga_linea,
      CASE
        WHEN l.precio_lista IS NULL OR l.precio_lista <= 0 THEN NULL
        WHEN l.precio_unitario > l.precio_lista             THEN NULL
        WHEN l.precio_lista * l.cantidad = 0                THEN NULL
        ELSE round(100 * (l.precio_lista * l.cantidad - l.importe)
                   / (l.precio_lista * l.cantidad), 4)
      END                                                              AS fuga_pct,

      ---------------------------------------------------------------- CAPA DE DOCUMENTO
      -- ⛔ SEPARADA A PROPÓSITO. No se suma a la de renglón: conviven (ver encabezado).
      -- Se expone el valor de la cabecera TAL CUAL, sin prorratear a la línea — prorratearlo
      -- sería inventar un reparto que el ERP nunca hizo.
      h.descuento                                                      AS desc_documento,
      h.descuento_pct                                                  AS desc_documento_pct,
      h.subtotal                                                       AS subtotal_documento,

      ---------------------------------------------------------------- COSTO DEL CRÉDITO
      h.dias_credito,
      h.dias_pago,
      CASE WHEN h.dias_pago IS NOT NULL AND h.dias_credito IS NOT NULL
           THEN h.dias_pago - h.dias_credito END                       AS dias_exceso,
      h.saldo,
      h.estatus_cobro,

      ---------------------------------------------------------------- EL VEREDICTO POR LÍNEA
      CASE
        WHEN l.precio_lista IS NULL OR l.precio_lista <= 0 THEN 'sin_lista'
        WHEN l.precio_unitario > l.precio_lista             THEN 'precio_sobre_lista'
        WHEN l.descuento_linea > 0                          THEN 'con_descuento'
        ELSE                                                     'a_lista'
      END                                                              AS veredicto,

      l.iva_tasa,
      l.ieps_tasa,
      l.box_factor,
      l.box_factor_dudoso
    FROM analytics.erp_sales_invoices h
    JOIN analytics.erp_sales_invoice_lines l
      ON l.tenant_id  = h.tenant_id
     AND l.sucursal   = h.sucursal
     AND l.doc_prefix = h.doc_prefix
     AND l.folio      = h.folio
    WHERE NOT h.cancelada
      AND l.cantidad > 0
  `);

  // ⚠️ Tras un CREATE OR REPLACE VIEW hay que re-aplicar security_invoker y el GRANT:
  //    NO se heredan (ADR-057 lo documenta — una migración de esa fase lo perdió y sólo lo
  //    atrapó la aserción de metadata del candado).
  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $$[PR.W1] La cascada de precio: lista -> descuento de renglon -> neto, con la capa de
    DOCUMENTO expuesta APARTE y el costo del credito (dias_pago vs dias_credito).
    ⛔ LAS DOS CAPAS DE DESCUENTO NO SE SUMAN: conviven. Medido 2026-09-29 sobre 2,078 docs,
    271 traen las dos y el subtotal de cabecera coincide con la suma de lineas en solo 28.2%
    — el mismo 28.2% que quote-pricing.service.ts midio en la Fase TK sobre otro universo.
    fuga_linea va NULL cuando no hay precio_lista (no se sabe, no es cero) y cuando se cobro
    POR ENCIMA de lista (39 de 15,004 lineas: eso no es fuga). Identidades verificadas:
    importe = precio_unitario x cantidad al 100%; importe = lista x cant - descuento_linea
    al 99.74%. VISTA derive-no-copy sobre el ODS, security_invoker.$$`);

  // ── Compuerta: la vista tiene que devolver filas y las identidades tienen que cerrar ──
  const { rows: g } = await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto = 'sin_lista')::int sin_lista,
           count(*) FILTER (WHERE veredicto = 'precio_sobre_lista')::int sobre_lista,
           count(*) FILTER (WHERE fuga_linea IS NOT NULL
                              AND abs(bruto_lista - fuga_linea - neto_linea) > 0.02)::int no_cierra
      FROM ${VIEW}
     WHERE fecha >= CURRENT_DATE - 7`);
  const r = g[0];
  // eslint-disable-next-line no-console
  console.log(`  · [PR.W1] 7d: ${r.filas} líneas · sin_lista ${r.sin_lista} · `
    + `sobre_lista ${r.sobre_lista} · identidad rota ${r.no_cierra}`);

  /**
   * ⛔ La identidad `bruto_lista − fuga_linea = neto_linea` es la DEFINICIÓN de la cascada.
   * Si no cierra, la vista está mintiendo sobre de dónde sale el dinero. No se avisa: se aborta.
   */
  if (r.no_cierra > 0) {
    throw new Error(
      `[PR.W1] la cascada NO cierra en ${r.no_cierra} líneas de los últimos 7 días: `
      + 'bruto_lista − fuga_linea ≠ neto_linea. Revisar antes de publicar la vista.',
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
