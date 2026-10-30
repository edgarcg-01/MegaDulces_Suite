'use strict';
/**
 * `[PR.V14]` — **El experimento de precio se lleva solo, salvo escribir en Kepler.**
 *
 * Pedido de Edgar (2026-10-30): *«hagamos que el experimento sea automático»*. Primero todo
 * menos la escritura a Kepler; ésa va después, con su prueba previa y su firma.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-30) ───────────────────────────────────────
 *  · «Aterrizaje .99», asignado el 2026-10-01: 5,842 celdas (2,921 tratamiento / 2,921 control) y
 *    **0 marcadas como aplicadas en 29 días**. La vista de resultados exige `aplicado_at`, que
 *    sólo se llenaba si una persona apretaba un botón por celda: sin eso, no mide nada.
 *  · La lista ya está vieja: en 446 controles y 469 tratamientos el precio de hoy no es el del
 *    1-oct (los precios siguen al costo).
 *  · Hay precios que pelean entre dos escritores: 01/28090 pasó de 44.65 a 44.66 **263 veces** en
 *    29 días, y el regreso a 44.65 ni siquiera queda en la bitácora. Por eso el precio de HOY se
 *    lee de la ficha (`v_kepler_standard_cost.precio_ficha`) y NO del último renglón de la
 *    bitácora, que diría 44.66.
 *  · Las dos ramas se mueven parejo (sin cambio: 2,233 control / 2,248 tratamiento): el sorteo
 *    está bien, y por eso una regla de exclusión SIMÉTRICA no sesga.
 *
 * ── 1 · `v_price_experiment_application`: la aplicación se DETECTA, no se marca ──────────
 * Lee la bitácora de precios de Kepler (`kdpv`, vía `v_label_price_changes`) en la **unidad
 * base** de la ficha (`pv1`, la misma de la que salió `precio_antes`). Una celda queda
 * aplicada el día en que su precio **sube a su aterrizaje** en el modo del experimento, desde
 * el precio que tenía justo antes: `nuevo = fn_precio_aterriza(anterior, modo)`. Así no
 * importa que la lista del 1-oct esté vieja: aterrizar 48.38 en 48.99 cuenta igual que 43.97 en
 * 43.99. Un aterrizaje en una celda de CONTROL es contaminación y se dice.
 * ⚠️ Medido: sacar la unidad de `mv_price_signals.u1_unidad` daba otra cosa (coincide con la
 *    ficha en 298 de 5,841). Y el plan ingenuo tardaba 25 s; con CTE materializados, ~450 ms.
 *
 * ── 2 · `v_price_experiment_results`: el corte, las exclusiones y la espera ──────────────
 * Es el PRE-REGISTRO de `[PR.D3]`. Se modifica ANTES de que exista un solo resultado (0
 * celdas aplicadas): no se ha mirado ningún dato del efecto, que es lo que el pre-registro
 * protege. La regla de decisión (límite inferior del IC contra ln(1−δ), n ≥ 30) NO cambia.
 *  · Corte del tratamiento: la fecha marcada o, si no, la **detectada**.
 *  · Corte del control: `fecha_inicio` si alguien la fijó; si no, el **primer aterrizaje**
 *    detectado del experimento. El experimento arranca solo.
 *  · Fuera, IGUAL en las dos ramas: cualquier otro cambio de precio de la celda dentro de su
 *    ventana [corte − pre, corte + post]. Medir un alza encima de otro movimiento no mide el alza.
 *  · Fuera: los controles contaminados.
 *  · ⛔ Sin veredicto mientras una ventana siga abierta (`en_curso`), y `sin_arrancar` mientras
 *    no haya un solo tratamiento aplicado. Antes, una ventana a medias entraba al cálculo con
 *    menos días de venta y lo sesgaba.
 *
 * ⛔ NO MEDIDO: los cambios que hace el escritor que la bitácora no registra. La ficha de hoy es
 *    el árbitro al leer, pero lo que pasó DENTRO de la ventana sólo se ve si quedó en la bitácora.
 *
 * Vistas derive-no-copy, `security_invoker`. Ninguna tiene dependientes (medido en `pg_depend`).
 * Idempotente (DROP + CREATE).
 *
 * @param { import("knex").Knex } knex
 */

