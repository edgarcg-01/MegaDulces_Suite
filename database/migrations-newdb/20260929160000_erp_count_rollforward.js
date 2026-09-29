'use strict';
/**
 * [IC.10] analytics.mv_erp_count_rollforward — a dónde se fue la mercancía entre dos conteos.
 *
 * La pantalla de Diferencias mostraba el descuadre contra el saldo del ERP, que arrastra errores
 * viejos. Esto contesta otra pregunta, que es la que se puede accionar:
 *
 *     lo contado en el conteo anterior
 *       + lo que entró  (compra + recepción de traspaso)
 *       − lo que salió  (venta + envío de traspaso)
 *     = lo que DEBERÍA haber
 *   contra lo contado en el conteo siguiente
 *     → la diferencia que los movimientos NO explican = la merma real del período
 *
 * ── ⭐ LA FÓRMULA NO SE ELIGIÓ, SE ARBITRÓ ────────────────────────────────────────────────
 *
 * Hay un árbitro natural y barato: desde el último conteo, los movimientos tienen que llevar a
 * la existencia de HOY (`analytics.v_erp_stock_on_hand`). Se probó doctype por doctype, y sólo
 * se quedó el que SUBE el porcentaje de SKUs exactos. Medido sobre ~150 SKUs por almacén:
 *
 *   contado − U-D-10 + X-A-20                     03:93%  04:83%  05:97%  02:85%  06:54%  01:52%
 *   + U-A-50 (recepción de traspaso)              03:99%  04:99%  05:99%  02:98%  06:57%  01:52%
 *   + U-D-41 (envío de traspaso)          ⭐      03:99%  04:99%  05:100% 02:99%  06:91%  01:66%
 *   + N-A-6 / N-A-25 / N-D-6 / N-D-25             sin cambio — esos traspasos no se usan acá
 *
 * ⛔ **`U-D-5` EMPEORA** (04 de 99% a 85%, 05 de 99% a 81%): es espejo de `U-D-10`, no una venta
 *    aparte. Quedó fuera por medición, no por criterio.
 *
 * ⛔ **Esto contradice a `import-stock-movements.js`, que excluye `U-D-10` a propósito** — y ese
 *    importer NO está mal: para SUMAR movimientos del período la factura evita el doble conteo;
 *    para RECONSTRUIR un saldo la que mueve la existencia es el ticket. Dos usos distintos de la
 *    misma tabla. Por eso esta vista deriva del ODS y no de `analytics.stock_movements` (que
 *    además es ventana rodante de 120 días y mezcla grano Kepler con grano Wincaja).
 *
 * ⚠️ **El `01` se queda en 66% y eso NO se esconde** (`calidad_fuente = 'baja'`). Padre Hidalgo
 *    es el mismo almacén del sobrante de $4.25M que lleva dos hipótesis refutadas: su movimiento
 *    no cierra ni siquiera contra su propia existencia de hoy. Es una pista, no un bug resuelto.
 *
 * ── Por qué MATERIALIZADA, habiendo regla de derive-no-copy ───────────────────────────────
 *
 * Medido: un solo par cuesta **1,965 ms** (ya optimizado a UNA pasada desde 4,255 ms; forzar el
 * orden del join no ayudó: 2,130 ms). `kdm2` son 4.6M filas / 2.1 GB y el período de un par trae
 * ~250,000 líneas de venta. El gate de la casa es <1 s, así que en vivo no entra.
 *
 * Materializar acá es legítimo (GOTCHAS §19: se materializa por COSTO, nunca un valor inventado):
 * hay **13 pares** en todo el histórico y el contenido sólo cambia cuando Kepler hace un conteo
 * nuevo — cada tres meses.
 *
 * ⚠️ **El REFRESH cuesta 389 s (6.5 min), medido — no los ~30 s que estimé.** Va de noche y a esa
 * hora no compite con nadie, pero el número se escribe acá para que nadie lo descubra en caliente.
 * Si algún día molesta, el camino medido NO es partir la consulta (ya se probó: cada CTE por
 * separado cuesta ~24 s y el total se va a media hora si se desfijan) sino un índice sobre
 * `kdm1 (sucursal, (c9::date))` — hoy no existe ninguno por fecha para los géneros N y X.
 *
 * Contenido al 2026-09-29: **26,133 filas · 13 pares · 5 almacenes**, con 8,527 SKUs que cuadran,
 * 5,606 con merma, 4,177 con sobrante y 7,823 que no se volvieron a contar.
 *
 * ⚠️ Una MATVIEW **no soporta RLS ni `security_invoker`** (limitación de Postgres, el mismo
 * motivo por el que `mv_sales_overview_30d` filtra por tenant a mano). Por eso lleva `tenant_id`
 * como columna y **el servicio filtra explícito**.
 *
 * ── Qué es un "evento de conteo" ──────────────────────────────────────────────────────────
 *
 * Umbral **≥ 50 SKUs capturados**, y el corte lo puso el dato: los eventos reales van de 162 a
 * 2,948 SKUs, y el ruido son 3 eventos de 3, 3 y 9 SKUs (recuentos puntuales de la 02 en
 * nov-2025). No hay nada en el medio.
 */

