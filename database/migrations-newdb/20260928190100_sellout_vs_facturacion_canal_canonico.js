/**
 * `[VSO.2]` La conciliación sell-out ↔ facturación (cta 401) pasa a hablar en canal de NEGOCIO.
 *
 * ── El daño, medido contra prod el 2026-09-28 ───────────────────────────────────────────────
 * `analytics.v_sellout_vs_facturacion` mapea la subcuenta contable `%MAYOREO%` al canal
 * `credito`. Eso era cierto hasta que SD-CH separó la taxonomía: hoy el mayoreo de Kepler
 * (`U-D-8` Factura Telemarketing) viaja como `mayoreo` y `credito` quedó siendo **sólo la pierna
 * Wincaja**. O sea que el árbitro compara la facturación de mayoreo COMPLETA contra medio
 * sell-out. Septiembre-2026 lo muestra sin ambigüedad:
 *
 *   sell_out credito $2,920,676  vs facturación $9,892,240  →  338.7%  «revisar»
 *   credito + mayoreo $12,263,605 vs los mismos $9,892,240  →   80.7%  «concilia»
 *
 * Y `mayoreo`/`contado_nf` salían `sin_facturacion` SIEMPRE: el `CASE` no puede producir esos
 * canales, así que del lado derecho del FULL JOIN no existen — el árbitro no los veía **y tampoco
 * avisaba que no los veía**, que es la falla más cara de las dos.
 *
 * ── Qué cambia y qué NO ─────────────────────────────────────────────────────────────────────
 * Cambia el VOCABULARIO de los dos lados: el sell-out se agrega por `canonical_channel` (vía
 * `analytics.sellout_channel_map`, VSO.1) y la subcuenta `%MAYOREO%` apunta a `mayoreo`. NO cambia
 * la banda de conciliación, ni el grano, ni de dónde sale cada cifra: sigue siendo transparencia
 * sobre dos fuentes independientes, sin ajustar ninguna.
 *
 * ⚠️ Esto NO arregla la conciliación, la deja MEDIBLE. Con el vocabulario alineado, agosto-2026
 * sigue en 22.5% y `ruta` sigue con $0 de facturación en 4 de 5 meses: el lado contable (401 por
 * subcuenta) necesita su propia auditoría, y queda DECLARADO acá en vez de disfrazado de «revisar».
 *
 * Reescribe la definición completa (es corta) previa ASERCIÓN de que la vista viva es la que este
 * archivo cree: si alguien la cambió mientras tanto, aborta en vez de pisarla.
 * @param { import("knex").Knex } knex
 */

const OBJ = 'analytics.v_sellout_vs_facturacion';

const CUERPO = `
      WITH so AS (
        SELECT sd.tenant_id,
               COALESCE(m.canonical_channel, sd.channel) AS channel,
               to_char(sd.business_date, 'YYYY-MM') AS year_month,
               sum(sd.monto)::numeric AS sell_out
          FROM analytics.v_sellout_daily sd
          LEFT JOIN analytics.sellout_channel_map m
                 ON m.tenant_id = sd.tenant_id AND m.source = sd.source AND m.raw_channel = sd.channel
         GROUP BY sd.tenant_id, COALESCE(m.canonical_channel, sd.channel), to_char(sd.business_date, 'YYYY-MM')
      ),
      fac_raw AS (
        SELECT tenant_id, anio_mes AS year_month,
               CASE WHEN cuenta_nombre ILIKE '%PISO%'    THEN 'mostrador'
                    WHEN cuenta_nombre ILIKE '%MAYOREO%' THEN 'mayoreo'
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
        FULL JOIN fac
               ON fac.tenant_id = so.tenant_id AND fac.channel = so.channel AND fac.year_month = so.year_month`;

exports.up = async function (knex) {
  const def = (await knex.raw(`SELECT pg_get_viewdef(?::regclass, true) AS d`, [OBJ])).rows[0].d;

  if (def.includes('sellout_channel_map')) {
    console.log(`  ${OBJ} ya lee el resolvedor de canal — idempotente, skip.`);
    return;
  }
  // Aserción: la vista viva tiene que ser la que este archivo cree que va a reemplazar. Sin esto,
  // una reescritura ciega puede borrar el trabajo de otra sesión y el resultado se ve igual de bien.
  for (const firma of [`'%MAYOREO%'`, `cuenta_mayor = '401'`, `v_sellout_daily`]) {
    if (!def.includes(firma)) {
      throw new Error(`ABORT: ${OBJ} no contiene la firma ${firma} — su definición cambió; revisar a mano antes de reescribirla.`);
    }
  }

  await knex.raw(`CREATE OR REPLACE VIEW ${OBJ} AS ${CUERPO}`);
  await knex.raw(`GRANT SELECT ON ${OBJ} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${OBJ} IS
    'PVR/VSO.2 · Conciliacion DOCUMENTADA sell-out vs facturacion contable (cta 401 producto, sin fletes), por canal de NEGOCIO x mes. El canal sale de analytics.sellout_channel_map en los DOS lados: la subcuenta %MAYOREO% vale contra credito+mayoreo juntos (antes solo contra la pierna Wincaja: sep-2026 daba 338.7% revisar en vez de 80.7% concilia). NO ajusta ninguna fuente: el real del presupuesto sigue siendo el sell-out. ADVERTENCIA: con el vocabulario ya alineado, ruta sigue con $0 de facturacion en 4 de 5 meses y agosto-2026 en 22.5% - el lado contable necesita su propia auditoria, esta DECLARADO, no resuelto.'`);
};

exports.down = async function (knex) {
  // Volver al mapeo viejo (MAYOREO→credito, sell-out por canal crudo) sin el resolvedor.
  await knex.raw(`CREATE OR REPLACE VIEW ${OBJ} AS ${CUERPO
    .replace(`COALESCE(m.canonical_channel, sd.channel) AS channel`, `sd.channel AS channel`)
    .replace(`GROUP BY sd.tenant_id, COALESCE(m.canonical_channel, sd.channel), to_char(sd.business_date, 'YYYY-MM')`,
      `GROUP BY sd.tenant_id, sd.channel, to_char(sd.business_date, 'YYYY-MM')`)
    .replace(`          LEFT JOIN analytics.sellout_channel_map m\n                 ON m.tenant_id = sd.tenant_id AND m.source = sd.source AND m.raw_channel = sd.channel\n`, '')
    .replace(`WHEN cuenta_nombre ILIKE '%MAYOREO%' THEN 'mayoreo'`, `WHEN cuenta_nombre ILIKE '%MAYOREO%' THEN 'credito'`)}`);
};