const APLIC = 'analytics.v_price_experiment_application';
const RES = 'analytics.v_price_experiment_results';

/** La detección. Se exporta para que la prueba ejerza ESTE cuerpo y no una copia. */
const cuerpoAplicacion = () => `
    WITH u AS MATERIALIZED (
      SELECT x.tenant_id, x.id AS unit_id, x.experiment_id, x.sucursal, x.sku, x.rama, x.estrato,
             x.precio_antes, x.precio_propuesto, x.aplicado_at, x.aplicado_por,
             e.modo_aterrizaje, e.created_at::date AS asignado_el, e.ventana_pre_dias,
             upper(k.unidad_base) AS unidad, k.precio_ficha AS precio_hoy
        FROM commercial.price_experiment_units x
        JOIN commercial.price_experiments e ON e.tenant_id = x.tenant_id AND e.id = x.experiment_id
        LEFT JOIN analytics.v_kepler_standard_cost k ON k.sucursal = x.sucursal AND k.sku = x.sku
    ), b AS MATERIALIZED (
      -- Sólo las celdas del experimento, desde el inicio de la ventana previa más temprana.
      SELECT l.sucursal, l.sku, l.unidad, l.fecha, l.hora, l.precio_anterior, l.precio_nuevo
        FROM analytics.v_label_price_changes l
       WHERE l.fecha >= (SELECT min(asignado_el - ventana_pre_dias) FROM u)
         AND (l.sucursal, l.sku) IN (SELECT sucursal, sku FROM u)
    ), ch AS (
      SELECT u.unit_id, b.fecha, b.hora, b.precio_nuevo,
             -- ⭐ EL ACTO DEL TRATAMIENTO: el precio sube a su aterrizaje, desde el que tenía.
             (b.fecha >= u.asignado_el
              AND b.precio_nuevo > b.precio_anterior
              AND b.precio_nuevo = analytics.fn_precio_aterriza(b.precio_anterior, u.modo_aterrizaje)
             ) AS es_aterrizaje
        FROM u
        JOIN b ON b.sucursal = u.sucursal AND b.sku = u.sku AND b.unidad = u.unidad
              AND b.fecha >= u.asignado_el - u.ventana_pre_dias
    ), primero AS (
      SELECT DISTINCT ON (unit_id) unit_id, fecha AS aterrizo_el, hora AS aterrizo_hora,
             precio_nuevo AS precio_aterrizado
        FROM ch WHERE es_aterrizaje
       ORDER BY unit_id, fecha, hora
    ), agg AS (
      SELECT ch.unit_id,
             count(*) FILTER (WHERE ch.es_aterrizaje)::int AS aterrizajes,
             count(*) FILTER (WHERE NOT ch.es_aterrizaje AND ch.fecha >= u.asignado_el)::int AS otros_cambios,
             array_agg(DISTINCT ch.fecha) FILTER (WHERE NOT ch.es_aterrizaje) AS fechas_otros_cambios,
             count(*) FILTER (WHERE NOT ch.es_aterrizaje AND p.aterrizo_el IS NOT NULL
                                AND (ch.fecha, coalesce(ch.hora, '')) > (p.aterrizo_el, coalesce(p.aterrizo_hora, '')))::int
               AS cambios_tras_aterrizar
        FROM ch
        JOIN u ON u.unit_id = ch.unit_id
        LEFT JOIN primero p ON p.unit_id = ch.unit_id
       GROUP BY ch.unit_id
    )
    SELECT u.tenant_id, u.unit_id, u.experiment_id, u.sucursal, u.sku, u.rama, u.estrato,
           u.unidad, u.precio_antes, u.precio_propuesto,
           -- El precio de HOY sale de la ficha: la bitácora no registra a los dos escritores.
           u.precio_hoy,
           analytics.fn_precio_aterriza(u.precio_hoy, u.modo_aterrizaje) AS propuesto_hoy,
           p.aterrizo_el, p.precio_aterrizado,
           coalesce(a.aterrizajes, 0)            AS aterrizajes,
           coalesce(a.otros_cambios, 0)          AS otros_cambios,
           coalesce(a.cambios_tras_aterrizar, 0) AS cambios_tras_aterrizar,
           coalesce(a.fechas_otros_cambios, '{}'::date[]) AS fechas_otros_cambios,
           u.aplicado_at, u.aplicado_por,
           coalesce(u.aplicado_at::date, p.aterrizo_el) AS aplicado_efectivo_el,
           CASE WHEN u.aplicado_at IS NOT NULL THEN 'marcada'
                WHEN p.aterrizo_el IS NOT NULL THEN 'bitacora' END AS fuente_aplicacion,
           CASE
             WHEN u.unidad IS NULL OR u.precio_hoy IS NULL THEN 'sin_ficha'
             WHEN u.rama = 'control' AND p.aterrizo_el IS NOT NULL THEN 'contaminada'
             WHEN u.rama = 'control' THEN 'intacta'
             WHEN coalesce(u.aplicado_at::date, p.aterrizo_el) IS NULL THEN 'pendiente'
             WHEN coalesce(a.cambios_tras_aterrizar, 0) > 0
               OR (p.precio_aterrizado IS NOT NULL AND abs(u.precio_hoy - p.precio_aterrizado) >= 0.005)
               THEN 'aplicada_y_movida'
             ELSE 'aplicada'
           END AS estado_celda
      FROM u
      LEFT JOIN agg a ON a.unit_id = u.unit_id
      LEFT JOIN primero p ON p.unit_id = u.unit_id
`;

