/**
 * [PU.V3] `analytics.mv_sellout_channel_monthly` — el sell-out por canal CANÓNICO × mes.
 *
 * ── Por qué, con la cifra que lo obliga ────────────────────────────────────────────────────
 *
 * [PU.V2] bajó `/sales-reconciliation` de «no termina en 300 s» a **592 ms** medidos en prod,
 * apuntando su CTE `so` a `mv_sellout_monthly`. Eso revivió la ruta, pero **592 ms sigue siendo
 * más de medio segundo**, que es literalmente la queja que abrió esta fase. El gate del proyecto
 * son 500 ms y no se redondea para abajo.
 *
 * El costo restante es un barrido completo: `mv_sellout_monthly` son **444 MB al grano producto ×
 * mes**, y la conciliación sólo necesita **canal × mes**. Un índice no ayuda —es un agregado
 * total, no un filtro—, así que lo que sobra es el grano.
 *
 * Esta MV son **~97 filas**. Se construye de `mv_sellout_monthly`, aplicando el mismo
 * `sellout_channel_map` que ya usaba la vista, así que **no introduce ninguna definición nueva**:
 * es el CTE `so` de `v_sellout_vs_facturacion`, materializado tal cual.
 *
 * ⛔ **No sirve para el presupuesto, y la distinción importa.** El mes calendario NO es el periodo
 *    fiscal 13×4: un periodo cruza meses. Esta MV contesta «canal × mes» (que es el grano de la
 *    balanza contable, con la que concilia) y `mv_sellout_budget_rollup` contesta «entidad × año
 *    fiscal × periodo». Son dos preguntas, no dos copias.
 *
 * ⚠️ `deps` en el refresco nocturno: deriva de `mv_sellout_monthly`, así que va DESPUÉS y lo
 *    declara. **Ordenar no es depender** (ADR-056): sin declararlo, si el espejo mensual falla
 *    esta MV se materializa igual sobre datos rancios y el resultado no se ve a medias, se ve
 *    completo — y la conciliación publicaría el mes pasado como si fuera éste.
 *
 * ⚠️ Su umbral va en `CRON_JOBS` (`analytics_refresh_sellout_channel`) o el sensor cae en el
 *    ternario que da 'ok' por default y una MV parada se ve VERDE (lección OBS.1).
 *
 * ⚠️ Las MV no soportan RLS: el filtro por tenant lo pone quien la lee. Acá la lee
 *    `v_sellout_vs_facturacion`, que ya publica `tenant_id` y se filtra aguas arriba igual que antes.
 *
 * @param { import("knex").Knex } knex
 */

const MV = `
CREATE MATERIALIZED VIEW analytics.mv_sellout_channel_monthly AS
SELECT m0.tenant_id,
       COALESCE(cm.canonical_channel, m0.channel) AS channel,
       m0.year_month,
       sum(m0.monto)        AS sell_out,
       now()                AS refreshed_at
  FROM analytics.mv_sellout_monthly m0
  LEFT JOIN analytics.sellout_channel_map cm
    ON cm.tenant_id = m0.tenant_id AND cm.source = m0.source AND cm.raw_channel = m0.channel
 GROUP BY 1, 2, 3`;

/** La vista de conciliación, leyendo el rollup de canal. El resto es idéntico a [PU.V2]. */
const VISTA = `
CREATE OR REPLACE VIEW analytics.v_sellout_vs_facturacion AS
WITH so AS (
  SELECT tenant_id, channel, year_month, sell_out
    FROM analytics.mv_sellout_channel_monthly
), fac_raw AS (
  SELECT l.tenant_id, l.anio_mes AS year_month,
         CASE WHEN l.cuenta_nombre ILIKE '%PISO%'    THEN 'mostrador'
              WHEN l.cuenta_nombre ILIKE '%MAYOREO%' THEN 'mayoreo'
              WHEN l.cuenta_nombre ILIKE '%VECINAL%' THEN 'preventa'
              WHEN l.cuenta_nombre ILIKE '%RD%'      THEN 'ruta'
              ELSE NULL END AS channel,
         l.abonos - l.cargos AS monto
    FROM analytics.ledger_monthly l
   WHERE l.cuenta_mayor = '401' AND l.cuenta_nombre NOT ILIKE '%FLETE%'
), fac AS (
  SELECT tenant_id, channel, year_month, sum(monto) AS facturacion
    FROM fac_raw WHERE channel IS NOT NULL GROUP BY 1, 2, 3
)
SELECT COALESCE(so.tenant_id, fac.tenant_id)   AS tenant_id,
       COALESCE(so.channel, fac.channel)       AS channel,
       COALESCE(so.year_month, fac.year_month) AS year_month,
       round(COALESCE(so.sell_out, 0), 2)      AS sell_out,
       round(COALESCE(fac.facturacion, 0), 2)  AS facturacion,
       round(COALESCE(fac.facturacion, 0) - COALESCE(so.sell_out, 0), 2) AS delta,
       CASE WHEN COALESCE(so.sell_out, 0) > 0
            THEN round(COALESCE(fac.facturacion, 0) / so.sell_out * 100, 1) END AS ratio_pct,
       CASE WHEN COALESCE(so.sell_out, 0) = 0     THEN 'sin_sellout'
            WHEN COALESCE(fac.facturacion, 0) = 0 THEN 'sin_facturacion'
            WHEN (fac.facturacion / so.sell_out) BETWEEN 0.8 AND 1.7 THEN 'concilia'
            ELSE 'revisar' END AS status
  FROM so
  FULL JOIN fac ON fac.tenant_id = so.tenant_id AND fac.channel = so.channel
               AND fac.year_month = so.year_month`;

