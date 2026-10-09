/**
 * [TES.12] finance.cashflow_forecast - el pronostico se GUARDA, para poder contrastarlo.
 *
 * -- POR QUE EXISTE ---------------------------------------------------------------------
 * El flujo de efectivo proyecta cada vez que alguien abre la pantalla y no deja rastro. Sin
 * registro de lo que dijimos, NADIE puede comparar lo proyectado contra lo ocurrido, y un
 * pronostico que nunca se contrasta no mejora: es una opinion con formato de cifra.
 *
 * El "ocurrido" ya existe y esta al dia, derivado del ODS en las dos piernas (medido contra
 * prod el 2026-10-09, ocho semanas cerradas):
 *
 *     analytics.erp_collections        cobro real   $9.16M - $11.55M por semana
 *     analytics.erp_supplier_payments  pago  real   $7.02M - $11.61M por semana
 *
 * Lo unico que falta es el otro lado de la resta. Eso es esta tabla.
 *
 * -- ⛔ LA TRAMPA QUE ESTE DISENO EVITA --------------------------------------------------
 * Un back-test ingenuo compararia proyectado contra real y publicaria un error de -80%.
 * Seria falso. Medido el mismo dia:
 *
 *     cobro real        ~$10,000,000 por semana
 *     cobro proyectado   ~$1,500,000 por semana
 *
 * El pronostico ve ~1/6 de lo que entra **por construccion**: agenda por vencimiento y lo ya
 * vencido viaja declarado SIN fecha (son $55M). O sea que la diferencia no mide la punteria
 * del pronostico: mide su COBERTURA, que ya sabemos cual es.
 *
 * Por eso cada fila guarda la cobertura con la que se hizo. Sin ese campo, las dos series son
 * universos distintos y la resta no significa nada - exactamente el error que esta fase
 * documento tres veces en otros numeros.
 *
 * -- QUE ES CADA FILA -------------------------------------------------------------------
 * Una fila por (dia en que se tomo la foto, semana proyectada). La misma semana aparece
 * varias veces, una por cada dia que la proyectamos: asi se puede ver si el pronostico se
 * acerca a medida que la semana se aproxima, que es la pregunta util.
 *
 * ⚠️ `tomado_el` es la fecha de la FOTO, no la de la proyeccion. Dos conceptos que un solo
 * timestamp confunde, y la confusion no se nota hasta que alguien compara mal.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('finance').hasTable('cashflow_forecast');
  if (!existe) {
    await knex.raw(`
      CREATE TABLE finance.cashflow_forecast (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        tomado_el       date NOT NULL,
        semana          date NOT NULL,
        horizonte_dias  int  NOT NULL,

        cobros_proyectado numeric(16,2) NOT NULL DEFAULT 0,
        pagos_proyectado  numeric(16,2) NOT NULL DEFAULT 0,

        -- La cobertura con la que se hizo ESTA foto. Sin esto la comparacion contra el real
        -- mezcla universos y publica como error lo que es alcance. NULL = no se pudo medir,
        -- que NO es lo mismo que 0 (ADR-056).
        cobro_cobertura_pct numeric(5,2),
        pago_cobertura_pct  numeric(5,2),
        cobro_vencido_fuera numeric(16,2),
        pago_vencido_fuera  numeric(16,2),

        -- Procedencia: de cuando es el dato con el que se proyecto, no cuando se leyo.
        cobro_as_of     timestamptz,
        pago_as_of      timestamptz,

        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, tomado_el, semana)
      )`);
    await knex.raw(`CREATE INDEX ix_cashflow_forecast_semana ON finance.cashflow_forecast (tenant_id, semana)`);
    await knex.raw(`ALTER TABLE finance.cashflow_forecast ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.cashflow_forecast FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_aislamiento ON finance.cashflow_forecast
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.cashflow_forecast TO app_runtime`);
  }

  await knex.raw(`COMMENT ON TABLE finance.cashflow_forecast IS
    'El pronostico de flujo, guardado para poder contrastarlo contra el ocurrido. Cada fila lleva la COBERTURA con la que se hizo: sin ella la resta contra el real mezcla universos y publica como error lo que es alcance. Ver la cabecera de la migracion 20261009093031.'`);

  // ── La vista que cierra el lazo ──────────────────────────────────────────────────────
  // ⚠️ Compara SOLO semanas cerradas: una semana en curso tiene el real a medias y daria un
  // pronostico "optimista" que es puro artefacto del calendario.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_cashflow_backtest AS
    WITH real_cob AS (
      SELECT tenant_id, date_trunc('week', cobro_date)::date AS semana, sum(monto) AS m
        FROM analytics.erp_collections GROUP BY 1, 2
    ), real_pag AS (
      SELECT tenant_id, date_trunc('week', pago_date)::date AS semana, sum(monto) AS m
        FROM analytics.erp_supplier_payments GROUP BY 1, 2
    )
    SELECT f.tenant_id, f.semana, f.tomado_el, f.horizonte_dias,
           f.cobros_proyectado, f.pagos_proyectado,
           round(coalesce(rc.m, 0), 2) AS cobros_real,
           round(coalesce(rp.m, 0), 2) AS pagos_real,
           f.cobro_cobertura_pct, f.pago_cobertura_pct,
           -- La RAZON, no el error: cuantas veces entro lo que proyectamos. Con cobertura
           -- parcial esto mide ALCANCE, no punteria, y por eso se llama razon.
           CASE WHEN f.cobros_proyectado > 0
                THEN round(coalesce(rc.m, 0) / f.cobros_proyectado, 3) END AS cobro_razon,
           CASE WHEN f.pagos_proyectado > 0
                THEN round(coalesce(rp.m, 0) / f.pagos_proyectado, 3) END AS pago_razon,
           -- ⛔ El veredicto que impide leer alcance como punteria. Una comparacion con
           -- cobertura parcial NO es comparable, y se dice en la fila, no en una nota al pie.
           (f.cobro_cobertura_pct IS NOT NULL AND f.cobro_cobertura_pct >= 99.0) AS cobro_comparable,
           (f.pago_cobertura_pct  IS NOT NULL AND f.pago_cobertura_pct  >= 99.0) AS pago_comparable
      FROM finance.cashflow_forecast f
      LEFT JOIN real_cob rc ON rc.tenant_id = f.tenant_id AND rc.semana = f.semana
      LEFT JOIN real_pag rp ON rp.tenant_id = f.tenant_id AND rp.semana = f.semana
     WHERE f.semana < date_trunc('week', current_date)::date`);
  await knex.raw(`ALTER VIEW analytics.v_cashflow_backtest SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_cashflow_backtest TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_cashflow_backtest IS
    'Lo proyectado contra lo ocurrido, por semana CERRADA. Publica RAZON (real/proyectado), no error: con cobertura parcial la diferencia mide alcance y no punteria, y cobro_comparable/pago_comparable lo dicen por fila.'`);

  void M;
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_cashflow_backtest');
  await knex.raw('DROP TABLE IF EXISTS finance.cashflow_forecast');
};