/** Los resultados. Misma regla de decisión que [PR.D3]; cambia el corte, las exclusiones y la espera. */
const cuerpoResultados = () => `
    WITH ap AS (
      SELECT a.*, e.nombre, e.estado, e.tipo, e.ventana_pre_dias, e.ventana_post_dias,
             e.fecha_inicio, x.unit_kind, x.delta_pct
        FROM ${APLIC} a
        JOIN commercial.price_experiments e ON e.tenant_id = a.tenant_id AND e.id = a.experiment_id
        JOIN commercial.price_experiment_units x ON x.id = a.unit_id
    ), arranque AS (
      SELECT experiment_id,
             min(aplicado_efectivo_el) FILTER (WHERE rama = 'tratamiento') AS primer_aterrizaje
        FROM ap GROUP BY experiment_id
    ), datos AS (
      SELECT max(business_date) AS hasta FROM analytics.mv_kepler_sales_daily
    ), u AS (
      SELECT ap.*, ar.primer_aterrizaje, d.hasta,
             CASE WHEN ap.rama = 'tratamiento' THEN ap.aplicado_efectivo_el
                  ELSE coalesce(ap.fecha_inicio, ar.primer_aterrizaje) END AS corte
        FROM ap
        JOIN arranque ar ON ar.experiment_id = ap.experiment_id
        CROSS JOIN datos d
    ), clasif AS (
      SELECT u.*,
             CASE
               WHEN u.estado_celda = 'sin_ficha' THEN 'sin_ficha'
               WHEN u.estado_celda = 'contaminada' THEN 'contaminada'
               WHEN u.corte IS NULL THEN 'sin_corte'
               -- Igual en las dos ramas: otro movimiento de precio dentro de la ventana.
               WHEN EXISTS (SELECT 1 FROM unnest(u.fechas_otros_cambios) f
                             WHERE f BETWEEN u.corte - u.ventana_pre_dias AND u.corte + u.ventana_post_dias)
                 THEN 'cambio_de_precio_en_ventana'
               WHEN u.corte + u.ventana_post_dias > u.hasta THEN 'en_curso'
               ELSE 'medible'
             END AS situacion
        FROM u
    ), serie AS (
      SELECT g.tenant_id, g.experiment_id, g.estrato, g.rama, g.sucursal, g.sku, g.unit_kind, g.corte,
             sum(s.units) FILTER (
               WHERE s.business_date BETWEEN g.corte - g.ventana_pre_dias AND g.corte - 1) AS pre,
             sum(s.units) FILTER (
               WHERE s.business_date BETWEEN g.corte + 1 AND g.corte + g.ventana_post_dias) AS post
        FROM clasif g
        JOIN analytics.mv_kepler_sales_daily s
          ON s.sku = g.sku
         AND s.source_branch = g.sucursal
         AND (g.unit_kind IS NULL OR s.unit_kind = g.unit_kind)
         AND s.business_date BETWEEN g.corte - g.ventana_pre_dias AND g.corte + g.ventana_post_dias
       WHERE g.situacion = 'medible'
       GROUP BY 1,2,3,4,5,6,7,8
    ), ratio AS (
      -- ⛔ Sin linea base no hay ratio ([PR.D3]: incluirlas inflo +4.67 pp un DiD preliminar).
      SELECT *, ln(post::numeric / pre::numeric) AS lr FROM serie WHERE pre > 0 AND post > 0
    ), agg AS (
      SELECT tenant_id, experiment_id, estrato, rama,
             count(*)::int AS n, avg(lr) AS media_lr, coalesce(stddev_samp(lr), 0) AS sd_lr
        FROM ratio GROUP BY 1,2,3,4
    ), estratos AS (
      SELECT tenant_id, experiment_id, nombre, estado, tipo, estrato, delta_pct,
             count(*) FILTER (WHERE rama = 'tratamiento' AND aplicado_efectivo_el IS NOT NULL)::int AS n_trat_aplicadas,
             count(*) FILTER (WHERE rama = 'tratamiento' AND aplicado_efectivo_el IS NULL)::int     AS n_trat_pendientes,
             count(*) FILTER (WHERE situacion = 'en_curso')::int                                    AS n_en_curso,
             count(*) FILTER (WHERE situacion = 'cambio_de_precio_en_ventana')::int                 AS n_excluidas_cambio_precio,
             count(*) FILTER (WHERE situacion = 'contaminada')::int                                 AS n_ctrl_contaminadas,
             min(primer_aterrizaje)                                                                 AS arranque,
             max(corte + ventana_post_dias)                                                         AS ventana_cierra
        FROM clasif
       GROUP BY tenant_id, experiment_id, nombre, estado, tipo, estrato, delta_pct
    ), par AS (
      SELECT s.*,
             t.n AS n_trat, t.media_lr AS lr_trat, t.sd_lr AS sd_trat,
             c.n AS n_ctrl, c.media_lr AS lr_ctrl, c.sd_lr AS sd_ctrl
        FROM estratos s
        LEFT JOIN agg t ON t.experiment_id = s.experiment_id AND t.estrato = s.estrato AND t.rama = 'tratamiento'
        LEFT JOIN agg c ON c.experiment_id = s.experiment_id AND c.estrato = s.estrato AND c.rama = 'control'
    ), calc AS (
      SELECT p.*,
             (p.lr_trat - p.lr_ctrl) AS did_lr,
             sqrt(p.sd_trat * p.sd_trat / NULLIF(p.n_trat, 0)
                + p.sd_ctrl * p.sd_ctrl / NULLIF(p.n_ctrl, 0)) AS se,
             ln(1 - p.delta_pct / 100.0) AS umbral_lr
        FROM par p
    )
    SELECT
      tenant_id, experiment_id, nombre, estado, tipo, estrato,
      delta_pct, coalesce(n_trat, 0) AS n_trat, coalesce(n_ctrl, 0) AS n_ctrl,
      round((100.0 * (exp(lr_trat) - 1))::numeric, 2) AS cambio_trat_pct,
      round((100.0 * (exp(lr_ctrl) - 1))::numeric, 2) AS cambio_ctrl_pct,
      round((100.0 * (exp(did_lr) - 1))::numeric, 2)  AS efecto_pct,
      round((100.0 * (exp(did_lr - 1.96 * se) - 1))::numeric, 2) AS ic_inferior_pct,
      round((100.0 * (exp(did_lr + 1.96 * se) - 1))::numeric, 2) AS ic_superior_pct,
      round(se::numeric, 4)                            AS se_log,
      /**
       * ⭐ EL VEREDICTO. La regla de [PR.D3] no cambia; se le anteponen dos estados que impiden
       * concluir antes de tiempo.
       */
      CASE
        WHEN n_trat_aplicadas = 0              THEN 'sin_arrancar'
        WHEN n_en_curso > 0                    THEN 'en_curso'
        WHEN coalesce(n_trat, 0) < 30 OR coalesce(n_ctrl, 0) < 30 THEN 'sin_potencia'
        WHEN se IS NULL OR se = 0              THEN 'sin_varianza'
        WHEN (did_lr - 1.96 * se) > umbral_lr  THEN 'no_inferior'
        WHEN (did_lr + 1.96 * se) < umbral_lr  THEN 'inferior'
        ELSE                                        'no_concluyente'
      END AS veredicto,
      CASE
        WHEN n_trat_aplicadas = 0
          THEN 'todavia no se aplico ningun precio del tratamiento en Kepler: el experimento no ha empezado'
        WHEN n_en_curso > 0
          THEN n_en_curso || ' celdas con la ventana abierta; el veredicto sale cuando cierre la ultima ('
               || to_char(ventana_cierra, 'YYYY-MM-DD') || ')'
        WHEN coalesce(n_trat, 0) < 30 OR coalesce(n_ctrl, 0) < 30
          THEN 'el experimento no junto unidades suficientes: NO alcanzo, distinto de que alcanzo y no encontro'
        WHEN se IS NULL OR se = 0
          THEN 'sin varianza: no se puede construir un intervalo'
        WHEN (did_lr - 1.96 * se) > umbral_lr
          THEN 'el limite inferior del IC 95% queda por encima de -delta: el alza no cuesta volumen'
        WHEN (did_lr + 1.96 * se) < umbral_lr
          THEN 'el volumen cae MAS que delta: el alza no conviene en este estrato'
        ELSE 'el IC cruza -delta: no alcanza para concluir en ninguna direccion'
      END AS veredicto_motivo,
      n_trat_aplicadas, n_trat_pendientes, n_en_curso, n_excluidas_cambio_precio,
      n_ctrl_contaminadas, arranque, ventana_cierra
    FROM calc
`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const obj of ['commercial.price_experiment_units', 'commercial.price_experiments',
    'analytics.v_kepler_standard_cost', 'analytics.v_label_price_changes',
    'analytics.mv_kepler_sales_daily']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [obj])).rows;
    if (!hay) throw new Error(`[PR.V14] falta ${obj}`);
  }

  await knex.raw(`DROP VIEW IF EXISTS ${RES}`);
  await knex.raw(`DROP VIEW IF EXISTS ${APLIC}`);
  await knex.raw(`CREATE VIEW ${APLIC} WITH (security_invoker = true) AS ${cuerpoAplicacion()}`);
  await knex.raw(`CREATE VIEW ${RES} WITH (security_invoker = true) AS ${cuerpoResultados()}`);
  await knex.raw(`GRANT SELECT ON ${APLIC} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON ${RES} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${APLIC} IS
    $c$[PR.V14] La aplicacion del experimento de precio, DETECTADA en la bitacora de Kepler (kdpv) en
    la unidad base de la ficha: una celda queda aplicada el dia en que su precio sube a su
    aterrizaje desde el que tenia (nuevo = fn_precio_aterriza(anterior, modo)). Un aterrizaje en
    un control es contaminacion. El precio de HOY sale de la ficha, no de la bitacora: la
    bitacora no registra a los dos escritores (01/28090: 263 cambios 44.65->44.66 en 29 dias y
    ningun regreso). aplicado_at marcado a mano sigue valiendo y gana sobre lo detectado.$c$`);
  await knex.raw(`COMMENT ON VIEW ${RES} IS
    $c$[PR.D3/V14] El PRE-REGISTRO del experimento de precio. Regla de decision sin cambios: el
    LIMITE INFERIOR del IC 95% contra ln(1-delta), n>=30. [PR.V14] (modificado con 0 celdas
    aplicadas, sin haber visto un solo dato del efecto): el corte del tratamiento sale de la
    deteccion; el del control, del primer aterrizaje; fuera, IGUAL en las dos ramas, toda celda
    con otro cambio de precio dentro de su ventana, y los controles contaminados; sin veredicto
    mientras una ventana siga abierta (en_curso) o no haya tratamiento aplicado (sin_arrancar).$c$`);

  // ── Los candados ─────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT (SELECT count(*)::int FROM commercial.price_experiment_units) AS unidades,
           count(*)::int AS filas,
           count(*) FILTER (WHERE estado_celda = 'sin_ficha')::int AS sin_ficha,
           count(*) FILTER (WHERE rama = 'control' AND fuente_aplicacion IS NOT NULL
                              AND estado_celda <> 'contaminada')::int AS control_aplicado_no_contaminado,
           count(*) FILTER (WHERE estado_celda IS NULL)::int AS sin_estado
      FROM ${APLIC}`)).rows;
  // eslint-disable-next-line no-console
  console.log(`  · [PR.V14] ${g.filas} celdas leidas de ${g.unidades} · sin ficha ${g.sin_ficha}`);
  if (g.filas !== g.unidades) throw new Error(`[PR.V14] la deteccion leyo ${g.filas} celdas de ${g.unidades}: el join duplico o perdio.`);
  if (g.sin_estado > 0) throw new Error(`[PR.V14] ${g.sin_estado} celdas sin estado.`);
  if (g.unidades > 0 && g.sin_ficha > g.unidades * 0.1) {
    throw new Error(`[PR.V14] ${g.sin_ficha} de ${g.unidades} celdas sin ficha: la deteccion no ve su unidad.`);
  }
  if (g.control_aplicado_no_contaminado > 0) throw new Error('[PR.V14] un control con aplicacion no quedo como contaminado.');

  /**
   * ⭐ LA REGLA DEL ACTO, con casos construidos: el día que alguien capture, ésta es la línea que
   *    decide si cuenta. Un movimiento de centavos, una baja o un alza que no aterriza NO cuentan.
   */
  const [r] = (await knex.raw(`
    WITH casos(nombre, anterior, nuevo, esperado) AS (VALUES
      ('aterriza 44.65 en 44.99',          44.65::numeric, 44.99::numeric, true),
      ('aterriza 29.20 en 29.99',          29.20, 29.99, true),
      ('el centavo del costo 44.65->44.66', 44.65, 44.66, false),
      ('una baja 44.99->44.65',             44.99, 44.65, false),
      ('un alza que no aterriza 29.20->31.00', 29.20, 31.00, false))
    SELECT count(*) FILTER (WHERE (nuevo > anterior AND nuevo = analytics.fn_precio_aterriza(anterior, '99')) = esperado)::int aciertos,
           count(*)::int casos
      FROM casos`)).rows;
  // eslint-disable-next-line no-console
  console.log(`  · [PR.V14] la regla del acto: ${r.aciertos}/${r.casos} casos construidos`);
  if (r.aciertos !== r.casos) throw new Error(`[PR.V14] la regla del aterrizaje falla ${r.casos - r.aciertos} de ${r.casos} casos construidos.`);

  const [v] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto IS NULL OR veredicto_motivo IS NULL)::int sin_veredicto,
           count(*) FILTER (WHERE veredicto IN ('no_inferior','inferior','no_concluyente')
                              AND (n_en_curso > 0 OR n_trat_aplicadas = 0))::int concluye_antes_de_tiempo
      FROM ${RES}`)).rows;
  // eslint-disable-next-line no-console
  console.log(`  · [PR.V14] ${v.filas} estratos con resultado`);
  if (v.sin_veredicto > 0) throw new Error(`[PR.V14] ${v.sin_veredicto} estratos sin veredicto o sin motivo.`);
  if (v.concluye_antes_de_tiempo > 0) throw new Error(`[PR.V14] ${v.concluye_antes_de_tiempo} estratos concluyen con ventanas abiertas o sin arrancar.`);
};

/** Vuelve a la vista de resultados de [PR.D3] no se puede sin su cuerpo: se deja documentado. */
exports.down = async function down(knex) {
  void knex;
};

exports._cuerpoAplicacion = cuerpoAplicacion;
exports._cuerpoResultados = cuerpoResultados;
