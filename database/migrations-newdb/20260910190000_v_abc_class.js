/**
 * KE.4 — LA CLASE ABC SE DERIVA, ASÍ DEJA DE LLEGAR TARDE.
 *
 * Edgar (2026-09-10): *"no se puede comprar con una información errónea, si no la compra se hace
 * mal y afecta todo, es por eso que necesitamos implicar la verdad absoluta"*.
 *
 * ── Dos defectos, y el segundo sólo se ve mirando los relojes ───────────────────────────────
 *
 * **(1) La clase era un objeto nulo.** `commercial.abc_classification` calculaba la demanda sobre
 * `commercial.orders` — la tabla de pedidos de la plataforma, con **2 órdenes `fulfilled` en toda
 * su historia** — mientras la venta real son 707,022 celdas / $154.7M en 90 días. Medido en prod:
 * **2 filas clase A y 56,002 clase C con `annual_value` = $0**, y **clase B = 0 en todo el
 * sistema** (un Pareto siempre produce B: ése era el delator).
 *
 * Y esa clase **fija el nivel de servicio de todo el reabasto** (`import-computed-reorder.js`:
 * A=0.98 · B=0.95 · C/sin clase=0.90). Costo medido: **19,127 políticas de sucursal servidas a
 * 0.90**, de las cuales el ABC real dice que 4,467 son A y 5,782 son B.
 *
 * **(2) ⭐ Y aunque estuviera bien, llegaba tarde TODOS LOS DÍAS.** Los `computed_at` de prod:
 *
 * ```text
 * inventory_health ....  09:04:09   <- la demanda
 * reorder_policy ......  09:04:28   <- la CONSUME 19 segundos despues
 * abc_classification ..  09:30:00   <- y la clase se recalcula 26 MINUTOS MAS TARDE
 * ```
 *
 * O sea el reabasto siempre usó la clase **del día anterior**. Mover el cron no lo arregla: el ABC
 * necesita a `inventory_health` (3:04) y el reorden necesita al ABC, y los dos importers corren
 * dentro de la misma cadena con 19 segundos de diferencia. *Ordenar no es depender.*
 *
 * ── La solución es DERIVAR, no reordenar ────────────────────────────────────────────────────
 *
 * La clase no es un dato: es un **Pareto sobre dos tablas que ya existen**. Como vista no puede
 * llegar tarde, porque se calcula cuando se lee. Y queda **una sola definición**: la tabla
 * `commercial.abc_classification` pasa a poblarse `SELECT * FROM` esta vista (para los consumidores
 * que necesitan la foto y su cadencia de conteo cíclico), y `import-computed-reorder.js` lee la
 * **vista**, así que su clase siempre es la de hoy.
 *
 * ── Las dos puntas del producto, probadas ───────────────────────────────────────────────────
 *
 * `annual_value = avg_daily_units × 365 × costo_unitario` sólo es válido si las dos están en la
 * misma unidad y del mismo ERP:
 *
 *   · `inventory_health.avg_daily_units` está en **PIEZAS** — unidad canónica del motor de
 *     reabasto, decidida 2026-07-27 y verificada contra movimientos de compra reales;
 *   · `v_erp_unit_cost.costo_unitario` es `kdik.c16` **por pieza** en Kepler y `costo_promedio`
 *     en la unidad nativa de Wincaja, cada ERP con SU testigo (KE.3).
 *
 * Y es la MISMA demanda que usa el punto de reorden (`import-computed-reorder.js:76`). No es una
 * fuente mejor: es la misma. Si la clase y la σ/ADU vinieran de ventanas distintas, la política
 * sería incoherente consigo misma.
 *
 * ── Medido (prod, 2026-09-10) ───────────────────────────────────────────────────────────────
 *
 * ```text
 * A ...  5,178 filas · $371,867,053    Pareto sano por sucursal: A 15-19%, B 21-27%
 * B ...  7,367 filas ·  $69,675,257
 * C ... 42,756 filas ·  $23,216,311
 * efecto en el colchon: +30,393 pz en A y +6,687 en B = +$1,197,206 de proteccion
 * ```
 *
 * ⚠️ Dos almacenes dan 0 A / 0 B y los dos tienen causa NOMBRADA — no se rellenan:
 *   · **`00` (CEDIS)** no vende, distribuye por traspaso; lo planea `import-network-reorder.js`
 *     con demanda dependiente y servicio 0.98 fijo.
 *   · **`07`** está rezagada en `inventory_health` (0 demanda en 2,617 filas) aunque su venta ya
 *     existe: la cadena `norm→vel` produce hoy 1,337 SKUs con demanda. Se corrige sola en la
 *     próxima corrida. Y aun así arranca con 3 días de historia sobre un divisor de 90.
 *
 * ⚠️ `security_invoker` + `GRANT` van explícitos (lección U.7).
 *
 * @param { import("knex").Knex } knex
 */

