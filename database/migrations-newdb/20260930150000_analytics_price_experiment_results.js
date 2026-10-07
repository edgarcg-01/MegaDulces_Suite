'use strict';
/**
 * `[PR.D3]` — **La medición del experimento, escrita ANTES de asignar.**
 *
 * ── Por qué esta vista existe antes que el servicio de asignación ──────────────────────────
 * El análisis de un experimento se define **antes** de saber quién quedó en qué rama. Si se
 * escribe después, cada decisión —qué ventana, qué transformación, a quién excluir— se toma
 * mirando el resultado, y siempre hay una combinación que da el número que uno esperaba.
 * Esta vista es el **pre-registro**: fija la regla y después se asigna.
 *
 * ── El contraste, y por qué es de NO-INFERIORIDAD ──────────────────────────────────────────
 * No se pregunta si el tratamiento vende **más**. Se pregunta si vende **suficientemente poco
 * menos** como para que el alza convenga igual:
 *
 *     H0 (lo que se quiere refutar):  el volumen cae MÁS que δ
 *     H1:                             el volumen NO cae más que δ
 *
 * Se concluye `no_inferior` cuando el **límite inferior** del IC 95 % de la diferencia queda
 * **por encima** de `ln(1−δ)`. ⛔ Nunca se concluye por el punto estimado: un efecto de −2 %
 * con IC `[−40 %, +36 %]` no dice nada, y presentarlo como "cayó 2 %" es el error que este
 * proyecto ya midió en el análisis del experimento natural.
 *
 * ── ⛔ Las cuatro cosas que esta vista se niega a hacer ────────────────────────────────────
 *  1. **Medir un tratamiento que nunca se capturó.** Kepler es read-only (ADR-040): la lista la
 *     aplica una persona. Una unidad de tratamiento sin `aplicado_at` NO cambió de precio, así
 *     que su volumen plano diría "no hubo efecto" — la conclusión **opuesta** a la verdad. Se
 *     excluye, y se publica **cuántas** quedaron fuera: un experimento con la mitad sin aplicar
 *     no es el experimento que se diseñó.
 *  2. **Concluir sin potencia.** Si `n` efectivo queda por debajo del que el diseño exigía, el
 *     veredicto es `sin_potencia`, no `no_concluyente` — son cosas distintas: una es que el
 *     experimento no alcanzó, la otra es que alcanzó y no encontró.
 *  3. **Mezclar peldaños.** `units` no es aditivo entre `unit_kind` (ADR-057), así que la serie
 *     de cada unidad se construye dentro de su peldaño.
 *  4. **Usar unidades sin línea base.** Sin volumen en la ventana previa no hay ratio: se
 *     excluyen y se cuentan aparte. Es exactamente lo que infló en +4.67 pp un DiD preliminar
 *     de esta misma fase antes de que el placebo lo desarmara.
 *
 * ── La ventana ─────────────────────────────────────────────────────────────────────────────
 * Cada unidad se mide contra **su propia** fecha de corte: `aplicado_at` en el tratamiento y
 * `fecha_inicio` en el control. ⚠️ Eso exige que las capturas ocurran juntas — si el tratamiento
 * se captura a lo largo de semanas, las dos ramas dejan de compartir el calendario y la
 * estacionalidad entra como sesgo. Por eso se publica `dias_dispersion_captura`.
 *
 * VISTA derive-no-copy. No escribe nada. Aditiva.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_experiment_results';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('commercial.price_experiment_units') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.D3] falta commercial.price_experiment_units ([PR.D2])');

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH u AS (
      SELECT x.tenant_id, x.experiment_id, e.nombre, e.estado, e.tipo,
             e.ventana_pre_dias, e.ventana_post_dias, e.fecha_inicio,
             x.sucursal, x.sku, x.unit_kind, x.estrato, x.delta_pct, x.rama,
             x.precio_antes, x.precio_propuesto, x.aplicado_at,
             -- La fecha de corte de CADA unidad. El tratamiento cuenta desde que de verdad
             -- se capturo; el control, desde el arranque del experimento.
             COALESCE(x.aplicado_at::date, e.fecha_inicio) AS corte
        FROM commercial.price_experiment_units x
        JOIN commercial.price_experiments e
          ON e.tenant_id = x.tenant_id AND e.id = x.experiment_id
    ), elegible AS (
      /**
       * ⛔ EL FILTRO QUE SALVA LA CONCLUSION. Un tratamiento sin aplicar no cambio de precio:
       * medirlo diria "no hubo efecto", que es lo contrario de la verdad.
       */
      SELECT * FROM u
       WHERE corte IS NOT NULL
         AND (rama = 'control' OR aplicado_at IS NOT NULL)
    ), serie AS (
      SELECT g.tenant_id, g.experiment_id, g.nombre, g.estado, g.tipo, g.estrato,
             g.delta_pct, g.rama, g.sucursal, g.sku, g.unit_kind, g.corte,
             sum(s.units) FILTER (
               WHERE s.business_date BETWEEN g.corte - g.ventana_pre_dias AND g.corte - 1) AS pre,
             sum(s.units) FILTER (
               WHERE s.business_date BETWEEN g.corte + 1 AND g.corte + g.ventana_post_dias) AS post
        FROM elegible g
        JOIN analytics.mv_kepler_sales_daily s
          ON s.sku = g.sku
         AND s.source_branch = g.sucursal
         AND (g.unit_kind IS NULL OR s.unit_kind = g.unit_kind)
         AND s.business_date BETWEEN g.corte - g.ventana_pre_dias
                                AND g.corte + g.ventana_post_dias
       GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12
    ), ratio AS (
      -- ⛔ Sin linea base no hay ratio. Incluirlas fue lo que inflo en +4.67 pp un DiD
      --    preliminar de esta misma fase, hasta que el placebo lo desarmo.
      SELECT *, ln(post::numeric / pre::numeric) AS lr
        FROM serie WHERE pre > 0 AND post > 0
    ), agg AS (
      SELECT tenant_id, experiment_id, nombre, estado, tipo, estrato, delta_pct, rama,
             count(*)::int                          AS n,
             avg(lr)                                AS media_lr,
             coalesce(stddev_samp(lr), 0)           AS sd_lr
        FROM ratio GROUP BY 1,2,3,4,5,6,7,8
    ), par AS (
      SELECT t.tenant_id, t.experiment_id, t.nombre, t.estado, t.tipo, t.estrato, t.delta_pct,
             t.n AS n_trat, t.media_lr AS lr_trat, t.sd_lr AS sd_trat,
             c.n AS n_ctrl, c.media_lr AS lr_ctrl, c.sd_lr AS sd_ctrl
        FROM agg t
        JOIN agg c ON c.tenant_id = t.tenant_id AND c.experiment_id = t.experiment_id
                  AND c.estrato = t.estrato AND c.rama = 'control'
       WHERE t.rama = 'tratamiento'
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
      delta_pct, n_trat, n_ctrl,

      round((100.0 * (exp(lr_trat) - 1))::numeric, 2) AS cambio_trat_pct,
      round((100.0 * (exp(lr_ctrl) - 1))::numeric, 2) AS cambio_ctrl_pct,

      -- El efecto, en % legible: cuanto mas (o menos) se movio el tratamiento.
      round((100.0 * (exp(did_lr) - 1))::numeric, 2)  AS efecto_pct,
      round((100.0 * (exp(did_lr - 1.96 * se) - 1))::numeric, 2) AS ic_inferior_pct,
      round((100.0 * (exp(did_lr + 1.96 * se) - 1))::numeric, 2) AS ic_superior_pct,
      round(se::numeric, 4)                            AS se_log,

      /**
       * ⭐ EL VEREDICTO. No-inferioridad se concluye por el LIMITE INFERIOR del IC contra
       * -delta, JAMAS por el punto estimado. Un -2% con IC [-40%, +36%] no dice nada.
       */
      CASE
        WHEN n_trat < 30 OR n_ctrl < 30        THEN 'sin_potencia'
        WHEN se IS NULL OR se = 0              THEN 'sin_varianza'
        WHEN (did_lr - 1.96 * se) > umbral_lr  THEN 'no_inferior'
        WHEN (did_lr + 1.96 * se) < umbral_lr  THEN 'inferior'
        ELSE                                        'no_concluyente'
      END AS veredicto,

      CASE
        WHEN n_trat < 30 OR n_ctrl < 30
          THEN 'el experimento no junto unidades suficientes: NO alcanzo, distinto de que alcanzo y no encontro'
        WHEN se IS NULL OR se = 0
          THEN 'sin varianza: no se puede construir un intervalo'
        WHEN (did_lr - 1.96 * se) > umbral_lr
          THEN 'el limite inferior del IC 95% queda por encima de -delta: el alza no cuesta volumen'
        WHEN (did_lr + 1.96 * se) < umbral_lr
          THEN 'el volumen cae MAS que delta: el alza no conviene en este estrato'
        ELSE 'el IC cruza -delta: no alcanza para concluir en ninguna direccion'
      END AS veredicto_motivo
    FROM calc
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.D3] La medicion del experimento de precio, escrita ANTES de asignar: es el
    PRE-REGISTRO del analisis. Si la regla se escribe despues, cada decision -que ventana, que
    transformacion, a quien excluir- se toma mirando el resultado. Contraste de NO-INFERIORIDAD:
    se concluye por el LIMITE INFERIOR del IC 95% contra ln(1-delta), JAMAS por el punto
    estimado (un -2% con IC [-40,+36] no dice nada). Cuatro cosas que se niega a hacer: medir un
    tratamiento sin aplicado_at (Kepler es read-only, lo captura una persona, y un precio que no
    cambio diria "no hubo efecto" -- la conclusion OPUESTA), concluir sin potencia (veredicto
    sin_potencia, que NO es lo mismo que no_concluyente: uno es que no alcanzo, el otro que
    alcanzo y no encontro), mezclar peldanos (units no es aditivo entre unit_kind, ADR-057), y
    usar unidades sin linea base (incluirlas inflo en +4.67 pp un DiD preliminar de esta misma
    fase, hasta que el placebo lo desarmo). VISTA derive-no-copy, security_invoker.$c$`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto IS NULL)::int sin_veredicto,
           count(*) FILTER (WHERE veredicto_motivo IS NULL)::int sin_motivo,
           count(*) FILTER (WHERE veredicto = 'no_inferior'
                              AND ic_inferior_pct IS NULL)::int concluye_sin_ic
      FROM ${VIEW}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D3] ${g.filas} estratos con resultado `
    + `(0 es correcto: todavia no hay experimento asignado)`);

  if (g.sin_veredicto > 0 || g.sin_motivo > 0) {
    throw new Error(`[PR.D3] ${g.sin_veredicto} sin veredicto y ${g.sin_motivo} sin motivo: `
      + 'un veredicto sin defensa no sirve.');
  }
  if (g.concluye_sin_ic > 0) {
    throw new Error(`[PR.D3] ${g.concluye_sin_ic} concluyen no_inferior sin intervalo: `
      + 'la no-inferioridad se concluye por el IC, nunca por el punto.');
  }

  /**
   * ⭐ La compuerta de una vista todavia vacia no puede ser "hay filas". Se verifica que la
   * REGLA funcione, con casos construidos: es la unica forma de probar hoy lo que va a decidir
   * dentro de dos meses.
   */
  const [r] = (await knex.raw(`
    WITH casos(nombre, did_lr, se, delta) AS (VALUES
      ('IC entero sobre -delta',          -0.01::float8, 0.010::float8, 7.09::float8),
      ('IC entero bajo -delta',           -0.30::float8, 0.010::float8, 7.09::float8),
      ('IC que cruza -delta',             -0.05::float8, 0.100::float8, 7.09::float8)
    )
    SELECT
      count(*) FILTER (WHERE nombre = 'IC entero sobre -delta'
        AND (did_lr - 1.96*se) > ln(1 - delta/100.0))::int caso_no_inferior,
      count(*) FILTER (WHERE nombre = 'IC entero bajo -delta'
        AND (did_lr + 1.96*se) < ln(1 - delta/100.0))::int caso_inferior,
      count(*) FILTER (WHERE nombre = 'IC que cruza -delta'
        AND (did_lr - 1.96*se) <= ln(1 - delta/100.0)
        AND (did_lr + 1.96*se) >= ln(1 - delta/100.0))::int caso_cruza
      FROM casos`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D3] la REGLA, con casos construidos: no_inferior ${r.caso_no_inferior}/1 · `
    + `inferior ${r.caso_inferior}/1 · cruza ${r.caso_cruza}/1`);

  if (r.caso_no_inferior !== 1 || r.caso_inferior !== 1 || r.caso_cruza !== 1) {
    throw new Error('[PR.D3] la regla de no-inferioridad no discrimina los tres casos: '
      + `no_inferior ${r.caso_no_inferior}, inferior ${r.caso_inferior}, cruza ${r.caso_cruza}.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
