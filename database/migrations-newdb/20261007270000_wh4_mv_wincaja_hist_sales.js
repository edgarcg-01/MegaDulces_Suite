'use strict';
/**
 * `[WH.4]` — **La venta histórica de Wincaja, materializada. Por COSTO, no por falta de fuente.**
 *
 * `analytics.v_wincaja_hist_sales` (`[WH.2b]`) es la definición correcta y auditable, pero tarda
 * **31–53 s** por consulta: son ~67 M de renglones al otro lado de un FDW y `postgres_fdw` empuja
 * poco agregado. **El gate del proyecto es 500 ms, y una consulta de más de medio segundo no
 * funciona.** Así que se materializa.
 *
 * ⭐ Materializar acá es legítimo y no contradice la regla principal (GOTCHAS §19): lo que se
 * guarda está **derivado de una fuente verificable**, no inventado. El pecado sería materializar
 * un valor sin origen; éste se puede reconstruir en cualquier momento desde la vista.
 *
 * ⭐⭐ **Y es seguro porque el corpus está CERRADO.** Wincaja dejó de ser fuente viva cuando cada
 * sucursal migró a Kepler (`w32` 2026-09-08 · `w30` 2026-09-18 · `w00` 2026-09-30). No va a llegar
 * un ticket más, así que esta matvista **no puede quedar rezagada** — que es la objeción de fondo
 * contra materializar. No necesita cron ni refresco periódico: se refresca si alguien carga más
 * años (los `.7z` de 2009–2016, hoy fuera de alcance por decisión de Edgar).
 *
 * ── Qué se deja afuera, y por qué NO es un filtro silencioso ─────────────────────────────────
 * Entra sólo lo publicable (`cordura = 'ok'` y `fecha_veredicto = 'ok'`). Lo excluido **no
 * desaparece**: vive en `analytics.v_wincaja_hist_descartado`, con su importe y su `documento`,
 * para que se pueda mirar. Son dos clases de basura de origen, ya medidas:
 *   · `fuera_de_rango` — 1 renglón de PH 2025 con `ValorVenta` = $995,263,779,541,730
 *     (`Articulo` 83400, `CantidadRegular` = 207 billones). Dos filas de ~67 M bastaban para que
 *     todo total y toda gráfica de esta fase fueran basura.
 *   · `centinela` / `futuro` — el `2000-01-01` que viene del propio Access (~5,100 tickets) y un
 *     ticket fechado en 2029.
 *
 * ── El grano ────────────────────────────────────────────────────────────────────────────────
 * `(tenant, sucursal, día, artículo, clase)`. Es el mismo grano con el que `analytics.sales_daily`
 * se escribe, así que `[WH.4b]` es un `INSERT … SELECT` directo — pero **la clase se conserva**:
 * sólo `venta_cliente` es venta; `traspaso_interno` y `surtido_ruta` se guardan porque son el
 * historial de abasto interno (vale para logística) y porque borrarlos sería esconder la razón por
 * la que la venta es la que es.
 *
 * ⚠️ `articulo` es el código de Wincaja, **todavía sin casar contra `catalog.products`**. Ese
 * puente es `[WH.3b]` y es el riesgo silencioso que queda abierto: nueve años traen SKUs
 * renombrados, fusionados y dados de baja.
 *
 * Sin RLS (patrón `analytics.*`: tenant explícito en cada consulta).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // El REFRESH inicial escanea ~19 GB por FDW (~10 min medidos por extrapolación: Zamora 43 MB en
  // 1.0 s, La Piedad 1,165 MB en 36.5 s). `WITH NO DATA` para que la migración NO se quede
  // sosteniendo esa transacción: el llenado va aparte y se puede correr cuando convenga.
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_wincaja_hist_sales AS
    SELECT tenant_id,
           sucursal,
           sale_date,
           articulo,
           clase,
           count(DISTINCT documento)::int  AS tickets,
           sum(cantidad)                   AS cantidad,
           sum(valor_venta)                AS valor_venta,
           sum(valor_costo)                AS valor_costo,
           sum(iva)                        AS iva,
           sum(ieps)                       AS ieps
      FROM analytics.v_wincaja_hist_sales
     WHERE cordura = 'ok' AND fecha_veredicto = 'ok'
     GROUP BY 1, 2, 3, 4, 5
    WITH NO DATA`);

  // UNIQUE: hace falta para REFRESH ... CONCURRENTLY, y además es el candado del grano.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_wincaja_hist
    ON analytics.mv_wincaja_hist_sales (tenant_id, sucursal, sale_date, articulo, clase)`);

  // Los dos accesos que la pantalla de compra necesita: la serie de un artículo (globo "Venta por
  // mes") y el barrido de una sucursal por fecha.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_mv_wincaja_hist_articulo
    ON analytics.mv_wincaja_hist_sales (tenant_id, articulo, sucursal, sale_date)
    WHERE clase = 'venta_cliente'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_mv_wincaja_hist_fecha
    ON analytics.mv_wincaja_hist_sales (tenant_id, sucursal, sale_date)`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_wincaja_hist_sales IS
    'WH.4 - Venta historica de Wincaja 2017-2025, agregada a (sucursal, dia, articulo, clase). Materializada POR COSTO: la vista equivalente tarda 31-53 s sobre FDW y el gate del proyecto es 500 ms. Es SEGURO materializarla porque el corpus esta CERRADO (Wincaja dejo de ser fuente viva al migrar cada sucursal a Kepler): no puede quedar rezagada y no necesita cron. Solo entra lo publicable; lo excluido se ve en analytics.v_wincaja_hist_descartado, no se borra. articulo es el codigo de Wincaja, TODAVIA sin casar contra catalog.products (ese puente es WH.3b).'`);

  // ── Lo descartado, a la vista. Barato: son unas pocas filas. ────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_wincaja_hist_descartado AS
    SELECT tenant_id, sucursal, sale_date, articulo, documento, dataset,
           cordura, fecha_veredicto, cantidad, valor_venta
      FROM analytics.v_wincaja_hist_sales
     WHERE cordura <> 'ok' OR fecha_veredicto <> 'ok'`);
  await knex.raw(`ALTER VIEW analytics.v_wincaja_hist_descartado SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_wincaja_hist_descartado IS
    'WH.4 - Lo que la matvista NO publica, con su importe y su documento. Existe para que la exclusion sea DECLARADA y auditable en vez de silenciosa (ADR-056): un peso que desaparece sin que nadie lo note es peor que uno mal clasificado. Hoy: 1 renglon con ValorVenta de 995 billones (PH 2025, Articulo 83400) y los tickets del centinela 2000-01-01 que viene del propio Access.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_wincaja_hist_descartado`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_wincaja_hist_sales`);
};