const SQL = `
CREATE OR REPLACE VIEW analytics.v_abc_class AS
WITH base AS (
  SELECT ih.tenant_id, ih.warehouse_id, ih.product_id,
         ih.avg_daily_units,
         -- COALESCE a 0 a proposito: la fila tiene que existir igual, porque una fila AUSENTE
         -- llega NULL a un LEFT JOIN y se lee como sana. Lo que la hace honesta es costo_source.
         (ih.avg_daily_units * 365 * COALESCE(uc.costo_unitario, 0))::numeric(16,2) AS annual_value,
         COALESCE(uc.costo_source, 'sin_costo')                                     AS costo_source,
         (uc.tiene_testigo IS TRUE)                                                 AS tiene_testigo
    FROM analytics.inventory_health ih
    LEFT JOIN analytics.v_erp_unit_cost uc
           ON uc.tenant_id = ih.tenant_id AND uc.warehouse_id = ih.warehouse_id
          AND uc.product_id = ih.product_id
), ranked AS (
  SELECT base.*,
         SUM(annual_value) OVER (PARTITION BY tenant_id, warehouse_id
                                 ORDER BY annual_value DESC, product_id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_value,
         NULLIF(SUM(annual_value) OVER (PARTITION BY tenant_id, warehouse_id), 0)  AS total_value
    FROM base
)
SELECT tenant_id, warehouse_id, product_id,
       -- Pareto por share ACUMULADO EXCLUSIVO (el de los items anteriores): el top siempre cae en
       -- A; el item que cruza 80% es el ultimo A. Inclusivo mandaria a C al unico mover de un
       -- almacen (cum = 100%).
       CASE WHEN total_value IS NULL                                  THEN 'C'
            WHEN (cum_value - annual_value) / total_value < 0.80       THEN 'A'
            WHEN (cum_value - annual_value) / total_value < 0.95       THEN 'B'
            ELSE 'C' END                                            AS abc_class,
       annual_value,
       avg_daily_units,
       CASE WHEN total_value IS NULL THEN 1.0
            ELSE round(cum_value / total_value, 4) END              AS value_share,
       costo_source,
       tiene_testigo
  FROM ranked`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  await knex.raw(`ALTER VIEW analytics.v_abc_class SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_abc_class TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_abc_class IS
    'KE.4: la clase ABC DERIVADA (Pareto por almacen sobre inventory_health.avg_daily_units x v_erp_unit_cost.costo_unitario). Es vista y no tabla porque como tabla llegaba TARDE: el reorden la consumia 26 minutos antes de que se recalculara, todos los dias. UNICA definicion: commercial.abc_classification se puebla desde aca y import-computed-reorder.js la lee directo.'`);

  // ── Auto-verificación ──
  const meta = await knex.raw(
    `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_class'`);
  const opts = (meta.rows[0] || {}).reloptions || [];
  if (!opts.some((x) => String(x).includes('security_invoker'))) {
    throw new Error('v_abc_class perdió security_invoker');
  }

  const d = (await knex.raw(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE abc_class = 'A')::int a,
           count(*) FILTER (WHERE abc_class = 'B')::int b,
           count(*) FILTER (WHERE abc_class = 'C')::int c,
           count(*) FILTER (WHERE tiene_testigo)::int testigo,
           round(sum(annual_value) FILTER (WHERE abc_class = 'A'))::numeric va
      FROM analytics.v_abc_class`)).rows[0];

  // ⭐ EL DELATOR, convertido en compuerta: un Pareto SIEMPRE produce clase B. Que B fuera 0 en
  // todo el sistema era la señal de que la fuente estaba vacía, y estuvo a la vista dos meses.
  if (d.b < 1) {
    throw new Error('clase B = 0: un Pareto siempre produce B — la fuente de demanda está vacía');
  }
  if (d.a < 1) throw new Error('clase A = 0: la fuente de demanda está vacía');
  // Y que no se vaya al otro extremo: si "casi todo" es A, el acumulado no está ordenando.
  if (d.a > d.total * 0.40) {
    throw new Error(`clase A = ${d.a} de ${d.total} (>40%): el Pareto no está ordenando`);
  }
  if (d.total < 10000) throw new Error(`v_abc_class trae ${d.total} filas: inventory_health está vacía`);

  console.log(`  [abc-class] ${d.total.toLocaleString('en-US')} filas`
    + ` · A ${d.a.toLocaleString('en-US')} ($${Number(d.va).toLocaleString('en-US')})`
    + ` · B ${d.b.toLocaleString('en-US')} · C ${d.c.toLocaleString('en-US')}`
    + ` · con testigo de costo ${d.testigo.toLocaleString('en-US')}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_abc_class`);
};
