'use strict';
/**
 * `[PR.X2]` — **Qué pasó las veces anteriores que este precio se movió.**
 *
 * ── ⛔ Por qué NO hay una curva de elasticidad ────────────────────────────────────────────
 * El pedido fue *"una linea de como podria afectar nuestro cambio de precio en ventas"*. Eso es
 * la elasticidad, y está declarada `no_existe` en el registro con su medición: **por SKU el error
 * estándar es 0.94** -ruido puro-, y la única agregada que existe es una región Anderson-Rubin de
 * **[−1.415, −0.045]**, un factor **31×** de ancho. A −0.045 un +1 % de precio baja el volumen
 * 0.04 %; a −1.415 lo baja 1.42 %. Elegir un punto de ese rango **es inventar la curva**, y
 * `DESIGN.md` lo prohíbe explícitamente: *"nunca inventar una serie/chart si no hay dato real"*.
 *
 * ⭐ Lo defendible es lo **retrospectivo**: qué pasó con el volumen las veces anteriores. Eso es
 * medición, no predicción — y si sale plano con banda ancha, **ése es el resultado**, y es el
 * argumento para correr el experimento de no-inferioridad que está construido y con 0 filas.
 *
 * ── ⛔⛔ Los CUATRO filtros, cada uno medido, y el que casi me cuesta caro ────────────────
 * La bitácora de precios de Kepler no es una lista de decisiones de precio. Medido sobre 365 d:
 *
 * **1 · El centinela.** 52,001 filas tocan un precio de **≤ $1**. Al mirarlas aparecieron así:
 * ```
 *     CJA  1,734.34 → 0.01           (−100 %)
 *     CJA      0.01 → 1,734.34   (+17,343,300 %)
 * ```
 * Es **la oscilación de precios** -dos escritores alternando- asomando en la bitácora. Un precio
 * de $0.01 no es un precio.
 *
 * **2 · El neto del día.** Un mismo par escribe varias veces el mismo día. Lo que importa es el
 * **neto**: el primer `precio_anterior` contra el último `precio_nuevo`. **15,401 eventos dan
 * NETO CERO** — ida y vuelta, no un cambio.
 *
 * **3 · El recosteo.** 40,140 eventos mueven **menos del 1 %**: son ondas de recálculo del ERP,
 * no decisiones de precio.
 *
 * **4 · La unidad.** ⚠️ **Acá me equivoqué y la medición me corrigió.** Di por hecho que el
 * cambio porcentual sería idéntico en `PAQ`, `CJA`, `PZA` y `KG`, y que deduplicar era tomar
 * cualquiera. Medido: de 130,814 eventos multi-unidad, **31,580 (24 %) difieren en más de 2 pp**,
 * con un spread medio de **12,520 pp**. Tomar "cualquier unidad" habría publicado disparates.
 * Acá se toma **la unidad de mayor precio base** -la más estable- y el spread se **publica**,
 * para que el event-study pueda exigir que las unidades coincidan.
 *
 * ── ⛔ Dos guardas que el repo ya pagó ────────────────────────────────────────────────────
 * · **Excluir lo que no tiene línea base** (`pre > 0 AND post > 0`). Incluirlo infló **+4.67 pp**
 *   un DiD previo de esta misma fase, hasta que el placebo lo desarmó.
 * · **No agregar entre `unit_kind`** (ADR-057): `units` no es aditivo entre peldaños. El volumen
 *   se mide **dentro del peldaño dominante** del par, no sumando peras con cajas.
 *
 * ── ⭐⭐ Y la pre-tendencia se DIBUJA, no se esconde ──────────────────────────────────────
 * Cada evento publica también `lr_pre` — el mismo cociente sobre los 30 días **anteriores** al
 * cambio. Si esa cifra no es plana, las dos ventanas no eran comparables y **la gráfica se
 * autodesmiente**. Eso es información, no un defecto: es exactamente el control que mató el DiD
 * de esta fase la primera vez.
 *
 * @param { import("knex").Knex } knex
 */

const EVENTOS = 'analytics.v_sku_price_events';
const RESP = 'analytics.v_sku_price_response';

