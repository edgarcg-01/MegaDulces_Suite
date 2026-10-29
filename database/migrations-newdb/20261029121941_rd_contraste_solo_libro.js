'use strict';
/**
 * `[RD.98]` — **El contraste libro↔motor sólo mira quincenas que tienen LIBRO.**
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-29) ───────────────────────────────────────
 *  · La vista publica **260 filas «sin corrida del motor»**: 238 son del libro (Q1–Q20, origen
 *    `libro`, pagadas) y **22 son de Q21, cuya corrida es del MOTOR** (origen `manual`).
 *  · O sea que la vista llamaba «libro» a cualquier corrida viva. Contrastar Q21 sería medir el
 *    motor contra sí mismo: saldría «cuadra» al peso, y un árbitro que nunca contradice es un
 *    espejo (ADR-059). Y mientras nadie lo corra, esas 22 inflan el «sin medir» con filas que
 *    no tienen con qué medirse.
 *
 * El cambio es una condición en el CTE `lib` (`r.origen = 'libro'`); las columnas de salida no
 * cambian. El servicio (`contrastarAnio` / `contrastarPeriodo`) aplica la misma regla.
 *
 * ── De paso: `analytics.v_rd_route_daily` recupera `security_invoker` ──────────────────────
 * `20261028170837` (RD.95) la recreó con CREATE OR REPLACE sin WITH, y eso REEMPLAZA las
 * opciones: medido 2026-10-29, `reloptions = null` (nació con `security_invoker = true` el
 * 2026-09-07). Hoy no cambia ninguna fila —sus bases (`v_route_sales_lines`, `kepler_ods.kdii`)
 * no tienen RLS y `app_runtime` las lee—, pero la vista corría como su dueño. El `down` NO la
 * quita: deshacer el filtro del contraste no tiene por qué reabrir eso.
 *
 * Idempotente (CREATE OR REPLACE VIEW).
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_rd_commission_contrast';
const TBL = 'commercial.commission_engine_lines';

/** La vista de `20261008130558`, con o sin el filtro de origen. */
const vista = (soloLibro) => `
    CREATE OR REPLACE VIEW ${VIEW} AS
    WITH lib AS (
      SELECT r.period_id, l.*
        FROM commercial.commission_run_lines l
        JOIN commercial.commission_runs r
          ON r.id = l.run_id AND r.deleted_at IS NULL AND r.status <> 'anulado'${soloLibro ? `
         AND r.origen = 'libro'` : ''}
       WHERE l.deleted_at IS NULL AND l.beneficiario = 'chofer'
    ), mot AS (
      SELECT * FROM ${TBL} WHERE beneficiario = 'chofer'
    ), claves AS (
      SELECT tenant_id, period_id, route_code FROM lib
      UNION
      SELECT tenant_id, period_id, route_code FROM mot
    )
    SELECT
      k.tenant_id,
      p.id                       AS period_id,
      p.anio,
      p.period_no,
      to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
      to_char(p.date_to,   'YYYY-MM-DD') AS date_to,
      k.route_code,
      lib.beneficiario_nombre,
      lib.zona,

      lib.venta        AS libro_venta,
      lib.subtotal     AS libro_subtotal,
      lib.pct_aplicado AS libro_pct,
      lib.comision     AS libro_comision,
      lib.bonos        AS libro_bonos,
      lib.nomina_banco AS libro_nomina,
      lib.a_pagar      AS libro_a_pagar,
      lib.motivo_no_pago AS libro_motivo,

      mot.venta        AS motor_venta,
      mot.subtotal     AS motor_subtotal,
      mot.pct_aplicado AS motor_pct,
      mot.comision     AS motor_comision,
      mot.bonos        AS motor_bonos,
      mot.a_pagar      AS motor_a_pagar,
      mot.motivo_no_pago AS motor_motivo,
      mot.dias_con_venta,
      mot.dias_esperados,
      mot.costo_veredicto,
      mot.computed_at,

      CASE WHEN lib.a_pagar IS NULL OR mot.a_pagar IS NULL THEN NULL
           ELSE round(mot.a_pagar - lib.a_pagar, 2) END AS delta_a_pagar,

      CASE
        WHEN mot.route_code IS NULL                          THEN 'sin_corrida_del_motor'
        WHEN lib.route_code IS NULL                          THEN 'solo_el_motor'
        WHEN lib.motivo_no_pago IS NOT NULL
         AND mot.motivo_no_pago IS NOT NULL                  THEN 'ninguno_paga'
        WHEN lib.motivo_no_pago IS NOT NULL                  THEN 'solo_el_motor_paga'
        WHEN mot.motivo_no_pago IS NOT NULL                  THEN 'el_motor_no_paga'
        WHEN abs(mot.a_pagar - lib.a_pagar) <= 1.00          THEN 'cuadra'
        WHEN abs(mot.a_pagar - lib.a_pagar)
             <= abs(NULLIF(lib.a_pagar, 0)) * 0.05           THEN 'difiere_poco'
        ELSE                                                      'difiere'
      END AS veredicto,

      CASE
        WHEN mot.route_code IS NULL                          THEN NULL
        WHEN mot.dias_con_venta IS NULL
          OR mot.dias_esperados IS NULL                      THEN 'cobertura_no_medida'
        WHEN mot.dias_con_venta < mot.dias_esperados         THEN 'faltan_dias_en_la_fuente'
        ELSE                                                      'sin_explicar'
      END AS causa

    FROM claves k
    JOIN commercial.commission_periods p
      ON p.id = k.period_id AND p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
    LEFT JOIN lib ON lib.tenant_id = k.tenant_id AND lib.period_id = k.period_id
                 AND lib.route_code = k.route_code
    LEFT JOIN mot ON mot.tenant_id = k.tenant_id AND mot.period_id = k.period_id
                 AND mot.route_code = k.route_code`;

const COMMENT_ANTES = 'RD.52 - el libro (commission_run_lines de la corrida viva) contra el motor (commission_engine_lines), con veredicto y causa. El veredicto vive SOLO aca. Cinco estados y no dos: "el motor no paga" es el acantilado del tramo y se arregla distinto que "difiere"; promediarlos lo esconde. Lo que no se puede comparar se declara sin_corrida_del_motor, nunca se lee como que cuadra.';
const COMMENT_AHORA = 'RD.52 / RD.98 - el LIBRO (commission_run_lines de la corrida viva con origen = libro) contra el motor (commission_engine_lines), con veredicto y causa. Solo quincenas con libro: una corrida del motor contra el motor seria un espejo. El veredicto vive SOLO aca. Cinco estados y no dos: "el motor no paga" es el acantilado del tramo y se arregla distinto que "difiere". Lo que no se puede comparar se declara sin_corrida_del_motor, nunca se lee como que cuadra.';

async function aplicar(knex, soloLibro, comment) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(vista(soloLibro));
  // ⚠️ Se re-declara: es lo que hace que la vista respete el RLS de quien la lee.
  await knex.raw(`ALTER VIEW ${VIEW} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VIEW} IS ${knex.raw('?', [comment]).toQuery()}`);
}

exports.up = async function up(knex) {
  await aplicar(knex, true, COMMENT_AHORA);
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista y el comentario de `20261008130558`. */
exports.down = async function down(knex) {
  await aplicar(knex, false, COMMENT_ANTES);
};

exports._vista = vista;