exports.up = async function up(knex) {
  // ANTES: la vista ya es servible ([PU.V2]), así que acá SÍ se puede fotografiar completa y
  // barato — a diferencia de [PU.V2], donde el pre-vuelo sobre la vista vieja habría costado
  // >300 s. Esta foto es la que prueba que el cambio de grano no mueve un solo peso.
  const t0 = Date.now();
  const antes = (await knex.raw(`
    SELECT count(*) AS n, round(sum(sell_out), 2) AS so, round(sum(facturacion), 2) AS fac
      FROM analytics.v_sellout_vs_facturacion`)).rows[0];
  const msAntes = Date.now() - t0;

  const ya = (await knex.raw(`SELECT to_regclass('analytics.mv_sellout_channel_monthly') t`)).rows[0].t;
  if (!ya) {
    await knex.raw(MV);
    // UNIQUE: requisito de `REFRESH ... CONCURRENTLY` (sin él el refresco toma lock exclusivo y
    // la conciliación ve la MV vacía mientras dura).
    await knex.raw(`CREATE UNIQUE INDEX mv_sellout_channel_monthly_pk
                      ON analytics.mv_sellout_channel_monthly (tenant_id, channel, year_month)`);
    await knex.raw(`ANALYZE analytics.mv_sellout_channel_monthly`);
  }
  await knex.raw(`GRANT SELECT ON analytics.mv_sellout_channel_monthly TO app_runtime`);

  await knex.raw(VISTA);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_vs_facturacion TO app_runtime`);

  // ── Candados ─────────────────────────────────────────────────────────────────────────────
  // (a) La llave es llave. UNIQUE trata los NULL como distintos: una llave nullable no garantiza
  //     nada y `REFRESH CONCURRENTLY` lo descubriría en producción, no acá.
  const k = (await knex.raw(`
    SELECT count(*) AS filas,
           count(DISTINCT (tenant_id::text || '|' || channel || '|' || year_month)) AS llaves,
           count(*) FILTER (WHERE tenant_id IS NULL OR channel IS NULL OR year_month IS NULL) AS nulos
      FROM analytics.mv_sellout_channel_monthly`)).rows[0];
  if (Number(k.filas) !== Number(k.llaves)) {
    throw new Error(`mv_sellout_channel_monthly: ${k.filas} filas / ${k.llaves} llaves`);
  }
  if (Number(k.nulos) > 0) {
    throw new Error(`mv_sellout_channel_monthly: ${k.nulos} filas con NULL en la llave`);
  }

  // (b) ⭐ PARIDAD AL PESO. Cambiar de grano no puede mover un centavo: es el mismo universo,
  //     el mismo mapa de canal y la misma pierna contable. Si moviera algo, cambié otra cosa.
  const t1 = Date.now();
  const d = (await knex.raw(`
    SELECT count(*) AS n, round(sum(sell_out), 2) AS so, round(sum(facturacion), 2) AS fac
      FROM analytics.v_sellout_vs_facturacion`)).rows[0];
  const msDespues = Date.now() - t1;
  for (const [campo, a, b] of [['filas', antes.n, d.n], ['sell_out', antes.so, d.so], ['facturacion', antes.fac, d.fac]]) {
    if (Math.abs(Number(a) - Number(b)) > (campo === 'filas' ? 0 : 1)) {
      throw new Error(`El cambio de grano movió '${campo}': ${a} → ${b}. No debería mover nada.`);
    }
  }

  // (c) ⭐ PRUEBA NEGATIVA DEL GATE: si no bajó del gate, esta migración no tiene razón de existir.
  //     Se exige el gate REAL del proyecto (500 ms), no «más rápido que antes».
  if (msDespues >= 500) {
    throw new Error(
      `v_sellout_vs_facturacion tardó ${msDespues} ms: sigue sobre el gate de 500 ms, `
      + `o sea que no está leyendo mv_sellout_channel_monthly`);
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sellout_channel_monthly IS '${(
    `[PU.V3] Sell-out por canal CANONICO x mes calendario (~97 filas), que es el CTE "so" de `
    + `v_sellout_vs_facturacion materializado tal cual -- misma fuente, mismo sellout_channel_map, `
    + `cero definiciones nuevas. Existe porque leer mv_sellout_monthly (444 MB, grano producto) `
    + `dejaba la conciliacion en 592 ms, sobre el gate de 500 ms. NO sirve para el presupuesto: `
    + `el mes calendario no es el periodo fiscal 13x4 (ese grano lo contesta `
    + `mv_sellout_budget_rollup). Refresca AnalyticsRefreshService `
    + `(job analytics_refresh_sellout_channel).`
  ).replace(/'/g, "''")}'`);

  console.log(
    `  [mv_sellout_channel_monthly] ${k.filas} filas · conciliacion ${msAntes} ms → ${msDespues} ms `
    + `· paridad exacta (${d.n} filas, sell-out $${Number(d.so).toLocaleString('es-MX')})`);
};

