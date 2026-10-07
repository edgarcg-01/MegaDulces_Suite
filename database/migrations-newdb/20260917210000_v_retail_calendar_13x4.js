/**
 * Fase PV.1 — Calendario comercial 13×4 (el backbone temporal del Presupuesto de Ventas).
 *
 * El molde sale de la ESTRUCTURA del workbook histórico `indicadores 2018 - VENTAS.csv`
 * (no de sus datos). Medido de la propia hoja:
 *   · 52 semanas  S01..S52
 *   · 13 periodos P1..P13, cada uno = 4 semanas exactas   (Pₙ = S(4n-3)..S(4n))
 *   · trimestres  Q1=P1-3 · Q2=P4-6 · Q3=P7-9 · Q4=P10-12 · QF=P13
 *     (verificado con los números de la hoja: QF == P13 al peso; Q4 == P10+P11+P12,
 *      NO incluye P13. QF es el periodo 13 solo — el pico de fin de año.)
 *
 * Vista PURA sobre `generate_series` de fechas → mapea cada `date` a
 * (fiscal_year, semana 1-52, periodo 1-13, trimestre Q1-4/QF). Sin ingesta, cero importer.
 * Es una DIMENSIÓN de tiempo (no lleva tenant_id, no lleva RLS): la usa tanto el real
 * (roll del sell-out diario `analytics.v_sellout_daily`) como el plan (metas de PV.3).
 *
 * ⚠️ DECISIONES DECLARADAS (confirmables con negocio — el Excel sólo codifica S01..S52,
 *    no fechas ni día de inicio de semana):
 *   1. fiscal_year = año CALENDARIO (la hoja rotula por año calendario: 2012, 2013…),
 *      así "2026" == todo el 2026. Cada fecha pertenece a exactamente un fiscal_year.
 *   2. Semana lunes→domingo. S01 arranca el PRIMER LUNES on/after 1-ene del año.
 *      Los 0-6 días entre 1-ene y ese lunes caen en S01 (clamp bajo); los 1-8 días de
 *      cola de diciembre (más allá de S52) caen en S52/P13/QF (clamp alto). Así ninguna
 *      fecha queda huérfana y el año calendario queda cubierto completo — a costa de que
 *      S01 y S52 puedan tener menos/más de 7 días (la reconciliación 364-vs-365 inherente
 *      al 13×4, contenida a los bordes). Si negocio fija otro ancla (p. ej. semana Kepler),
 *      se cambia SÓLO la expresión `fy_first_monday`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_retail_calendar AS
      WITH days AS (
        SELECT g::date AS date
          FROM generate_series(DATE '2010-01-01', DATE '2035-12-31', INTERVAL '1 day') AS g
      ),
      anchored AS (
        SELECT
          date,
          EXTRACT(year FROM date)::int AS fiscal_year,
          -- primer lunes on/after 1-ene del año de la fecha
          (date_trunc('year', date)::date
             + ((8 - EXTRACT(isodow FROM date_trunc('year', date))::int) % 7)) AS fy_first_monday
          FROM days
      ),
      wk AS (
        SELECT
          date, fiscal_year, fy_first_monday,
          CASE
            WHEN date < fy_first_monday THEN 1                                    -- 1-ene..primer lunes-1 → S01
            ELSE LEAST(52, (floor((date - fy_first_monday) / 7.0)::int) + 1)      -- cola de dic → S52
          END AS week_no
          FROM anchored
      )
      SELECT
        date,
        fiscal_year,
        week_no,
        'S' || lpad(week_no::text, 2, '0')       AS week_label,
        ceil(week_no / 4.0)::int                 AS period_no,
        'P' || ceil(week_no / 4.0)::int          AS period_label,
        CASE
          WHEN week_no <= 12 THEN 'Q1'
          WHEN week_no <= 24 THEN 'Q2'
          WHEN week_no <= 36 THEN 'Q3'
          WHEN week_no <= 48 THEN 'Q4'
          ELSE 'QF'
        END                                       AS quarter_label,
        CASE
          WHEN week_no <= 12 THEN 1
          WHEN week_no <= 24 THEN 2
          WHEN week_no <= 36 THEN 3
          WHEN week_no <= 48 THEN 4
          ELSE 5
        END                                       AS quarter_seq,
        (ceil(week_no / 4.0)::int = 13)           AS is_final_period
        FROM wk
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_retail_calendar TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_retail_calendar IS
    'PV.1 — Calendario comercial 13×4 (S01-52 → P1-13 → Q1-4/QF). Estructura del workbook indicadores VENTAS. Dimensión de tiempo pura (generate_series 2010-2035), sin tenant/RLS. Ancla: semana lun-dom, S01 = primer lunes on/after 1-ene; fiscal_year = año calendario; bordes clampados a S01/S52 (declarado, confirmable). QF = P13 standalone (pico fin de año).'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_retail_calendar CASCADE`);
};
