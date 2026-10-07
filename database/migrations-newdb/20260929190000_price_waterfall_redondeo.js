'use strict';
/**
 * `[PR.W1.1]` — **Un solo redondeo.** La fuga se calcula desde el MISMO bruto que se publica.
 *
 * ── El bug, medido en prod a las horas de aplicar la vista ──────────────────────────────────
 * `20260929180000` publicaba dos números que venían del mismo producto pero con el redondeo en
 * **orden distinto**:
 *
 *     bruto_lista = round(precio_lista × cantidad, 2)
 *     fuga_linea  = round(precio_lista × cantidad − importe, 2)   ← redondea DESPUÉS de restar
 *
 * Con `61.25 × 24.98 = 1530.025`:
 *     bruto_lista = round(1530.025)        = 1530.03
 *     fuga_linea  = round(1530.025 − 1530.03) = round(−0.005) = **−0.01**
 *
 * O sea **una fuga NEGATIVA** en una línea cobrada exactamente a lista. Medido: **18 líneas en
 * 30 días, todas `KG` con cantidad fraccionaria** (1.05, 0.95, 2.05, 24.98), las 18 con
 * `precio_unitario = precio_lista` al centavo. Impacto total: **−$0.18**.
 *
 * ⭐ El monto es nada. El defecto no: una fuga negativa dice que el cliente pagó DE MÁS, y esta
 * vista existe para localizar dónde se va el dinero. Un signo al revés en la pieza que señala
 * el problema envenena cualquier agregado que se construya encima.
 *
 * ── ⭐⭐ LA LECCIÓN, que vale más que el arreglo ─────────────────────────────────────────────
 * Había **DOS compuertas** sobre esto y **sólo una lo atrapó**:
 *
 *   · la de la IDENTIDAD (`bruto − fuga = neto`) usa tolerancia `> 0.02` → **dejó pasar** un
 *     error de 0.01 y la migración se aplicó en verde
 *   · la del SIGNO (`fuga < 0`) es exacta → lo cazó en el primer test contra prod
 *
 * **Una tolerancia generosa es un agujero con forma de compuerta.** Donde el defecto que se
 * busca es más chico que la tolerancia, el gate no mide: tranquiliza.
 *
 * ── Y la otra lección, que el repo ya tenía escrita ─────────────────────────────────────────
 * El freno original preguntaba por `precio_unitario > precio_lista` —los **precios**— mientras
 * el número que protegía se calculaba desde el **importe**. Cuando el guardián mira un campo y
 * la cuenta usa otro, hay un hueco entre los dos por donde se cuela justo el caso raro.
 * Es la misma familia que `[LC.9]` (*"el freno preguntaba por un string precalculado que nunca
 * falta"*). Acá el freno pasa a comparar **exactamente lo que se publica**.
 *
 * Aditiva: `CREATE OR REPLACE VIEW` sobre la misma vista. No toca ningún otro objeto.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_waterfall';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW} AS
    WITH base AS (
      SELECT
        h.tenant_id, h.sucursal, h.warehouse_id, h.fecha, h.doc_prefix, h.folio,
        l.linea, l.sku, l.product_id, l.descripcion, l.unidad,
        h.cliente_code, h.cliente_nombre, h.vendedor_code, h.vendedor_nombre, h.canal,
        l.cantidad, l.precio_lista, l.precio_unitario,
        l.descuento_unitario, l.descuento_linea, l.importe,
        h.descuento, h.descuento_pct, h.subtotal,
        h.dias_credito, h.dias_pago, h.saldo, h.estatus_cobro,
        l.iva_tasa, l.ieps_tasa, l.box_factor, l.box_factor_dudoso,
        -- ⭐ EL redondeo, UNA sola vez. Todo lo de abajo sale de acá.
        CASE WHEN l.precio_lista > 0
             THEN round(l.precio_lista * l.cantidad, 2) END           AS bruto_lista
      FROM analytics.erp_sales_invoices h
      JOIN analytics.erp_sales_invoice_lines l
        ON l.tenant_id  = h.tenant_id
       AND l.sucursal   = h.sucursal
       AND l.doc_prefix = h.doc_prefix
       AND l.folio      = h.folio
      WHERE NOT h.cancelada
        AND l.cantidad > 0
    )
    SELECT
      tenant_id, sucursal, warehouse_id, fecha, doc_prefix, folio, linea,
      sku, product_id, descripcion, unidad,
      cliente_code, cliente_nombre, vendedor_code, vendedor_nombre, canal,
      cantidad, precio_lista, precio_unitario, bruto_lista,
      descuento_unitario, descuento_linea,
      importe                                                          AS neto_linea,
      /**
       * ⭐ La fuga sale del MISMO bruto_lista que se publica, ya redondeado. Así la identidad
       * bruto_lista − fuga_linea = neto_linea es EXACTA por construcción, no por tolerancia.
       *
       * ⛔ Y el freno compara lo que se PUBLICA (bruto_lista contra importe), no los precios
       * unitarios: por ese hueco se colaron las 18 líneas de KG a precio exacto de lista.
       */
      CASE
        WHEN bruto_lista IS NULL       THEN NULL
        WHEN bruto_lista < importe     THEN NULL   -- se cobró POR ENCIMA: no es fuga
        ELSE bruto_lista - importe
      END                                                              AS fuga_linea,
      CASE
        WHEN bruto_lista IS NULL OR bruto_lista = 0 THEN NULL
        WHEN bruto_lista < importe                  THEN NULL
        ELSE round(100 * (bruto_lista - importe) / bruto_lista, 4)
      END                                                              AS fuga_pct,

      descuento                                                        AS desc_documento,
      descuento_pct                                                    AS desc_documento_pct,
      subtotal                                                         AS subtotal_documento,

      dias_credito, dias_pago,
      CASE WHEN dias_pago IS NOT NULL AND dias_credito IS NOT NULL
           THEN dias_pago - dias_credito END                           AS dias_exceso,
      saldo, estatus_cobro,

      -- El veredicto usa EL MISMO criterio que la fuga. Si divergieran, una línea podría decir
      -- 'a_lista' y traer fuga NULL, o al revés — y nadie sabría cuál de los dos creer.
      CASE
        WHEN bruto_lista IS NULL    THEN 'sin_lista'
        WHEN bruto_lista < importe  THEN 'precio_sobre_lista'
        WHEN bruto_lista > importe  THEN 'con_descuento'
        ELSE                             'a_lista'
      END                                                              AS veredicto,

      iva_tasa, ieps_tasa, box_factor, box_factor_dudoso
    FROM base
  `);

  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $$[PR.W1.1] La cascada de precio: lista -> descuento de renglon -> neto, con la capa de
    DOCUMENTO expuesta APARTE y el costo del credito. ⭐ UN SOLO REDONDEO: la fuga se calcula
    desde el mismo bruto_lista que se publica, asi la identidad bruto - fuga = neto es EXACTA
    por construccion. La version anterior redondeaba en dos ordenes distintos y producia fuga
    NEGATIVA en lineas cobradas a lista exacta (18 casos en 30 dias, todas KG con cantidad
    fraccionaria, -$0.18). ⭐⭐ Lo atrapo la compuerta del SIGNO, no la de la IDENTIDAD: esa
    usaba tolerancia 0.02 y el defecto era 0.01 -- una tolerancia generosa es un agujero con
    forma de compuerta. ⛔ LAS DOS CAPAS DE DESCUENTO NO SE SUMAN: conviven (medido, 380 de
    2,783 docs traen las dos). fuga_linea va NULL sin precio_lista y cuando se cobro POR ENCIMA.
    VISTA derive-no-copy sobre el ODS, security_invoker.$$`);

  // ── Compuerta, ahora EXACTA: cero tolerancia ────────────────────────────────────────
  const { rows: g } = await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE fuga_linea < 0)::int negativas,
           count(*) FILTER (WHERE fuga_linea IS NOT NULL
                              AND bruto_lista - fuga_linea <> neto_linea)::int no_cierra,
           count(*) FILTER (WHERE veredicto = 'sin_lista' AND fuga_linea IS NOT NULL)::int sin_lista_con_fuga
      FROM ${VIEW}
     WHERE fecha >= CURRENT_DATE - 7`);
  const r = g[0];
  // eslint-disable-next-line no-console
  console.log(`  · [PR.W1.1] 7d: ${r.filas} líneas · negativas ${r.negativas} · `
    + `identidad rota ${r.no_cierra} · sin_lista con fuga ${r.sin_lista_con_fuga}`);

  // ⛔ Sin tolerancia. El defecto que este arreglo corrige medía 0.01, o sea que cualquier
  //    holgura lo habría dejado pasar otra vez.
  if (r.negativas > 0 || r.no_cierra > 0 || r.sin_lista_con_fuga > 0) {
    throw new Error(
      `[PR.W1.1] la cascada sigue mal: ${r.negativas} fugas negativas, `
      + `${r.no_cierra} identidades rotas, ${r.sin_lista_con_fuga} sin_lista con fuga.`,
    );
  }
};

exports.down = async function down(knex) {
  // No se revierte a la versión con el bug de redondeo: se baja la vista entera.
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