exports.down = async function down(knex) {
  // Devuelve la vista a leer el espejo mensual ([PU.V2]) ANTES de soltar la MV, o el DROP falla
  // por dependencia.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sellout_vs_facturacion AS
    WITH so AS (
      SELECT m0.tenant_id,
             COALESCE(cm.canonical_channel, m0.channel) AS channel,
             m0.year_month,
             sum(m0.monto) AS sell_out
        FROM analytics.mv_sellout_monthly m0
        LEFT JOIN analytics.sellout_channel_map cm
          ON cm.tenant_id = m0.tenant_id AND cm.source = m0.source AND cm.raw_channel = m0.channel
       GROUP BY 1, 2, 3
    ), fac_raw AS (
      SELECT l.tenant_id, l.anio_mes AS year_month,
             CASE WHEN l.cuenta_nombre ILIKE '%PISO%'    THEN 'mostrador'
                  WHEN l.cuenta_nombre ILIKE '%MAYOREO%' THEN 'mayoreo'
                  WHEN l.cuenta_nombre ILIKE '%VECINAL%' THEN 'preventa'
                  WHEN l.cuenta_nombre ILIKE '%RD%'      THEN 'ruta'
                  ELSE NULL END AS channel,
             l.abonos - l.cargos AS monto
        FROM analytics.ledger_monthly l
       WHERE l.cuenta_mayor = '401' AND l.cuenta_nombre NOT ILIKE '%FLETE%'
    ), fac AS (
      SELECT tenant_id, channel, year_month, sum(monto) AS facturacion
        FROM fac_raw WHERE channel IS NOT NULL GROUP BY 1, 2, 3
    )
    SELECT COALESCE(so.tenant_id, fac.tenant_id)   AS tenant_id,
           COALESCE(so.channel, fac.channel)       AS channel,
           COALESCE(so.year_month, fac.year_month) AS year_month,
           round(COALESCE(so.sell_out, 0), 2)      AS sell_out,
           round(COALESCE(fac.facturacion, 0), 2)  AS facturacion,
           round(COALESCE(fac.facturacion, 0) - COALESCE(so.sell_out, 0), 2) AS delta,
           CASE WHEN COALESCE(so.sell_out, 0) > 0
                THEN round(COALESCE(fac.facturacion, 0) / so.sell_out * 100, 1) END AS ratio_pct,
           CASE WHEN COALESCE(so.sell_out, 0) = 0     THEN 'sin_sellout'
                WHEN COALESCE(fac.facturacion, 0) = 0 THEN 'sin_facturacion'
                WHEN (fac.facturacion / so.sell_out) BETWEEN 0.8 AND 1.7 THEN 'concilia'
                ELSE 'revisar' END AS status
      FROM so
      FULL JOIN fac ON fac.tenant_id = so.tenant_id AND fac.channel = so.channel
                   AND fac.year_month = so.year_month`);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_vs_facturacion TO app_runtime`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sellout_channel_monthly CASCADE`);
};
