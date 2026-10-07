/**
 * `[EXP.1b]` — Las señales del descuadre, por SKU: `analytics.mv_erp_count_line_signals`.
 *
 * ## Qué resuelve
 *
 * La pantalla de Diferencias publica un renglón por línea del ajuste de Kepler y cada uno es un
 * callejón sin salida: SKU, cantidad, costo, importe. Quien la abre ve «+4,645 · $248,600» y no
 * tiene con qué decidir si eso es merma, error de captura, error de valuación o una entrada que
 * nadie bajó del camión. Las piezas que lo explican YA existen en la plataforma — el
 * roll-forward, el historial de descuadre, la demanda, las órdenes de entrada — pero están
 * indexadas por (almacén, fecha) o por (almacén, par de conteos), **nunca por SKU**. No faltan
 * datos: falta la llave.
 *
 * Esta matvista es la llave. Grano: (tenant_id, warehouse_id, fecha, sku).
 *
 * ## ⛔ Por qué una matvista NUEVA y no extender la de IC.12
 *
 * `mv_erp_physical_count_variance` es **por LÍNEA de kdm2** (su unique lleva serie y linea), y un
 * SKU puede aparecer varias veces en el mismo evento. Medido en prod el 2026-09-30:
 *
 *     filas de la matvista de IC.12 ... 22,332   (tipo_evento = conteo)
 *     pares (almacén, fecha, SKU) .... 20,849
 *     filas de MÁS .................... 1,483
 *
 * Pegar una señal por SKU a una fila por línea la duplica, y todo `sum(importe) filter (...)`
 * cuenta de más **sin que nada se vea roto**: los totales siguen siendo plausibles. Es el mismo
 * error que ya costó una medición inflada esta semana (un LEFT JOIN al roll-forward dio 6,852
 * filas sobre un universo de 4,271).
 *
 * ## ⭐ El hallazgo que apareció al bajar al grano del SKU
 *
 * `cantidad` e `importe` vienen **sin signo**; la dirección va en la columna `signo`. Al agrupar
 * por SKU resulta que **504 pares traen los DOS signos el mismo día en el mismo almacén**: el
 * mismo SKU ajustado como sobrante y como faltante a la vez, hasta en 6 folios distintos.
 *
 *     bruto (suma de magnitudes) .... $5,081,362
 *     neto  (suma con signo) ........ $  704,666
 *     se cancela solo ............... $4,376,696
 *
 * Y está **entero en La Piedad (02), entre nov-2025 y ene-2026** — en enero son el **54.3% del
 * descuadre del mes**. Cero en sep-2026. Es consistente con varias sesiones de conteo el mismo
 * día (IC.3 ya había encontrado eventos con 64 folios).
 *
 * ⛔ El `importe` de Kepler **no se corrige** (ADR-040). Se publican los dos: `importe_bruto`
 * cuadra con la pantalla por línea, `importe_neto` es la variación real del SKU, y
 * `signos_mezclados` dice cuándo difieren. El veredicto se calcula sobre el NETO.
 *
 * ## Los testigos, y qué cubre cada uno (medido, no supuesto)
 *
 * | testigo | de dónde | cobertura |
 * |---|---|---|
 * | peldaño del costo | `costo_veredicto` de IC.12 | toda la matvista |
 * | roll-forward      | `mv_erp_count_rollforward`, unido por `hasta = fecha` | 7.9% a 73.7% según el mes |
 * | historial         | `v_sku_count_variance_history` | 100% presente, pero sólo juzga con 2+ conteos |
 * | demanda           | `inventory_health.avg_daily_units` | 86.6% de los pares, 92.9% del dinero |
 * | orden de entrada  | `erp_goods_receipt_lines` ⋈ encabezado | 82.2% tiene una en 180 días |
 *
 * ⭐ El join al roll-forward por `hasta = fecha` se midió y es **1:1** (máximo una fila por par):
 * la trampa de abanico no se dispara. Sin el `hasta = fecha` sí lo haría.
 *
 * ## ⛔ Tres cosas que se midieron y NO se construyeron
 *
 * 1. **La entrada duplicada no aplica acá.** `erp_goods_receipt_dedup` tiene 1,001 recepciones
 *    marcadas y **las 1,001 son de la sucursal 00**; el universo contado son las sucursales
 *    01 a 06. Intersección vacía. Queda escrito para que nadie lo reconstruya.
 * 2. **La demanda no explica nada, y por eso no bloquea nada.** Se probó el umbral contra su
 *    PLACEBO: «la diferencia supera 90 días de venta» dispara en el **16.9% de los sobrantes** y
 *    en el **10.1% de los faltantes**, donde no explica absolutamente nada — razón 1.67x, y la
 *    razón se queda entre 1.5x y 1.75x en TODOS los umbrales probados (30, 90, 180, 365 días).
 *    No hay corte que la vuelva discriminante. Compárese con el peldaño del costo, cuyo placebo
 *    marcó 0 de 8,643 cargas iniciales. Entonces NO entra en la partición de explicaciones: sale
 *    como PISTA (`excede_la_venta`) para ordenar la pila accionable.
 *    ⛔ Y como no explica, tampoco figura en `testigos_faltantes`: un testigo que no puede
 *    producir un veredicto no puede impedir que se emita otro. Esto se corrigió midiendo —
 *    mientras bloqueaba, 2,040 SKUs y $2.04M caían en `no_medido` sin motivo.
 * 3. **`erp_goods_receipt_lines` es una VISTA sin índices**, no una tabla con `ix_erpgrl_sku`.
 *    Unirla por fila la re-evalúa: la consulta pasaba de 1.2 s a más de 120 s. Va dentro de un
 *    CTE `MATERIALIZED`, igual que el historial.
 *
 * ## La partición de explicaciones
 *
 * Se evalúa EN ORDEN y la primera que aplica gana, para que sea una partición y no una bolsa:
 *
 *   1. `costo_de_caja`           el ajuste valuó piezas a precio de caja (IC.12)
 *   2. `movimientos_lo_explican` el roll-forward del período cuadra
 *   3. `merma_sostenida`         el SKU pierde y no se recupera entre conteos
 *   4. `sobra_sostenida`         el SKU sobra y no se corrige
 *   5. `se_compensa`             el descuadre vuelve: es ruido de conteo, no pérdida
 *   6. `sin_explicacion`         se consultó a todos los testigos y ninguno dijo nada. LA PILA.
 *   7. `no_medido`               falta un testigo. ⛔ NO es lo mismo que «no hay causa».
 *
 * Los umbrales de 3/4/5 NO se eligen acá: se LEEN de `v_sku_count_variance_history.patron`, que
 * `[EXP.1a]` bajó a SQL justamente para que exista una sola definición (ver esa migración).
 *
 * Medido en prod, sep-2026: de $8,859,397 brutos, la pila `sin_explicacion` son **818 SKUs y
 * $248,436** — y $3,519,579 quedan declarados como no juzgables, en vez de disfrazados de
 * «sin causa». El testigo que falta casi siempre es el roll-forward o el historial, y el motivo
 * es estructural: un almacén contado UNA sola vez no tiene conteo previo del cual rodar ni
 * segunda observación con la cual llamar a algo reincidente (01 y 06 están en ese caso).
 *
 * ## Refresco
 *
 * Construcción medida: ~50 s. Va en el nocturno con umbral propio en `CRON_JOBS` — sin umbral
 * registrado, `db-health` da verde incondicional (lo midió la Fase VP sobre tres matvistas del
 * sell-out). ⚠️ Depende de `mv_erp_count_rollforward` y de `mv_erp_physical_count_variance`:
 * ORDENAR NO ES DEPENDER, hay que declararlo en `deps`.
 *
 * ⛔ Una matvista no soporta RLS (limitación de Postgres): el `tenant_id` se filtra A MANO en
 * toda consulta que la toque.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const [{ ok, patron }] = (await knex.raw(`
    SELECT (to_regclass('analytics.mv_erp_physical_count_variance') IS NOT NULL
        AND to_regclass('analytics.mv_erp_count_rollforward') IS NOT NULL
        AND to_regclass('analytics.v_sku_count_variance_history') IS NOT NULL
        AND to_regclass('analytics.inventory_health') IS NOT NULL
        AND to_regclass('analytics.erp_goods_receipt_lines') IS NOT NULL) AS ok,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='analytics'
                      AND table_name='v_sku_count_variance_history'
                      AND column_name='patron') AS patron`)).rows;

  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  [EXP.1b] falta alguna fuente — matvista omitida');
    return;
  }
  if (!patron) {
    throw new Error(
      '[EXP.1b] v_sku_count_variance_history no tiene la columna patron: corre antes '
      + '20260930230000_sku_variance_history_patron.js. Recalcular el patron aca crearia la '
      + 'segunda definicion, que es justo lo que esa migracion vino a evitar.');
  }

  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_line_signals');

  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_count_line_signals AS
    WITH base AS (
      -- El grano del SKU. ATENCION: cantidad e importe vienen SIN signo en la matvista de
      -- IC.12; la direccion la lleva la columna signo. Se publican el bruto (cuadra con la
      -- pantalla por linea) y el neto (la variacion real del SKU), mas la bandera de cuando
      -- difieren. El veredicto se calcula sobre el NETO.
      SELECT v.tenant_id, v.warehouse_id, v.warehouse_code, v.kepler_sucursal, v.kepler_almacen,
             v.fecha, v.sku,
             max(v.product_id::text)::uuid                 AS product_id,
             max(v.descripcion)                            AS descripcion,
             max(v.unidad_erp)                             AS unidad_erp,
             count(*)::int                                 AS lineas,
             count(DISTINCT v.folio)::int                  AS folios,
             (count(DISTINCT v.signo) > 1)                 AS signos_mezclados,
             sum(v.cantidad * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END) AS cantidad_neta,
             sum(v.importe  * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END) AS importe_neto,
             sum(v.importe)                                AS importe_bruto,
             bool_or(v.costo_veredicto = 'peldano_arriba') AS peldano_arriba,
             sum(v.importe_en_costo_contado * CASE WHEN v.signo = 'faltante' THEN -1 ELSE 1 END)
               FILTER (WHERE v.costo_veredicto = 'peldano_arriba') AS importe_en_costo_contado
        FROM analytics.mv_erp_physical_count_variance v
       WHERE v.tipo_evento = 'conteo'
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    ),
    hist AS MATERIALIZED (
      -- MATERIALIZED a proposito: la vista escanea kdm1/kdm2 tres veces por dentro y sin esto
      -- se deriva una vez por cada uso. El patron y la retencion se LEEN, no se recalculan
      -- (EXP.1a los bajo a SQL para que haya una sola definicion).
      SELECT * FROM analytics.v_sku_count_variance_history
    ),
    rec AS MATERIALIZED (
      -- erp_goods_receipt_lines es una VISTA sin indices: unirla por fila la re-evalua y la
      -- consulta pasa de 1.2 s a mas de 120 s. Se materializa una vez, acotada a la ventana.
      SELECT h.warehouse_id, l.sku, h.receipt_date, h.folio, l.unidad, l.costo_unitario,
             l.cantidad
        FROM analytics.erp_goods_receipt_lines l
        JOIN analytics.erp_goods_receipts h
          ON h.tenant_id = l.tenant_id AND h.sucursal = l.sucursal AND h.folio = l.folio
       WHERE h.warehouse_id IS NOT NULL
         AND h.receipt_date >= (SELECT min(fecha) FROM base) - 180
         AND h.receipt_date <= (SELECT max(fecha) FROM base)
    ),
    oe AS (
      -- La ULTIMA entrada ANTES del conteo, no la ultima de todas: una recepcion posterior no
      -- puede explicar lo que se conto antes.
      SELECT DISTINCT ON (b.warehouse_id, b.fecha, b.sku)
             b.warehouse_id, b.fecha, b.sku,
             r.receipt_date AS oe_fecha, r.folio AS oe_folio, r.unidad AS oe_unidad,
             r.costo_unitario AS oe_costo_unitario, r.cantidad AS oe_cantidad
        FROM base b
        JOIN rec r ON r.warehouse_id = b.warehouse_id AND r.sku = b.sku
         AND r.receipt_date <= b.fecha AND r.receipt_date >= b.fecha - 180
       ORDER BY b.warehouse_id, b.fecha, b.sku, r.receipt_date DESC, r.folio
    ),
    j AS (
      SELECT b.*,
             rf.veredicto            AS rf_veredicto,
             rf.no_explicado         AS rf_no_explicado,
             rf.importe_no_explicado AS rf_importe_no_explicado,
             hi.veces_contado, hi.veces_descuadro,
             hi.pesos_abs  AS pesos_abs_hist,
             hi.pesos_neto AS pesos_neto_hist,
             hi.retencion, hi.patron,
             ih.avg_daily_units AS demanda_diaria,
             (b.fecha >= current_date - 90) AS demanda_aplicable,
             CASE WHEN ih.avg_daily_units > 0 AND b.fecha >= current_date - 90
                  THEN round(b.cantidad_neta / ih.avg_daily_units, 1) END AS dias_de_venta,
             oe.oe_fecha, oe.oe_folio, oe.oe_unidad, oe.oe_costo_unitario, oe.oe_cantidad
        FROM base b
        -- hasta = fecha: UN roll-forward por renglon, el par que TERMINA en este conteo.
        -- Medido: maximo 1 fila por par. Sin esta igualdad el join abanica.
        LEFT JOIN analytics.mv_erp_count_rollforward rf
          ON rf.tenant_id = b.tenant_id AND rf.warehouse_id = b.warehouse_id
         AND rf.hasta = b.fecha AND rf.sku = b.sku
        LEFT JOIN hist hi
          ON hi.tenant_id = b.tenant_id AND hi.warehouse_id = b.warehouse_id AND hi.sku = b.sku
        LEFT JOIN analytics.inventory_health ih
          ON ih.tenant_id = b.tenant_id AND ih.warehouse_id = b.warehouse_id
         AND ih.product_id = b.product_id
        LEFT JOIN oe
          ON oe.warehouse_id = b.warehouse_id AND oe.fecha = b.fecha AND oe.sku = b.sku
    ),
    k AS (
      SELECT j.*,
             CASE WHEN j.importe_neto > 0 THEN 'sobrante'
                  WHEN j.importe_neto < 0 THEN 'faltante' ELSE 'cuadra' END AS signo,
             -- PISTA, no explicacion: su placebo mide 16.9% en sobrantes contra 10.1% en
             -- faltantes (razon 1.67x, estable en todos los umbrales). Ordena la pila; no la
             -- vacia. La ventana de 90 dias NO es un numero elegido: es la ventana sobre la que
             -- avg_daily_units esta medido (import-inventory-health.js).
             (j.importe_neto > 0 AND j.dias_de_venta > 90) AS excede_la_venta,
             CASE WHEN j.demanda_diaria IS NULL  THEN 'sin_demanda_registrada'
                  WHEN NOT j.demanda_aplicable   THEN 'conteo_anterior_a_la_ventana'
                  WHEN j.demanda_diaria = 0      THEN 'sin_venta_en_90d'
                  ELSE 'medida' END AS demanda_motivo,
             (j.oe_unidad IS NOT NULL AND j.unidad_erp IS NOT NULL
              AND j.oe_unidad IS DISTINCT FROM j.unidad_erp) AS oe_unidad_discrepa,
             -- Solo los testigos que PARTICIPAN en la particion. La demanda no produce ninguna
             -- explicacion, asi que tampoco puede impedir que se emita otra.
             array_remove(ARRAY[
               CASE WHEN j.rf_veredicto IS NULL OR j.rf_veredicto = 'no_recontado'
                    THEN 'rollforward' END,
               CASE WHEN j.veces_contado IS NULL OR j.veces_contado < 2 THEN 'historial' END
             ], NULL) AS testigos_faltantes,
             current_date AS demanda_ventana_hasta
        FROM j
    )
    SELECT k.*,
           CASE WHEN k.peldano_arriba                                 THEN 'costo_de_caja'
                WHEN k.rf_veredicto = 'cuadra'                        THEN 'movimientos_lo_explican'
                WHEN k.veces_contado >= 2 AND k.patron = 'merma'       THEN 'merma_sostenida'
                WHEN k.veces_contado >= 2 AND k.patron = 'sobra'       THEN 'sobra_sostenida'
                WHEN k.veces_contado >= 2 AND k.patron = 'se_compensa' THEN 'se_compensa'
                WHEN cardinality(k.testigos_faltantes) > 0             THEN 'no_medido'
                ELSE 'sin_explicacion' END AS explicacion
      FROM k
  `);

  await knex.raw(`CREATE UNIQUE INDEX ux_erpcls_grano
    ON analytics.mv_erp_count_line_signals (tenant_id, warehouse_id, fecha, sku)`);
  await knex.raw(`CREATE INDEX ix_erpcls_evento
    ON analytics.mv_erp_count_line_signals (tenant_id, warehouse_id, fecha)`);
  await knex.raw(`CREATE INDEX ix_erpcls_sku
    ON analytics.mv_erp_count_line_signals (tenant_id, sku)`);
  await knex.raw(`CREATE INDEX ix_erpcls_explicacion
    ON analytics.mv_erp_count_line_signals (tenant_id, explicacion)`);

  await knex.raw('GRANT SELECT ON analytics.mv_erp_count_line_signals TO app_runtime');

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_count_line_signals IS
    'EXP.1b - Senales del descuadre del conteo fisico, por (almacen, fecha, SKU). Es la LLAVE que faltaba: el roll-forward, el historial, la demanda y las ordenes de entrada existian pero ninguno estaba indexado por SKU. Grano de SKU a proposito: la matvista de IC.12 es por LINEA y trae 1,483 filas de mas sobre el mismo universo. cantidad e importe vienen SIN signo en la fuente, asi que aca se publican importe_bruto (cuadra con la pantalla por linea) e importe_neto (la variacion real); 504 pares traen los dos signos el mismo dia y $4,376,696 se cancelan solos, todos en el almacen 02 entre nov-2025 y ene-2026. explicacion es una PARTICION evaluada en orden; no_medido NO significa que no haya causa, significa que falta un testigo (casi siempre el roll-forward o el historial, porque un almacen contado una sola vez no tiene con que compararse). excede_la_venta es una PISTA, no una explicacion: su placebo dispara en 10.1%% de los faltantes donde no explica nada. La matvista NO soporta RLS: filtrar tenant_id a mano.'`);

  const [{ filas, mezclados, pila, pesos_pila }] = (await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE signos_mezclados)::int AS mezclados,
           count(*) FILTER (WHERE explicacion = 'sin_explicacion')::int AS pila,
           round(sum(abs(importe_neto)) FILTER (WHERE explicacion = 'sin_explicacion'))::bigint
             AS pesos_pila
      FROM analytics.mv_erp_count_line_signals`)).rows;
  // eslint-disable-next-line no-console
  console.log(`[EXP.1b] ${filas} pares · ${mezclados} con signos mezclados · `
    + `pila accionable: ${pila} SKUs / $${pesos_pila}`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function down(knex) {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_count_line_signals');
};
