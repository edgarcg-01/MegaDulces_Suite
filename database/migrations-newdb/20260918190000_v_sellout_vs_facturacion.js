/**
 * Fase PVR — Conciliación DOCUMENTADA sell-out ↔ facturación contable (cta 401).
 *
 * El presupuesto de ventas usa el SELL-OUT (`v_sellout_daily`) como real. Esta vista NO cambia eso:
 * sólo DOCUMENTA (hace visible) la relación entre el sell-out y la facturación de la contabilidad
 * (cta 401 producto), por canal × mes — para que el puente y las anomalías queden declarados, no
 * ocultos. No aplica ningún ajuste/reescala; es transparencia.
 *
 * Medido (2026): mostrador/credito/ruta reconcilian en banda estable (401 ≈ 118-138% del sell-out —
 * bruto-vs-neto/cobertura); **preventa NO reconcilia** porque el vecinal en 401-003 es un asiento
 * lumpy de jul-ago 2026 (~$17M en 2 meses, ~$0 antes) vs un flujo parejo en el sell-out.
 *
 * Facturación = cta 401 producto (excluye 401-002 FLETES), mapeada a canal por el NOMBRE de subcuenta:
 *   PISO→mostrador · MAYOREO→credito · VECINAL→preventa · RD→ruta.
 * Grano: canal × año_mes (ambas fuentes agregables a mes). Sin RLS propia (convención analytics: el
 * consumidor filtra por tenant). Cero importer — deriva del ODS/balanza.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sellout_vs_facturacion AS
      WITH so AS (
        SELECT sd.tenant_id, sd.channel, to_char(sd.business_date, 'YYYY-MM') AS year_month,
               sum(sd.monto)::numeric AS sell_out
          FROM analytics.v_sellout_daily sd
         GROUP BY sd.tenant_id, sd.channel, to_char(sd.business_date, 'YYYY-MM')
      ),
      fac_raw AS (
        SELECT tenant_id, anio_mes AS year_month,
               CASE WHEN cuenta_nombre ILIKE '%PISO%'    THEN 'mostrador'
                    WHEN cuenta_nombre ILIKE '%MAYOREO%' THEN 'credito'
                    WHEN cuenta_nombre ILIKE '%VECINAL%' THEN 'preventa'
                    WHEN cuenta_nombre ILIKE '%RD%'      THEN 'ruta'
               END AS channel,
               (abonos - cargos)::numeric AS monto
          FROM analytics.ledger_monthly
         WHERE cuenta_mayor = '401' AND cuenta_nombre NOT ILIKE '%FLETE%'
      ),
      fac AS (
        SELECT tenant_id, channel, year_month, sum(monto)::numeric AS facturacion
          FROM fac_raw
         WHERE channel IS NOT NULL
         GROUP BY tenant_id, channel, year_month
      )
      SELECT
        COALESCE(so.tenant_id, fac.tenant_id)   AS tenant_id,
        COALESCE(so.channel, fac.channel)        AS channel,
        COALESCE(so.year_month, fac.year_month)  AS year_month,
        round(COALESCE(so.sell_out, 0), 2)       AS sell_out,
        round(COALESCE(fac.facturacion, 0), 2)   AS facturacion,
        round(COALESCE(fac.facturacion, 0) - COALESCE(so.sell_out, 0), 2) AS delta,
        CASE WHEN COALESCE(so.sell_out, 0) > 0
             THEN round(COALESCE(fac.facturacion, 0) / so.sell_out * 100, 1) END AS ratio_pct,
        CASE
          WHEN COALESCE(so.sell_out, 0) = 0    THEN 'sin_sellout'
          WHEN COALESCE(fac.facturacion, 0) = 0 THEN 'sin_facturacion'
          WHEN fac.facturacion / so.sell_out BETWEEN 0.8 AND 1.7 THEN 'concilia'
          ELSE 'revisar'
        END AS status
      FROM so
      FULL OUTER JOIN fac USING (tenant_id, channel, year_month)
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_vs_facturacion TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_sellout_vs_facturacion IS
    'PVR — Conciliación DOCUMENTADA sell-out (v_sellout_daily) vs facturación contable (cta 401 producto, sin fletes) por canal×mes. Transparencia, sin ajuste: el real del presupuesto sigue siendo el sell-out. status concilia(0.8-1.7)/revisar/sin_*. Preventa aparece revisar por asiento lumpy jul-ago en 401-003.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sellout_vs_facturacion CASCADE`);
};
