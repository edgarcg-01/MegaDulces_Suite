'use strict';
/**
 * `[PR.S2.1]` — **La cascada, agregada al grano de decisión y materializada.**
 *
 * ── Por qué existe: 58.5 de los 80 segundos ────────────────────────────────────────────────
 * `[PR.S2]` aplicó `v_price_signals` y midió **79,618 ms**. El desglose del costo, medido pieza
 * por pieza contra prod:
 *
 *   · `v_price_psychology` sola ............     225 ms
 *   · `v_kepler_standard_cost` sola ........      47 ms
 *   · el `DISTINCT ON` del peldaño .........   1,140 ms
 *   · ⛔ **la cascada agregada (30 d)** ......  **58,560 ms**
 *
 * **El 73 % del costo está en una sola pieza.** `v_price_waterfall` es una vista sobre otras dos
 * vistas del ODS (`erp_sales_invoices` ⋈ `erp_sales_invoice_lines`), así que agregarla obliga a
 * reconstruir el join de facturas cada vez que alguien abre la pantalla.
 *
 * ⭐ Se materializa **sólo esta pieza**, no la vista entera de señales: materializar todo
 * congelaría también la psicología y el costo, que corren en milisegundos y se leen frescos.
 * *Se materializa por COSTO medido, no por costumbre* — es la excepción legítima de §19.
 *
 * ⚠️ El precio de materializar: la cascada pasa a ser de **ayer**, no de ahora. Es aceptable
 * porque su fuente ya es nightly, y porque la decisión de precio no se toma con el descuento de
 * hace dos horas. Queda declarado en `calculado_al`, que la pantalla muestra.
 *
 * ⛔ Y lo que NO cambia: la cobertura sigue siendo **6 % de las celdas / 33 % de la venta**. El
 * mostrador es contado anónimo y materializar no lo hace aparecer.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_price_waterfall_sku';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    SELECT
      w.tenant_id, w.sucursal, w.sku,
      count(*)::int                                                  AS lineas,
      count(DISTINCT w.cliente_code)::int                            AS clientes,
      count(DISTINCT w.vendedor_code)::int                           AS vendedores,
      round(sum(w.neto_linea)::numeric, 2)                           AS neto,
      round(sum(w.bruto_lista)::numeric, 2)                          AS lista,
      round(sum(w.fuga_linea)::numeric, 2)                           AS fuga,
      round(min(w.precio_unitario)::numeric, 4)                      AS pu_min,
      round(max(w.precio_unitario)::numeric, 4)                      AS pu_max,
      round((percentile_cont(0.5) WITHIN GROUP
             (ORDER BY w.precio_unitario))::numeric, 4)              AS pu_mediana,
      round(avg(w.dias_pago)::numeric, 2)                            AS dias_pago,
      round(avg(w.dias_credito)::numeric, 2)                         AS dias_credito,
      -- ⭐ La frescura viaja CON el dato: una matvista sin su fecha se lee como si fuera de ahora.
      now()                                                          AS calculado_al,
      (CURRENT_DATE - 30)                                            AS ventana_desde
    FROM analytics.v_price_waterfall w
    WHERE w.fecha >= CURRENT_DATE - 30
    GROUP BY w.tenant_id, w.sucursal, w.sku
  `);

  // UNIQUE para poder refrescar sin bloquear a quien esté leyendo.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_price_waterfall_sku
    ON ${MV} (tenant_id, sucursal, sku)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $c$[PR.S2.1] La cascada agregada al grano (sucursal, sku) y MATERIALIZADA por costo medido:
    era 58,560 ms de los 79,618 que tardaba v_price_signals -- el 73% en una sola pieza, porque
    v_price_waterfall es una vista sobre dos vistas del ODS y agregarla reconstruye el join de
    facturas en cada lectura. Se materializa SOLO esta pieza: materializar la vista de senales
    entera congelaria tambien la psicologia y el costo, que corren en milisegundos.
    ⚠️ El precio: la cascada pasa a ser de la ultima corrida, no de ahora -- declarado en
    calculado_al. ⛔ La cobertura NO cambia: sigue siendo 6% de las celdas y 33% de la venta,
    porque el mostrador es contado anonimo y materializar no lo hace aparecer.$c$`);

  const [g] = (await knex.raw(`
    SELECT count(*)::int filas, count(DISTINCT sku)::int skus,
           round(sum(neto)::numeric, 0) AS neto,
           count(*) FILTER (WHERE clientes >= 5)::int con_dispersion
      FROM ${MV}`)).rows;

  const t0 = Date.now();
  await knex.raw(`SELECT count(*) FROM ${MV}`);
  const ms = Date.now() - t0;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.1] ${g.filas} filas · ${g.skus} SKUs · $${Number(g.neto).toLocaleString()} `
    + `· con ≥5 clientes ${g.con_dispersion} · lectura ${ms} ms`);

  if (g.filas === 0) {
    throw new Error('[PR.S2.1] la matvista quedó vacía: la cascada tenía 5,154 pares medidos.');
  }
  if (ms > 1000) {
    throw new Error(`[PR.S2.1] leerla tarda ${ms} ms: materializar no sirvió de nada.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
