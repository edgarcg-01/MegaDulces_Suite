'use strict';
/**
 * `[PR.X1]` — **La serie de costo, precio y volumen por SKU: la espina dorsal de la gráfica.**
 *
 * ── El pedido ─────────────────────────────────────────────────────────────────────────────
 * *"una grafica en la cual veamos como se relaciona su historial de costos con sus ventas y
 * como han afectado"*.
 *
 * ── ⭐ No existe una tabla de historia de costo, y no hace falta ──────────────────────────
 * La Fase VP documenta que no hay historia de datos maestros. Es cierto para el catalogo, pero
 * la pregunta se responde por otro lado: `analytics.mv_erp_margin_daily` ya trae **costo, venta
 * y unidades en el mismo grano** (sucursal, sku, dia), 889,806 filas de **oct-2025 a hoy**, con
 * el costo tomado del **renglon real de venta del ERP** en el 96.4 % de los casos.
 *
 * `cogs_arbitrado / unidades_vendidas` **es** el costo unitario realizado. No se reconstruye: se
 * observa.
 *
 * ── ⛔ La trampa de unidades que esto evita ───────────────────────────────────────────────
 * `unidades_vendidas` cuenta TODAS las unidades, tambien las de renglones **sin costo**. Medido
 * en 365 dias: 143,194 unidades con `cogs_arbitrado` en NULL sobre $22.2 M de venta.
 *
 * Dividir el costo entre todas las unidades lo **subdeclararia**. Por eso el costo y el precio
 * de la grafica salen los dos del **mismo subconjunto costeado** (`metodo_costo = 'erp_linea'`,
 * donde `venta_neta_costeada = venta_neta` exacto y `lineas_con_costo = lineas`), y la venta que
 * queda fuera se publica aparte con su cobertura. *Dos numeros comparables y un hueco declarado,
 * en vez de un promedio que mezcla.*
 *
 * ── ⛔⛔ Por que MENSUAL y no diario ──────────────────────────────────────────────────────
 * El par (sucursal, sku) promedio vende **26.7 dias AL ANO**. Una serie diaria es un peine de
 * ceros que se lee como caida de demanda. De 31,873 pares: **6,976 (22 %)** tienen >=6 meses con
 * costo y venta, 13,894 (44 %) tienen >=3. Eso lo publica `meses_con_dato` para que la pantalla
 * **no dibuje** lo que no tiene forma.
 *
 * ⚠️ Ventana: **oct-2025 en adelante**. Antes no hay costo en ninguna forma, y la grafica no
 * debe sugerir que si.
 *
 * VISTA derive-no-copy. Cero importers.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_sku_cost_sales_monthly';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ pob }] = (await knex.raw(`
    SELECT relispopulated AS pob FROM pg_class
     WHERE oid = 'analytics.mv_erp_margin_daily'::regclass`)).rows;
  if (!pob) throw new Error('[PR.X1] analytics.mv_erp_margin_daily esta vacia');

  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);

  await knex.raw(`
    CREATE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    SELECT
      g.tenant_id,
      g.warehouse_code                                          AS sucursal,
      g.sku,
      date_trunc('month', g.sale_date)::date                    AS mes,

      -- ══ EL SUBCONJUNTO COSTEADO — costo y precio comparables entre si ══════════════════
      -- ⛔ Los dos salen de las MISMAS filas. Mezclar el costo de unas con el precio de todas
      --    produce un margen que no le pertenece a ningun renglon.
      round(sum(g.cogs_arbitrado) FILTER (WHERE g.metodo_costo = 'erp_linea')::numeric, 2)
                                                                AS cogs,
      round(sum(g.venta_neta_costeada) FILTER (WHERE g.metodo_costo = 'erp_linea')::numeric, 2)
                                                                AS venta_costeada,
      round(sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea')::numeric, 3)
                                                                AS unidades_costeadas,
      CASE WHEN sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea') > 0
           THEN round((sum(g.cogs_arbitrado) FILTER (WHERE g.metodo_costo = 'erp_linea')
                       / sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea'))::numeric, 4)
      END                                                       AS costo_unitario,
      CASE WHEN sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea') > 0
           THEN round((sum(g.venta_neta_costeada) FILTER (WHERE g.metodo_costo = 'erp_linea')
                       / sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea'))::numeric, 4)
      END                                                       AS precio_unitario,
      CASE WHEN sum(g.venta_neta_costeada) FILTER (WHERE g.metodo_costo = 'erp_linea') > 0
           THEN round((100.0 * (sum(g.venta_neta_costeada) FILTER (WHERE g.metodo_costo = 'erp_linea')
                                - sum(g.cogs_arbitrado) FILTER (WHERE g.metodo_costo = 'erp_linea'))
                       / sum(g.venta_neta_costeada) FILTER (WHERE g.metodo_costo = 'erp_linea'))::numeric, 2)
      END                                                       AS margen_pct,

      -- ══ EL UNIVERSO COMPLETO — para que la cobertura sea visible ═══════════════════════
      round(sum(g.venta_neta)::numeric, 2)                      AS venta_total,
      round(sum(g.unidades_vendidas)::numeric, 3)               AS unidades_total,
      count(DISTINCT g.sale_date)::int                          AS dias_con_venta,
      /**
       * ⭐ La cobertura del costo, EN LA FILA. Un mes al 40 % de cobertura y uno al 100 % se
       *    ven iguales en una linea; con esto la pantalla puede atenuar el primero.
       */
      CASE WHEN sum(g.unidades_vendidas) > 0
           THEN round((100.0 * sum(g.unidades_vendidas) FILTER (WHERE g.metodo_costo = 'erp_linea')
                       / sum(g.unidades_vendidas))::numeric, 1)
      END                                                       AS cobertura_costo_pct,
      round(sum(g.venta_neta) FILTER (WHERE g.metodo_costo = 'sin_costo')::numeric, 2)
                                                                AS venta_sin_costo
    FROM analytics.mv_erp_margin_daily g
    -- ⛔ Solo las sucursales de Kepler: el arbitro trae tambien RUTA-*, que son otro universo.
    WHERE g.warehouse_code ~ '^0[0-8]$'
    GROUP BY 1, 2, 3, 4
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.X1] Costo, precio y volumen por (sucursal, sku, MES) desde analytics.mv_erp_margin_daily.
    Es la espina dorsal de la grafica de historia del motor de margen. No existe tabla de historia
    de costo y no hace falta: cogs_arbitrado/unidades_vendidas ES el costo unitario realizado,
    observado del renglon real del ERP en el 96.4% de los casos, de oct-2025 a hoy.
    ⛔ El costo y el precio salen del MISMO subconjunto costeado (metodo_costo='erp_linea'):
    unidades_vendidas cuenta tambien renglones SIN costo -143,194 unidades sobre $22.2M en 365
    dias- y dividir el costo entre todas las unidades lo subdeclararia. La venta que queda fuera
    se publica en venta_sin_costo y la cobertura por fila en cobertura_costo_pct.
    ⛔⛔ Grano MENSUAL a proposito: el par promedio vende 26.7 dias AL ANO y una serie diaria es
    un peine de ceros que se lee como caida de demanda. 22% de los pares tiene >=6 meses, 44%
    tiene >=3; con menos de 3 la pantalla NO debe dibujar.$c$`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const [g] = (await knex.raw(`
    WITH m AS (SELECT * FROM ${VIEW}),
    p AS (SELECT sucursal, sku, count(*)::int meses,
                 count(*) FILTER (WHERE costo_unitario IS NOT NULL)::int meses_con_costo
            FROM m GROUP BY 1, 2)
    SELECT (SELECT count(*)::int FROM m)                                    AS filas,
           (SELECT count(*)::int FROM p)                                    AS pares,
           (SELECT count(*)::int FROM p WHERE meses_con_costo >= 6)         AS con_6m,
           (SELECT count(*)::int FROM p WHERE meses_con_costo >= 3)         AS con_3m,
           (SELECT to_char(min(mes), 'YYYY-MM') FROM m)                     AS desde,
           (SELECT to_char(max(mes), 'YYYY-MM') FROM m)                     AS hasta,
           -- ⛔ un costo unitario publicado sin unidades costeadas que lo respalden
           (SELECT count(*)::int FROM m
             WHERE costo_unitario IS NOT NULL
               AND (unidades_costeadas IS NULL OR unidades_costeadas <= 0)) AS fantasma,
           -- ⛔ cobertura fuera de rango: seria un denominador mal armado
           (SELECT count(*)::int FROM m
             WHERE cobertura_costo_pct IS NOT NULL
               AND (cobertura_costo_pct < 0 OR cobertura_costo_pct > 100)) AS cobertura_rota,
           (SELECT count(*)::int FROM m WHERE cobertura_costo_pct < 100)    AS meses_parciales`)).rows;
  const ms = Date.now() - t0;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.X1] ${g.filas.toLocaleString()} filas · ${g.pares.toLocaleString()} pares `
    + `· ${g.desde} → ${g.hasta} · con >=6 meses de costo ${g.con_6m.toLocaleString()} `
    + `· con >=3 ${g.con_3m.toLocaleString()} · meses con cobertura parcial `
    + `${g.meses_parciales.toLocaleString()} · ${ms} ms`);

  if (g.fantasma > 0) {
    throw new Error(`[PR.X1] ${g.fantasma} costos unitarios sin unidades costeadas detras.`);
  }
  if (g.cobertura_rota > 0) {
    throw new Error(`[PR.X1] ${g.cobertura_rota} coberturas fuera de 0-100: denominador mal armado.`);
  }
  if (g.con_3m === 0) throw new Error('[PR.X1] ningun par alcanza 3 meses: la serie no sirve.');
  /**
   * ⭐ La cobertura parcial TIENE que existir. Si diera cero, el filtro por metodo_costo no
   *    estaria discriminando nada y el hueco de 143,194 unidades sin costo estaria escondido
   *    dentro del promedio, que es justo lo que esta vista existe para evitar.
   */
  if (g.meses_parciales === 0) {
    throw new Error('[PR.X1] ningun mes con cobertura de costo parcial: el filtro por '
      + 'metodo_costo no esta separando nada y el hueco quedaria escondido.');
  }
  if (ms > 8000) throw new Error(`[PR.X1] la vista tarda ${ms} ms.`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