/** Debajo de esto no es una decisión de precio, es una onda de recosteo. Medido: 40,140 eventos. */
const MIN_PCT = 1.0;
/** Un precio de $1 o menos es el centinela de la oscilación, no un precio. */
const PISO = 1.0;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const o of ['analytics.v_label_price_changes', 'analytics.mv_kepler_sales_daily']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [o])).rows;
    if (!hay) throw new Error(`[PR.X2] falta ${o}`);
  }

  await knex.raw(`DROP VIEW IF EXISTS ${RESP}`);
  await knex.raw(`DROP VIEW IF EXISTS ${EVENTOS}`);

  // ── 1 · LOS EVENTOS, limpios ────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE VIEW ${EVENTOS}
      WITH (security_invoker = true) AS
    WITH sanos AS (
      -- ⛔ FILTRO 1: fuera el centinela. Un precio de $0.01 no es un precio, es la oscilacion.
      SELECT c.sucursal, c.sku, c.unidad, c.fecha, c.hora, c.nombre,
             c.precio_anterior, c.precio_nuevo
        FROM analytics.v_label_price_changes c
       WHERE c.precio_anterior > ${PISO}
         AND c.precio_nuevo    > ${PISO}
         AND NOT c.es_baja
    ),
    neto AS (
      -- ⛔ FILTRO 2: el NETO del dia. Un par escribe varias veces; lo que importa es de donde
      --    salio y a donde llego, no cada escritura.
      SELECT s.sucursal, s.sku, s.unidad, s.fecha,
             min(s.nombre)                                        AS nombre,
             (array_agg(s.precio_anterior ORDER BY s.hora))[1]     AS p0,
             (array_agg(s.precio_nuevo    ORDER BY s.hora DESC))[1] AS p1,
             count(*)::int                                        AS escrituras
        FROM sanos s
       GROUP BY 1, 2, 3, 4
    ),
    con_pct AS (
      SELECT n.*,
             round((100.0 * (n.p1 - n.p0) / NULLIF(n.p0, 0))::numeric, 3) AS pct
        FROM neto n
       WHERE n.p0 > 0
    ),
    -- ⛔ FILTRO 3: fuera el neto cero (ida y vuelta) y el recosteo sub-1 %.
    reales AS (
      SELECT * FROM con_pct WHERE abs(pct) >= ${MIN_PCT}
    ),
    /**
     * ⛔ FILTRO 4: la unidad. Se toma la de MAYOR precio base -la mas estable- y se publica el
     *    spread entre unidades. Medido: 24 % de los eventos multi-unidad difieren mas de 2 pp,
     *    asi que "tomar cualquiera" habria publicado disparates.
     */
    agrupado AS (
      SELECT sucursal, sku, fecha,
             count(*)::int                                   AS unidades_en_evento,
             round((max(pct) - min(pct))::numeric, 3)         AS spread_pct,
             sum(escrituras)::int                            AS escrituras
        FROM reales GROUP BY 1, 2, 3
    )
    SELECT DISTINCT ON (r.sucursal, r.sku, r.fecha)
      r.sucursal, r.sku, r.fecha, r.nombre,
      r.unidad                                               AS unidad_base,
      r.p0                                                   AS precio_antes,
      r.p1                                                   AS precio_despues,
      r.pct                                                  AS cambio_pct,
      (r.pct > 0)                                            AS es_alza,
      a.unidades_en_evento, a.spread_pct, a.escrituras,
      /**
       * ⭐ El veredicto de la UNIDAD, que decide si este evento sirve para medir. Cuando las
       *    unidades no coinciden no se sabe que hizo el precio, y publicar una cifra igual
       *    seria elegir una al azar.
       */
      CASE
        WHEN a.unidades_en_evento = 1      THEN 'unidad_unica'
        WHEN a.spread_pct <= 2             THEN 'unidades_coinciden'
        ELSE                                    'unidades_discrepan'
      END                                                    AS veredicto_unidad
    FROM reales r
    JOIN agrupado a ON a.sucursal = r.sucursal AND a.sku = r.sku AND a.fecha = r.fecha
    ORDER BY r.sucursal, r.sku, r.fecha, r.p0 DESC
  `);

  await knex.raw(`GRANT SELECT ON ${EVENTOS} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${EVENTOS} IS
    $c$[PR.X2] Los cambios de precio REALES por (sucursal, sku, fecha), desde la bitacora nativa
    de Kepler. Cuatro filtros, cada uno medido sobre 365 dias:
    (1) fuera el centinela -52,001 filas tocan un precio <= $1 y son la OSCILACION de precios
    asomando: CJA 1,734.34 -> 0.01 -> 1,734.34 el mismo dia;
    (2) el NETO del dia, no cada escritura -- 15,401 eventos dan neto cero, ida y vuelta;
    (3) fuera el recosteo sub-1% -- 40,140 eventos son ondas de recalculo del ERP, no decisiones;
    (4) ⚠️ la unidad: se da por hecho que el % seria identico en PAQ/CJA/PZA/KG y la medicion lo
    REFUTO -- 31,580 de 130,814 eventos multi-unidad difieren mas de 2 pp, con spread medio de
    12,520 pp. Se toma la unidad de mayor precio base y el spread se PUBLICA en veredicto_unidad,
    para que quien mida pueda exigir que coincidan.$c$`);

  // ── 2 · EL EVENT-STUDY ──────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE VIEW ${RESP}
      WITH (security_invoker = true) AS
    WITH ev AS (
      SELECT e.* FROM ${EVENTOS} e
       -- Sólo eventos con margen para medir ±60 días dentro de la serie de ventas.
       WHERE e.fecha BETWEEN CURRENT_DATE - 300 AND CURRENT_DATE - 35
         AND e.veredicto_unidad <> 'unidades_discrepan'
         AND abs(e.cambio_pct) >= 2
    ),
    /**
     * ⛔ EL PELDANO DOMINANTE. ADR-057: units NO es aditivo entre unit_kind. Sumar piezas con
     *    cajas produce un "volumen" que no existe. Se elige el peldano que manda por dinero en
     *    el par y el volumen se mide DENTRO de el.
     */
    dom AS (
      SELECT DISTINCT ON (s.source_branch, s.sku)
             s.source_branch AS sucursal, s.sku, s.unit_kind
        FROM analytics.mv_kepler_sales_daily s
       WHERE s.business_date >= CURRENT_DATE - 365 AND s.monto_neto > 0
       GROUP BY s.source_branch, s.sku, s.unit_kind
       ORDER BY s.source_branch, s.sku, sum(s.monto_neto) DESC
    ),
    vent AS (
      SELECT s.source_branch AS sucursal, s.sku, s.business_date AS fecha,
             sum(s.units) AS units, sum(s.monto_neto) AS monto
        FROM analytics.mv_kepler_sales_daily s
        JOIN dom d ON d.sucursal = s.source_branch AND d.sku = s.sku
                  AND d.unit_kind = s.unit_kind
       WHERE s.business_date >= CURRENT_DATE - 365
       GROUP BY 1, 2, 3
    ),
    med AS (
      SELECT e.sucursal, e.sku, e.fecha, e.nombre, e.cambio_pct, e.es_alza,
             e.precio_antes, e.precio_despues, e.veredicto_unidad,
             d.unit_kind,
             -- La ventana POST: [+1, +30]
             COALESCE(sum(v.units) FILTER (
               WHERE v.fecha >  e.fecha AND v.fecha <= e.fecha + 30), 0)  AS vol_post,
             -- La ventana PRE: [−30, −1]
             COALESCE(sum(v.units) FILTER (
               WHERE v.fecha <= e.fecha AND v.fecha >  e.fecha - 30), 0)  AS vol_pre,
             -- ⭐ La ventana del PLACEBO: [−60, −31]. Es el control de pre-tendencia.
             COALESCE(sum(v.units) FILTER (
               WHERE v.fecha <= e.fecha - 30 AND v.fecha > e.fecha - 60), 0) AS vol_pre2,
             count(*) FILTER (
               WHERE v.fecha >  e.fecha AND v.fecha <= e.fecha + 30)::int  AS dias_post,
             count(*) FILTER (
               WHERE v.fecha <= e.fecha AND v.fecha >  e.fecha - 30)::int  AS dias_pre
        FROM ev e
        LEFT JOIN dom d ON d.sucursal = e.sucursal AND d.sku = e.sku
        LEFT JOIN vent v ON v.sucursal = e.sucursal AND v.sku = e.sku
                        AND v.fecha > e.fecha - 60 AND v.fecha <= e.fecha + 30
       GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    )
    SELECT
      m.sucursal, m.sku, m.fecha, m.nombre, m.unit_kind,
      m.precio_antes, m.precio_despues, m.cambio_pct, m.es_alza, m.veredicto_unidad,
      m.vol_pre, m.vol_post, m.vol_pre2, m.dias_pre, m.dias_post,

      -- ⭐ El efecto: ln(volumen_post / volumen_pre). En logaritmo porque los cambios son
      --    multiplicativos y un promedio de razones crudas lo domina el que mas subio.
      CASE WHEN m.vol_pre > 0 AND m.vol_post > 0
           THEN round(ln(m.vol_post / m.vol_pre)::numeric, 4) END        AS lr_post,
      /**
       * ⭐⭐ EL PLACEBO, en la misma fila. Si esto no es ~0, las dos ventanas no eran
       *     comparables y el efecto de arriba NO se puede leer. Es el control que ya mato
       *     una version de esta medicion en esta misma fase.
       */
      CASE WHEN m.vol_pre2 > 0 AND m.vol_pre > 0
           THEN round(ln(m.vol_pre / m.vol_pre2)::numeric, 4) END        AS lr_pre,

      /**
       * ⛔ EL VEREDICTO. sin_linea_base NO es "no hubo efecto": es que no se puede medir.
       *    Meterlas al promedio inflo +4.67 pp un DiD previo de esta fase.
       */
      CASE
        WHEN m.vol_pre  <= 0                       THEN 'sin_linea_base'
        WHEN m.vol_post <= 0                       THEN 'dejo_de_venderse'
        WHEN m.dias_pre < 3 OR m.dias_post < 3     THEN 'muy_pocos_dias'
        WHEN m.vol_pre2 <= 0                       THEN 'sin_placebo'
        ELSE                                            'medible'
      END                                                                AS veredicto,
      CASE
        WHEN m.vol_pre <= 0
          THEN 'no hubo venta en los 30 dias previos: sin linea base no se puede medir un cambio'
        WHEN m.vol_post <= 0
          THEN 'no hubo venta en los 30 dias siguientes: puede ser el precio o puede ser que se agoto'
        WHEN m.dias_pre < 3 OR m.dias_post < 3
          THEN 'menos de 3 dias con venta en alguna ventana: el cociente lo decide un solo dia'
        WHEN m.vol_pre2 <= 0
          THEN 'sin venta entre los dias -60 y -31: no hay con que probar la pre-tendencia'
      END                                                                AS motivo
    FROM med m
  `);

  await knex.raw(`GRANT SELECT ON ${RESP} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${RESP} IS
    $c$[PR.X2] El EVENT-STUDY de los cambios de precio que ya ocurrieron: que paso con el volumen
    las veces anteriores. NO es una prediccion y NO hay curva de elasticidad -- esa senal esta
    declarada no_existe con su medicion: SE de 0.94 por SKU, y la unica agregada es una region
    Anderson-Rubin de [-1.415, -0.045], un factor 31x de ancho. Elegir un punto de ese rango es
    inventar la curva, y DESIGN.md lo prohibe.
    ⭐⭐ Publica lr_pre -el PLACEBO de pre-tendencia- en la MISMA fila que lr_post. Si lr_pre no
    es ~0 las dos ventanas no eran comparables y el efecto no se puede leer; la grafica se
    autodesmiente, que es informacion y no un defecto. Ese control ya mato una version de esta
    medicion en esta misma fase (IC 95% [-48.20, +29.82], t=-0.46).
    ⛔ Dos guardas que el repo ya pago: sin_linea_base NO es "no hubo efecto" -meterlas al
    promedio inflo +4.67 pp un DiD previo-; y el volumen se mide DENTRO del peldano dominante
    porque units no es aditivo entre unit_kind (ADR-057).$c$`);

  // ── Compuertas ──────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const [e] = (await knex.raw(`
    SELECT count(*)::int eventos,
           count(DISTINCT (sucursal, sku))::int pares,
           count(*) FILTER (WHERE veredicto_unidad = 'unidades_discrepan')::int discrepan,
           count(*) FILTER (WHERE es_alza)::int alzas,
           round(min(abs(cambio_pct))::numeric, 2) min_pct,
           -- ⛔ ningun centinela sobrevivio
           count(*) FILTER (WHERE precio_antes <= ${PISO}
                               OR precio_despues <= ${PISO})::int centinelas
      FROM ${EVENTOS}`)).rows;
  const msE = Date.now() - t0;

  const t1 = Date.now();
  const [r] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto = 'medible')::int medibles,
           count(*) FILTER (WHERE veredicto = 'sin_linea_base')::int sin_base,
           count(DISTINCT (sucursal, sku))::int pares,
           count(DISTINCT (sucursal, sku)) FILTER (WHERE veredicto = 'medible')::int pares_medibles,
           round(avg(lr_post) FILTER (WHERE veredicto = 'medible')::numeric, 4) efecto_medio,
           round(avg(lr_pre)  FILTER (WHERE veredicto = 'medible')::numeric, 4) placebo_medio,
           -- ⛔ un efecto publicado sin linea base que lo respalde
           count(*) FILTER (WHERE veredicto = 'sin_linea_base' AND lr_post IS NOT NULL)::int fantasma,
           count(*) FILTER (WHERE veredicto <> 'medible' AND motivo IS NULL)::int mudas
      FROM ${RESP}`)).rows;
  const msR = Date.now() - t1;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.X2] eventos ${e.eventos.toLocaleString()} en ${e.pares.toLocaleString()} `
    + `pares (${msE} ms) · alzas ${e.alzas.toLocaleString()} · unidades que discrepan `
    + `${e.discrepan.toLocaleString()} · cambio minimo ${e.min_pct} %`);
  // eslint-disable-next-line no-console
  console.log(`  · [PR.X2] event-study ${r.filas.toLocaleString()} filas (${msR} ms) · medibles `
    + `${r.medibles.toLocaleString()} en ${r.pares_medibles.toLocaleString()} pares · `
    + `⭐ efecto medio ${r.efecto_medio} · PLACEBO ${r.placebo_medio}`);

  if (e.centinelas > 0) {
    throw new Error(`[PR.X2] ${e.centinelas} eventos con precio <= $${PISO}: el centinela de la `
      + 'oscilacion volvio a colarse.');
  }
  if (Number(e.min_pct) < MIN_PCT) {
    throw new Error(`[PR.X2] hay un cambio de ${e.min_pct} %, por debajo del piso de ${MIN_PCT} %.`);
  }
  if (r.fantasma > 0) {
    throw new Error(`[PR.X2] ${r.fantasma} efectos publicados sin linea base.`);
  }
  if (r.mudas > 0) throw new Error(`[PR.X2] ${r.mudas} veredictos sin motivo.`);
  if (r.medibles === 0) {
    throw new Error('[PR.X2] cero eventos medibles: el event-study no tendria nada que dibujar.');
  }
  /**
   * ⭐ Las que NO tienen linea base tienen que existir. Si dieran cero, el filtro no estaria
   *    separando nada y estarian entrando al promedio -- que es justo lo que inflo +4.67 pp
   *    un DiD previo de esta fase.
   */
  if (r.sin_base === 0) {
    throw new Error('[PR.X2] cero eventos sin linea base: el guard no esta separando nada.');
  }
  if (msE + msR > 20000) {
    throw new Error(`[PR.X2] las dos vistas tardan ${msE + msR} ms.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${RESP}`);
  await knex.raw(`DROP VIEW IF EXISTS ${EVENTOS}`);
};
