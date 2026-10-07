'use strict';
/**
 * `[CE.0]` — **La actividad de venta que el costo estándar necesita para pesarse.**
 *
 * Una fila por (sucursal, SKU) con lo único que hay que sacar de `kepler_ods.kdm2` para poder
 * juzgar el costo estándar: el **impuesto observado en el renglón** y el **volumen en unidades
 * BASE**. Todo lo demás de la Fase CE es una vista en vivo sobre el catálogo (`kdii`) y el
 * costo del ERP (`kdik`), que son baratos.
 *
 * ── Por qué esto se materializa y el resto no ──────────────────────────────────────────
 *
 * `kdm2` son **4.7 M renglones / 2.16 GB** y **no tiene índice por fecha** (`c32`): los índices
 * vivos son por `btrim(c8)` (SKU) y por documento. Agregar 30 días cuesta **3.5 s** medidos, y
 * el gate de la casa es < 1 s. Materializar por COSTO es legítimo (`GOTCHAS` §19); lo que está
 * prohibido es materializar un **valor inventado**. Acá no se inventa nada: son dos sumas y una
 * moda sobre renglones que ya existen.
 *
 * ⛔ **No se reusó `analytics.mv_kepler_sales_daily`, y no es por descuido.** Su columna `units`
 * **no está en unidades base**: medido sobre `70001`/suc `01`, 30 d → `mv.units` = 912,
 * `Σ kdm2.c9` (base) = 1,247.91, `Σ c56` (peldaño vendido) = 924.91. Multiplicar `units` por un
 * costo del peldaño BASE sobrecuenta por el factor — es la trampa de ADR-055/057 exactamente.
 * Acá el volumen sale de `c9`, que ES la cantidad en la unidad base del renglón.
 * ⛔ Tampoco sirve su `monto_neto`: **no descuenta impuesto**, prorratea `c16/(c16+c13)` del
 * encabezado (descuento/redondeo). Medido en `70001`: da 0.42 % cuando el IEPS del SKU es 8 %.
 *
 * ── El impuesto: por qué se OBSERVA en vez de leerse de la ficha ───────────────────────
 *
 * La tasa **no está en `kdii`**: se buscó una columna que la prediga con >90 % de pureza entre
 * las 100+ del maestro y **no existe ninguna**. Vive en el renglón (`c17` IVA 0/−16, `c18` IEPS
 * 0/−8), así que se toma de ahí — la moda de lo efectivamente cobrado.
 *
 * ⚠️ Y por eso `impuesto_pct` es **NULL cuando el SKU no vendió en la ventana**, nunca 0: un
 * producto sin venta no es un producto exento. `impuesto_renglones` dice con cuántos renglones
 * se midió y `impuesto_tasas_distintas` avisa cuando el mismo SKU cobró tasas distintas
 * (486 SKUs medidos) — el consumidor decide, la vista no adivina (ADR-056).
 *
 * ── El universo ────────────────────────────────────────────────────────────────────────
 * `U-D-8` (Factura Telemarketing) · `U-D-10` (Ticket) · `U-D-12` (Factura Cont No Fiscal) —
 * el MISMO corte que `mv_kepler_sales_daily` y que `[K.3]`, para que las dos no se contradigan.
 * `U-D-6` queda fuera: re-factura tickets en 93.1 %. `U-D-13` es traspaso.
 */

const VENTANA_DIAS = 30;

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('kepler_ods.kdm2') IS NOT NULL AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta kepler_ods.kdm2 — vista materializada omitida');
    return;
  }

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_standard_cost_activity`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_kepler_standard_cost_activity AS
    WITH ren AS (
      SELECT l.sucursal,
             btrim(l.c8)                                   AS sku,
             l.c9::numeric                                  AS cantidad_base,
             l.c13                                          AS importe_bruto,
             COALESCE(abs(NULLIF(regexp_replace(l.c17::text, '[^0-9.-]', '', 'g'), '')::numeric), 0)
           + COALESCE(abs(NULLIF(regexp_replace(l.c18::text, '[^0-9.-]', '', 'g'), '')::numeric), 0)
                                                            AS tasa
        FROM kepler_ods.kdm2 l
       WHERE l.c2 = 'U' AND l.c3 = 'D' AND l.c4 IN (8, 10, 12)
         AND l.c32::date >= CURRENT_DATE - ${VENTANA_DIAS}
         AND btrim(l.c8) <> ''
    )
    SELECT sucursal,
           sku,
           count(*)::int                                            AS renglones,
           round(sum(cantidad_base), 4)                             AS unidades_base,
           round(sum(importe_bruto), 2)                             AS venta_bruta,
           round(sum(importe_bruto / (1 + tasa / 100.0)), 2)         AS venta_neta,
           mode() WITHIN GROUP (ORDER BY tasa)                      AS impuesto_pct,
           count(DISTINCT tasa)::int                                AS impuesto_tasas_distintas,
           (CURRENT_DATE - ${VENTANA_DIAS})                         AS ventana_desde,
           CURRENT_DATE                                             AS ventana_hasta
      FROM ren
     GROUP BY sucursal, sku`);

  // UNIQUE es requisito de REFRESH ... CONCURRENTLY, no un adorno.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_kepler_std_cost_activity
        ON analytics.mv_kepler_standard_cost_activity (sucursal, sku)`);

  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_standard_cost_activity TO app_runtime`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_standard_cost_activity IS
    $$[CE.0] Actividad de venta por (sucursal, SKU) en ${VENTANA_DIAS} dias, para pesar el costo
    estandar. unidades_base sale de kdm2.c9 (unidad BASE del renglon) y NO de
    mv_kepler_sales_daily.units, que esta en el peldano vendido. impuesto_pct es la MODA de
    |c17|+|c18| observada en el renglon y es NULL sin venta -- sin venta no es exento.
    Refresco: AnalyticsRefreshService (nightly, CONCURRENTLY). Sin refresco la ventana envejece
    y unidades_base deja de ser de 30 dias: mirar analytics.cron_runs.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_standard_cost_activity`);
};
