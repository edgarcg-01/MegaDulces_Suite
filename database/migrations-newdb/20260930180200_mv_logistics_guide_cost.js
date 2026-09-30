'use strict';
/**
 * `[CGU.2]` — **`analytics.mv_logistics_guide_cost`: lo que cuesta cada guia, concepto por
 * concepto, diciendo SIEMPRE si la cifra es directa o atribuida y con que ventana se repartio.**
 *
 * ── El hecho incomodo que esta vista no esconde ───────────────────────────────────────
 *
 * ⛔ **El gasto NO existe por guia.** Llega a canal + dia, y medido sobre agosto-2026 hay entre
 * **3.7 y 10.9 guias por canal-dia** (maximo 19). Ademas solo **32 de 11,100 filas (0.3 %)** de
 * gasto mencionan un viaje en su comentario. Por lo tanto **toda cifra por guia es ATRIBUIDA**, y
 * la columna `origen` lo dice en cada fila. Una pantalla que muestre esto como gasto directo
 * miente.
 *
 * ── El reparto (decision del usuario, 2026-09-30) ─────────────────────────────────────
 *
 *     atribuido = gasto_del_bucket x (paradas_de_la_guia / paradas_del_bucket)
 *
 * La unidad es la **PARADA** porque una parada es una entrega, o sea trabajo real: una guia de 19
 * paradas carga 19 veces mas que una de 1. Se descartaron, con motivo: por importe de mercancia
 * (castiga al producto de alto valor, que ocupa menos camion) y por cajas/peso (las lineas vienen
 * en unidades mixtas -- `PAQ`/`PZA`/`KG` y basura como `'500'` -- asi que exigiria el resolvedor
 * ADR-057 y aun asi dejaria ruido).
 *
 * ── ⭐⭐ La ventana del reparto: el defecto que CUADRA y es basura ──────────────────────
 *
 * Repartir un gasto **mensual** entre las guias de **un dia** concentra ~30 dias de costo fijo en
 * las ~3.7 guias de ese dia: esas salen con ROI horrible y las otras ~110 del mes, inflado. **El
 * total cuadra perfecto y cada fila individual es mentira** -- el peor tipo de defecto, porque
 * pasa el candado de cuadre sin despeinarse.
 *
 * Medido en agosto-2026 sobre las cuentas logisticas, hay un salto limpio en el comportamiento:
 *
 *     ARRENDAMIENTO VEHICULAR     4 dias del mes    $102,038
 *     SEGURO VEHICULOS            3 dias             $44,571      -> periodico
 *     GPS                         2 dias             $70,834
 *     COMISIONES DE VENTAS        5 dias            $272,369
 *     ---------------------------------------------------------
 *     COMBUSTIBLE LOGISTICOS     10 dias             $51,654
 *     VIATICOS ENTREGA CLIENTES  13 dias             $30,193      -> diario
 *     COMBUSTIBLES VENTAS        26 dias            $315,243
 *     COMISIONES BANCARIAS       31 dias            $133,392
 *
 * **~$490k = 28 % del gasto del mes se asienta en 5 dias o menos.** Por eso el reparto tiene dos
 * ventanas: `diario` reparte entre las guias del **canal-dia**, `periodico` entre las del
 * **canal-MES**.
 *
 * ⭐ **La periodicidad se MIDE, no se declara en una tabla que nadie mantiene.** Un concepto nuevo
 * se clasifica solo por como se comporta (`count(distinct dia) <= 5`), y la columna viaja en la
 * respuesta para que se pueda auditar. Una tabla de mapa habria que sembrarla, mantenerla, y un
 * concepto nuevo entraria callado con el default.
 *
 * ── Los TRES estados de `origen`, y por que no bastan dos ─────────────────────────────
 *
 *   `directo`        el bucket tiene UNA sola guia -> el gasto es de esa guia, sin repartir.
 *   `atribuido`      se repartio entre N guias; `paradas_guia`/`paradas_bucket`/`n_guias_bucket`
 *                    viajan para que el humano vea con cuanta dilucion se calculo.
 *   `sin_actividad`  hubo gasto y NINGUNA guia en esa ventana. Fila propia, `guia` la nombra.
 *
 * ⭐ **El tercer estado es el que hace que la suma cuadre.** Medido en agosto con reparto diario:
 * gasto de los 3 canales **$934,136.98** = atribuido **$898,552.60** + sin actividad **$35,584.38**.
 * Sin ese renglon se perderian $35,584 y nadie se enteraria, porque un total que no se publica no
 * se puede desmentir.
 *
 * ⚠️ El caso simetrico -- una guia en una ventana SIN gasto -- no produce fila aqui. El consumidor
 * hace LEFT JOIN y debe pintar `NULL` con motivo, **nunca $0.00**: "no se registro gasto" no es
 * "esta guia fue gratis". Y un `COALESCE(costo, 0)` puesto para que no se vea feo produce
 * **ROI infinito** en la pantalla, que es el modo de falla que esta fase existe para evitar.
 *
 * ── El bucket `otros` (decision del usuario) ──────────────────────────────────────────
 *
 * El canal `traspaso` registra en su departamento **$43,313 para mover $18.7 M (0.23 %)**, que es
 * inverosimil: mueve el 64 % de la mercancia con el 4 % del gasto. Su costo real esta disperso en
 * `otros` ($356,165 en agosto). Por decision del usuario ese bucket **se reparte entre los tres
 * canales logisticos**, proporcional a sus paradas, con `fuente = 'otros_admin'` para que sea
 * distinguible del gasto que si trae departamento propio.
 *
 * ⚠️ **Esto NO arregla el traspaso: lo hace explicito.** Hasta que Contabilidad asigne el
 * departamento correcto, el consumidor debe seguir declarando la calidad de ese canal como
 * sospechosa. Repartir un bucket no convierte una suposicion en una medicion.
 *
 * ── Dos fugas que casi se van vivas ───────────────────────────────────────────────────
 *
 * 1. El reparto de `otros` llevaba `WHERE paradas > 0`, y con eso el bucket de una ventana sin
 *    ninguna parada se descartaba en silencio: **$1,608.46 en agosto-2026**. El bloque final del
 *    UNION lo captura. ⛔ Un candado que compare el total de la matview contra *lo repartido*
 *    habria dado verde: hay que compararlo contra **el gasto clasificado de origen**, el unico
 *    testigo que no se mueve con el bug.
 * 2. El cuadre cierra con **~$1.23 de residuo** por redondear ~4,090 filas a 2 decimales. Es
 *    redondeo, no fuga: el candado tolera una banda proporcional a las filas.
 *
 * ── Por que MATERIALIZADA ─────────────────────────────────────────────────────────────
 *
 * Medido contra prod con `EXPLAIN (ANALYZE, BUFFERS)`: la atribucion de UN mes tarda **544 ms** y
 * la actividad sola **464 ms**, con un `Nested Loop` que re-ejecuta el CTE de actividad **618
 * veces**. El gate del proyecto es **<1 s = "no funciona"**.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('analytics.v_logistics_expense_channel') IS NOT NULL
        AND to_regclass('analytics.v_logistics_activity_daily')  IS NOT NULL) AS ok`)).rows;
  if (!ok) throw new Error('[CGU.2] faltan v_logistics_expense_channel / v_logistics_activity_daily');

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_logistics_guide_cost`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_logistics_guide_cost AS
    WITH canales AS (
      -- Los tres canales que mueven guias. 'vecinal' y 'piso_venta' NO embarcan: su gasto es real
      -- pero no tiene guia a la cual atribuirse, y meterlos aqui inventaria un denominador.
      SELECT unnest(ARRAY['cliente', 'carga_ruta', 'traspaso']) AS canal
    ), act AS (
      SELECT a.tenant_id, a.dia, date_trunc('month', a.dia)::date AS mes,
             a.sucursal, a.guia, a.canal, a.paradas
        FROM analytics.v_logistics_activity_daily a
        JOIN canales c ON c.canal = a.canal
    ), periodicidad AS (
      SELECT tenant_id, date_trunc('month', dia)::date AS mes, concepto,
             count(DISTINCT dia)::int AS dias_con_asiento,
             CASE WHEN count(DISTINCT dia) <= 5 THEN 'periodico' ELSE 'diario' END AS periodicidad
        FROM analytics.v_logistics_expense_channel
       GROUP BY 1, 2, 3
    ), otros_bucket AS (
      SELECT g.tenant_id, g.dia, date_trunc('month', g.dia)::date AS mes,
             g.concepto, g.cuenta_mayor, sum(g.gasto) AS gasto
        FROM analytics.v_logistics_expense_channel g
       WHERE g.canal = 'otros'
       GROUP BY 1, 2, 3, 4, 5
    ), paradas_canal_dia AS (
      SELECT tenant_id, dia, canal, sum(paradas)::int AS paradas FROM act GROUP BY 1, 2, 3
    ), paradas_dia_total AS (
      SELECT tenant_id, dia, sum(paradas)::int AS paradas FROM act GROUP BY 1, 2
    ), gasto_otros AS (
      -- El bucket administrativo baja a canal proporcional a las paradas de ese dia.
      SELECT o.tenant_id, o.dia, o.mes, d.canal, o.concepto, o.cuenta_mayor,
             o.gasto * d.paradas::numeric / t.paradas AS gasto
        FROM otros_bucket o
        JOIN paradas_dia_total t ON t.tenant_id = o.tenant_id AND t.dia = o.dia
        JOIN paradas_canal_dia d ON d.tenant_id = o.tenant_id AND d.dia = o.dia
       WHERE t.paradas > 0
    ), gasto AS (
      SELECT g.tenant_id, g.dia, date_trunc('month', g.dia)::date AS mes, g.canal,
             g.concepto, g.cuenta_mayor, g.gasto, 'departamento'::text AS fuente
        FROM analytics.v_logistics_expense_channel g
        JOIN canales c ON c.canal = g.canal
      UNION ALL
      SELECT tenant_id, dia, mes, canal, concepto, cuenta_mayor, gasto, 'otros_admin'::text
        FROM gasto_otros
    ), gasto_marcado AS (
      SELECT g.*, p.periodicidad, p.dias_con_asiento
        FROM gasto g
        JOIN periodicidad p
          ON p.tenant_id = g.tenant_id AND p.mes = g.mes AND p.concepto = g.concepto
    ),
    -- Los dos buckets. El periodico se AGREGA por mes antes de repartir: si no, un concepto que
    -- se asienta 4 veces produciria 4 filas con el mismo grano para la misma guia y el UNIQUE
    -- reventaria (o peor, con otro grano, se contaria 4 veces).
    bucket_diario AS (
      SELECT tenant_id, dia, mes, canal, concepto, cuenta_mayor, fuente, sum(gasto) AS gasto
        FROM gasto_marcado WHERE periodicidad = 'diario'
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    ), bucket_periodico AS (
      SELECT tenant_id, mes, canal, concepto, cuenta_mayor, fuente, sum(gasto) AS gasto
        FROM gasto_marcado WHERE periodicidad = 'periodico'
       GROUP BY 1, 2, 3, 4, 5, 6
    ), den_dia AS (
      SELECT tenant_id, dia, canal, sum(paradas)::int AS paradas, count(*)::int AS n_guias
        FROM act GROUP BY 1, 2, 3
    ), den_mes AS (
      SELECT tenant_id, mes, canal, sum(paradas)::int AS paradas, count(*)::int AS n_guias
        FROM act GROUP BY 1, 2, 3
    )
    -- A) Gasto DIARIO -> se reparte entre las guias del canal-DIA.
    SELECT
      a.tenant_id, a.dia, a.sucursal, a.guia, a.canal,
      b.concepto, b.cuenta_mayor, b.fuente,
      'diario'::text AS ventana,
      a.paradas::int AS paradas_guia,
      d.paradas      AS paradas_bucket,
      d.n_guias      AS n_guias_bucket,
      round((b.gasto * a.paradas / d.paradas)::numeric, 2) AS atribuido,
      CASE WHEN d.n_guias = 1 THEN 'directo' ELSE 'atribuido' END AS origen,
      now() AS computed_at
    FROM bucket_diario b
    JOIN den_dia d ON d.tenant_id = b.tenant_id AND d.dia = b.dia AND d.canal = b.canal
    JOIN act a     ON a.tenant_id = b.tenant_id AND a.dia = b.dia AND a.canal = b.canal
    UNION ALL
    -- B) Gasto PERIODICO -> se reparte entre las guias del canal-MES. La fila se cuelga del dia
    -- de la GUIA, no del dia en que se asento el gasto: el costo fijo pertenece al mes entero.
    SELECT
      a.tenant_id, a.dia, a.sucursal, a.guia, a.canal,
      b.concepto, b.cuenta_mayor, b.fuente,
      'mes'::text,
      a.paradas::int, m.paradas, m.n_guias,
      round((b.gasto * a.paradas / m.paradas)::numeric, 2),
      CASE WHEN m.n_guias = 1 THEN 'directo' ELSE 'atribuido' END,
      now()
    FROM bucket_periodico b
    JOIN den_mes m ON m.tenant_id = b.tenant_id AND m.mes = b.mes AND m.canal = b.canal
    JOIN act a     ON a.tenant_id = b.tenant_id AND a.mes = b.mes AND a.canal = b.canal
    UNION ALL
    -- C) Gasto diario de un canal-DIA sin guias. No se pierde ni se muda de fecha: se declara.
    SELECT
      b.tenant_id, b.dia, '(n/a)'::text, '(canal-dia sin guias)'::text, b.canal,
      b.concepto, b.cuenta_mayor, b.fuente, 'diario'::text,
      0, 0, 0, round(b.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM bucket_diario b
    WHERE NOT EXISTS (SELECT 1 FROM den_dia d
                       WHERE d.tenant_id = b.tenant_id AND d.dia = b.dia AND d.canal = b.canal)
    UNION ALL
    -- D) Gasto periodico de un canal-MES sin guias en todo el mes.
    SELECT
      b.tenant_id, b.mes, '(n/a)'::text, '(canal-mes sin guias)'::text, b.canal,
      b.concepto, b.cuenta_mayor, b.fuente, 'mes'::text,
      0, 0, 0, round(b.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM bucket_periodico b
    WHERE NOT EXISTS (SELECT 1 FROM den_mes m
                       WHERE m.tenant_id = b.tenant_id AND m.mes = b.mes AND m.canal = b.canal)
    UNION ALL
    -- E) El bucket administrativo de un dia en que NINGUN canal tuvo paradas: el filtro
    -- "paradas > 0" del reparto lo descartaba en silencio (1,608.46 medidos en agosto-2026).
    SELECT
      o.tenant_id, o.dia, '(n/a)'::text, '(dia sin guias)'::text, '(sin canal)'::text,
      o.concepto, o.cuenta_mayor, 'otros_admin'::text, 'diario'::text,
      0, 0, 0, round(o.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM otros_bucket o
    LEFT JOIN paradas_dia_total t ON t.tenant_id = o.tenant_id AND t.dia = o.dia
    WHERE COALESCE(t.paradas, 0) = 0
  `);

  // UNIQUE para REFRESH CONCURRENTLY. `fuente` y `ventana` van en el grano: un mismo concepto
  // puede llegar por las dos vias (departamento propio y reparto de otros) y en las dos ventanas.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_logistics_guide_cost
      ON analytics.mv_logistics_guide_cost
         (tenant_id, dia, sucursal, guia, canal, concepto, fuente, ventana)
  `);
  await knex.raw(`
    CREATE INDEX ix_mv_logistics_guide_cost_dia
      ON analytics.mv_logistics_guide_cost (tenant_id, dia)
  `);

  await knex.raw(`GRANT SELECT ON analytics.mv_logistics_guide_cost TO app_runtime`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_logistics_guide_cost IS
    $$[CGU.2] Costo por guia y concepto. TODA cifra es atribuida salvo origen='directo' (el bucket
    tenia una sola guia): el gasto NO existe por guia, llega a canal+dia y hay 3.7 a 10.9 guias por
    canal-dia. Reparto proporcional a PARADAS (decision del usuario). ventana='mes' para los
    conceptos que se asientan en <=5 dias del mes (arrendamiento, seguro, GPS, comisiones = 28% del
    gasto): repartirlos por dia concentraria 30 dias de costo fijo en las 3.7 guias de ese dia, un
    defecto que CUADRA y es basura. origen tiene TRES estados; sin_actividad conserva el gasto de
    una ventana sin guias (35,584.38 en agosto-2026) en vez de perderlo. fuente='otros_admin' marca
    el bucket administrativo repartido; NO convierte al traspaso en medido -- ese canal declara
    43,313 para mover 18.7 MDP y su calidad es sospechosa hasta que Contabilidad asigne el
    departamento. Una guia SIN gasto no produce fila: el consumidor pinta NULL, nunca 0 (un
    COALESCE(costo,0) produce ROI infinito, que es el modo de falla que esta fase evita).$$
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_logistics_guide_cost`);
};