const UMBRAL_SKUS = 50;

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_rollforward');

  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_count_rollforward AS
    WITH cab AS (
      -- Cabeceras del ODS, acotadas a lo que mueve saldo. El ANTI-RÉPLICA es obligatorio: la
      -- sucursal 03 arrastra 220 cabeceras del almacén 02, y sin esto el movimiento de 8ESQ se
      -- mezcla con el de La Piedad. El LIKE conserva los sub-almacenes legítimos (01-006).
      SELECT m.sucursal, m.c1 AS almacen, m.c9::date AS fecha,
             m.c2 AS genero, m.c3 AS naturaleza, m.c4::int AS tipo,
             m.c1 AS k1, m.c2 AS k2, m.c3 AS k3, m.c4 AS k4, m.c5 AS k5, m.c6 AS k6
        FROM kepler_ods.kdm1 m
       WHERE (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         AND (   (m.c2 = 'N' AND m.c3 = 'A' AND m.c4::int = 45)   -- captura del conteo
              OR (m.c2 = 'X' AND m.c3 = 'A' AND m.c4::int = 20)   -- compra recibida
              OR (m.c2 = 'U' AND m.c3 = 'A' AND m.c4::int = 50)   -- recepción de traspaso
              OR (m.c2 = 'U' AND m.c3 = 'D' AND m.c4::int IN (10, 41)))  -- venta / envío
    ),
    -- ⭐ AGREGAR ANTES DE UNIR + MATERIALIZED, y ninguna de las dos es un detalle: sin este GROUP BY el CTE queda con ~4.6M
    -- líneas sueltas y el join por RANGO contra los pares hace un fan-out que no termina ni en
    -- 300 s. Agregado a una fila por (almacén, día, SKU, familia) son 1,019,257 filas y la
    -- pasada entera cuesta 21.5 s.
    --
    -- ⛔ Y va MATERIALIZED porque lin se usa en TRES lugares (eventos, cap, mov). Sin eso el
    -- planificador lo inlinea y lo vuelve a calcular dentro del join por RANGO, o sea una vez
    -- POR PAR: la consulta pasa de ~30 s a no terminar en 420 s. Medido.
    -- (Sin acentos graves en este comentario a proposito: vive dentro de un template literal.)
    --
    -- ⚠️ Por la misma razon van MATERIALIZED **todos** los CTE de abajo. Medido por etapas:
    -- cada uno por separado cuesta ~24 s, pero el CTE base usa cap DOS veces y mov una, y
    -- sin fijarlos el planificador los recalcula una vez por PAR. Con 13 pares, media hora.
    lin AS MATERIALIZED (
      SELECT c.sucursal, c.almacen, c.fecha, c.genero, c.naturaleza, c.tipo,
             btrim(l.c8) AS sku,
             sum(l.c9::numeric) AS qty, max(l.c12::numeric) AS costo
        FROM cab c
        JOIN kepler_ods.kdm2 l
          ON l.sucursal = c.sucursal AND l.c1 = c.k1 AND l.c2 = c.k2 AND l.c3 = c.k3
         AND l.c4 = c.k4 AND l.c5 = c.k5 AND l.c6 = c.k6
       WHERE btrim(l.c8) <> ''
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    ),
    -- Un EVENTO es una captura con suficientes SKUs. Los recuentos de 3 o 9 SKUs no son conteos.
    eventos AS MATERIALIZED (
      SELECT sucursal, almacen, fecha, count(DISTINCT sku)::int AS skus
        FROM lin
       WHERE genero = 'N'
       GROUP BY 1, 2, 3
      HAVING count(DISTINCT sku) >= ${UMBRAL_SKUS}
    ),
    pares AS MATERIALIZED (
      SELECT sucursal, almacen, fecha AS hasta, skus AS skus_hasta,
             lag(fecha) OVER (PARTITION BY sucursal, almacen ORDER BY fecha) AS desde
        FROM eventos
    ),
    par AS MATERIALIZED (SELECT * FROM pares WHERE desde IS NOT NULL),
    -- Lo capturado en cada extremo del par.
    cap AS MATERIALIZED (
      SELECT sucursal, almacen, fecha, sku, sum(qty) AS q, max(costo) AS costo
        FROM lin WHERE genero = 'N' GROUP BY 1, 2, 3, 4
    ),
    -- Los movimientos DENTRO del par: (desde, hasta]. El día del conteo inicial NO cuenta sus
    -- movimientos -- el conteo ya los refleja; el del conteo final SÍ, por el mismo motivo.
    mov AS MATERIALIZED (
      SELECT p.sucursal, p.almacen, p.desde, p.hasta, l.sku,
             sum(l.qty) FILTER (WHERE l.genero = 'X')                        AS compras,
             sum(l.qty) FILTER (WHERE l.genero = 'U' AND l.naturaleza = 'A') AS recibido,
             sum(l.qty) FILTER (WHERE l.genero = 'U' AND l.tipo = 10)        AS vendido,
             sum(l.qty) FILTER (WHERE l.genero = 'U' AND l.tipo = 41)        AS enviado
        FROM par p
        JOIN lin l
          ON l.sucursal = p.sucursal AND l.almacen = p.almacen
         AND l.genero <> 'N'
         AND l.fecha > p.desde AND l.fecha <= p.hasta
       GROUP BY 1, 2, 3, 4, 5
    ),
    base AS MATERIALIZED (
      SELECT p.sucursal, p.almacen, p.desde, p.hasta, p.skus_hasta,
             COALESCE(ci.sku, cf.sku, mv.sku) AS sku,
             ci.q AS contado_inicio,
             cf.q AS contado_fin,
             COALESCE(ci.costo, cf.costo) AS costo_unitario,
             COALESCE(mv.compras, 0)  AS compras,
             COALESCE(mv.recibido, 0) AS recibido,
             COALESCE(mv.vendido, 0)  AS vendido,
             COALESCE(mv.enviado, 0)  AS enviado
        FROM par p
        LEFT JOIN cap ci ON ci.sucursal = p.sucursal AND ci.almacen = p.almacen AND ci.fecha = p.desde
        LEFT JOIN cap cf ON cf.sucursal = p.sucursal AND cf.almacen = p.almacen AND cf.fecha = p.hasta
                        AND cf.sku = ci.sku
        LEFT JOIN mov mv ON mv.sucursal = p.sucursal AND mv.almacen = p.almacen
                        AND mv.desde = p.desde AND mv.hasta = p.hasta AND mv.sku = ci.sku
       WHERE ci.sku IS NOT NULL
    )
    SELECT w.tenant_id,
           w.id            AS warehouse_id,
           w.code          AS warehouse_code,
           w.name          AS warehouse_name,
           b.sucursal      AS kepler_sucursal,
           b.almacen       AS kepler_almacen,
           b.desde, b.hasta,
           (b.hasta - b.desde)::int AS dias,
           b.sku,
           p.id            AS product_id,
           b.contado_inicio, b.compras, b.recibido, b.vendido, b.enviado,
           (b.contado_inicio + b.compras + b.recibido - b.vendido - b.enviado) AS esperado,
           b.contado_fin,
           -- ⛔ NULL, no 0: que el SKU no esté en la captura final significa "no se contó",
           -- que es distinto de "se contó y había cero" (ADR-056).
           CASE WHEN b.contado_fin IS NULL THEN NULL
                ELSE b.contado_fin
                     - (b.contado_inicio + b.compras + b.recibido - b.vendido - b.enviado)
           END AS no_explicado,
           b.costo_unitario,
           CASE WHEN b.contado_fin IS NULL OR b.costo_unitario IS NULL THEN NULL
                ELSE round((b.contado_fin
                     - (b.contado_inicio + b.compras + b.recibido - b.vendido - b.enviado))
                     * b.costo_unitario, 2)
           END AS importe_no_explicado,
           CASE
             WHEN b.contado_fin IS NULL THEN 'no_recontado'
             WHEN abs(b.contado_fin
                  - (b.contado_inicio + b.compras + b.recibido - b.vendido - b.enviado)) < 0.01
               THEN 'cuadra'
             WHEN b.contado_fin
                  < (b.contado_inicio + b.compras + b.recibido - b.vendido - b.enviado)
               THEN 'merma'
             ELSE 'sobrante'
           END AS veredicto
      FROM base b
      JOIN commercial.warehouses w
        ON w.kepler_code = b.sucursal AND w.deleted_at IS NULL
      LEFT JOIN catalog.products p
        ON p.sku = b.sku AND p.tenant_id = w.tenant_id AND p.deleted_at IS NULL`);

  await knex.raw(`CREATE UNIQUE INDEX uq_mv_count_rollforward
    ON analytics.mv_erp_count_rollforward (tenant_id, warehouse_id, desde, hasta, sku)`);
  await knex.raw(`CREATE INDEX ix_mv_count_rollforward_wh
    ON analytics.mv_erp_count_rollforward (tenant_id, warehouse_id, hasta)`);
  await knex.raw('GRANT SELECT ON analytics.mv_erp_count_rollforward TO app_runtime');

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_count_rollforward IS
    'IC.10 - Entre dos conteos fisicos: contado_inicio + compras + recibido - vendido - enviado = esperado, contra contado_fin. Lo que los movimientos NO explican es la merma real del periodo. Los doctypes NO se eligieron: se arbitraron contra v_erp_stock_on_hand agregando uno por uno y quedandose solo con los que SUBEN el % de SKUs exactos (U-D-10 venta, U-D-41 envio, X-A-20 compra, U-A-50 recepcion). U-D-5 quedo FUERA porque EMPEORA: es espejo de U-D-10. Materializada por COSTO medido (1965 ms por par contra gate de 1 s; 14 pares en todo el historico y el dato solo cambia cuando hay conteo nuevo). Una matview no soporta RLS: el servicio filtra por tenant a mano. contado_fin NULL = el SKU no se volvio a contar, que NO es cero.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_rollforward');
};
