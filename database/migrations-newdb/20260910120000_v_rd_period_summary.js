/**
 * [RD.10] `analytics.v_rd_period_summary` — UNA fila por ruta × quincena, que es el grano
 * con el que se opera y se paga la Ruta Directa.
 *
 * ── POR QUÉ UNA VISTA Y NO UN JOIN EN EL FRONT ───────────────────────────────────────────
 * La pantalla maestra necesita, para una quincena, la venta + el costo + el gasto de flota +
 * el odómetro + el $/km + la comisión, todo en la misma fila. Eso vive hoy en tres objetos
 * distintos (`v_rd_route_daily`, `v_route_operation_period`, `commission_run_lines`). Armarlo
 * en el navegador serían tres viajes que pueden traer periodos distintos y un total que no
 * cuadra con ninguna de sus partes. Se compone acá, una vez.
 *
 * Es **derive-no-copy**: no hay tabla nueva ni importer. Las tres piernas ya existen; esto
 * sólo las pone en la misma fila y **declara lo que falta en cada una** en vez de rellenarlo.
 *
 * ── LO QUE LA VISTA NO HACE ──────────────────────────────────────────────────────────────
 *  · No inventa la comisión: si la quincena todavía no tiene corrida, `a_pagar` es NULL y
 *    `comision_status` dice `sin_corrida`. El motor calcula cuando un humano lo pide (ADR-016).
 *  · No rellena el $/km sin ficha (rutas 28, 321, 322) ni el km de una lectura rota: arrastra
 *    `costo_status` y `km_status` tal como los publica `v_route_operation_period`.
 *  · No elige entre las dos formas del subtotal: arrastra `subtotal_origen` (ADR-056).
 *
 * ⚠️ El universo de rutas sale de `commission_route_config`, NO de la venta: una ruta que no
 * vendió en la quincena tiene que aparecer igual, con su motivo. Si se derivara de la venta,
 * "no vendió" y "no existe" se leerían igual.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_rd_period_summary WITH (security_invoker = true) AS
    WITH periodo AS (
      SELECT id, tenant_id, anio, period_no, date_from, date_to, pay_date
        FROM commercial.commission_periods
       WHERE deleted_at IS NULL
    ), ruta AS (
      -- El universo son las rutas configuradas, no las que vendieron.
      SELECT c.tenant_id, c.route_code, c.chofer_nombre, c.supervisor_nombre, c.zona
        FROM commercial.commission_route_config c
       WHERE c.deleted_at IS NULL AND c.activo
    ), venta AS (
      SELECT d.tenant_id, d.route_code, p.id AS period_id,
             round(sum(d.subtotal)::numeric, 2)                    AS subtotal,
             round(sum(d.venta)::numeric, 2)                       AS venta,
             round(sum(d.costo)::numeric, 2)                       AS costo,
             count(DISTINCT d.business_date)::int                  AS dias_con_venta,
             sum(d.tickets)::int                                   AS tickets,
             -- Si en la quincena convivieron las dos formas del subtotal, se dice; no se elige.
             CASE WHEN count(DISTINCT d.subtotal_origen) > 1 THEN 'mixto'
                  ELSE max(d.subtotal_origen) END                  AS subtotal_origen,
             CASE WHEN count(DISTINCT d.costo_status) > 1 THEN 'mixto'
                  ELSE max(d.costo_status) END                     AS costo_origen
        FROM analytics.v_rd_route_daily d
        JOIN periodo p
          ON p.tenant_id = d.tenant_id AND d.business_date BETWEEN p.date_from AND p.date_to
       GROUP BY 1, 2, 3
    ), oper AS (
      SELECT o.tenant_id, o.route_code, p.id AS period_id,
             o.km_inicial, o.km_final, o.km_recorridos, o.km_status,
             o.litros, o.gasto_combustible, o.gasto_total, o.docs,
             o.costo_por_litro, o.km_por_litro,
             o.costo_fijo_por_km, o.costo_operacion, o.costo_por_km, o.costo_status
        FROM analytics.v_route_operation_period o
        JOIN periodo p
          ON p.tenant_id = o.tenant_id AND p.anio = o.anio AND p.period_no = o.period_no
    ), com AS (
      -- La corrida vigente de la quincena (la última no anulada). Si no hay, todo NULL.
      SELECT DISTINCT ON (l.tenant_id, r.period_id, l.route_code)
             l.tenant_id, r.period_id, l.route_code,
             r.status                                              AS run_status,
             l.pct_aplicado, l.comision, l.bonos, l.nomina_banco, l.a_pagar, l.motivo_no_pago
        FROM commercial.commission_run_lines l
        JOIN commercial.commission_runs r
          ON r.id = l.run_id AND r.tenant_id = l.tenant_id AND r.deleted_at IS NULL
       WHERE l.deleted_at IS NULL AND l.beneficiario = 'chofer' AND r.status <> 'anulado'
       ORDER BY l.tenant_id, r.period_id, l.route_code, r.created_at DESC
    )
    SELECT
      r.tenant_id,
      p.id            AS period_id,
      p.anio,
      p.period_no,
      p.date_from,
      p.date_to,
      p.pay_date,
      r.route_code,
      r.zona,
      r.chofer_nombre,
      r.supervisor_nombre,

      v.subtotal, v.venta, v.costo, v.dias_con_venta, v.tickets,
      v.subtotal_origen, v.costo_origen,
      CASE WHEN v.subtotal > 0 AND v.costo IS NOT NULL
           THEN round(((v.subtotal - v.costo) / v.subtotal * 100)::numeric, 2) END AS margen_pct,

      o.km_inicial, o.km_final, o.km_recorridos, o.km_status,
      o.litros, o.gasto_combustible, o.gasto_total, o.docs AS gasto_docs,
      o.costo_por_litro, o.km_por_litro,
      o.costo_fijo_por_km, o.costo_operacion, o.costo_por_km, o.costo_status,

      c.run_status, c.pct_aplicado, c.comision, c.bonos, c.nomina_banco, c.a_pagar,
      c.motivo_no_pago,
      -- Por qué no hay cifra de pago, en la misma fila. NULL nunca significa cero.
      CASE
        WHEN c.route_code IS NULL       THEN 'sin_corrida'
        WHEN c.motivo_no_pago IS NOT NULL THEN c.motivo_no_pago
        ELSE 'ok'
      END AS comision_status,
      -- El veredicto de la fila: qué le falta a esta ruta en esta quincena para estar completa.
      CASE
        WHEN v.route_code IS NULL                     THEN 'sin_venta'
        WHEN o.km_recorridos IS NULL                  THEN 'sin_km'
        WHEN o.gasto_total IS NULL                    THEN 'sin_gasto'
        WHEN c.route_code IS NULL                     THEN 'sin_corrida'
        ELSE 'completa'
      END AS fila_status
    FROM ruta r
    CROSS JOIN periodo p
    LEFT JOIN venta v ON v.tenant_id = r.tenant_id AND v.route_code = r.route_code AND v.period_id = p.id
    LEFT JOIN oper  o ON o.tenant_id = r.tenant_id AND o.route_code = r.route_code AND o.period_id = p.id
    LEFT JOIN com   c ON c.tenant_id = r.tenant_id AND c.route_code = r.route_code AND c.period_id = p.id
    WHERE p.tenant_id = r.tenant_id
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_rd_period_summary TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_period_summary IS 'RD.10 - una fila por ruta x quincena para la pantalla maestra de Ruta Directa: venta + costo + gasto de flota + odometro + $/km + comision, compuesto en la DB y no en el navegador (tres viajes pueden traer periodos distintos y un total que no cuadra con sus partes). El universo de rutas sale de commission_route_config, NO de la venta: una ruta que no vendio tiene que aparecer con su motivo, porque si no "no vendio" y "no existe" se leen igual. fila_status dice que le falta a cada fila; NULL nunca significa cero.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_rd_period_summary`);
};
