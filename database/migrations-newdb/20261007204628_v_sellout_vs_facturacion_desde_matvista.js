/**
 * [PU.V2] `analytics.v_sellout_vs_facturacion` deja de agregar la vista VIVA del sell-out.
 *
 * ── Qué pasaba ─────────────────────────────────────────────────────────────────────────────
 *
 * `/sales-reconciliation` figura en `analytics.ui_usage` con **120,007 ms** de máximo sobre
 * **1 solo hit en 8 días**. Esos 120,007 ms no son un tiempo de respuesta: son el
 * `statement_timeout` del API. La pantalla nunca cargó — se murió, una vez, y nadie volvió.
 *
 * Medido contra prod el 2026-10-07 con `statement_timeout = 300 s`: **tampoco terminó**.
 *
 * El costo está en su CTE `so`, que agrega `analytics.v_sellout_daily` ENTERA, y esa vista es un
 * UNION de `mv_kepler_sales_daily` (359 MB) + `mv_wincaja_sales_daily` (1,335 MB) al grano
 * producto × día, con un `EXISTS` correlacionado por fila contra `v_branch_erp_cutover`.
 *
 * ── Qué cambia, y por qué no hace falta ningún objeto nuevo ────────────────────────────────
 *
 * ⭐ `analytics.mv_sellout_monthly` **ya es exactamente lo que este CTE necesita**: verificado
 * leyendo su definición, es `v_sellout_daily` rolada a `to_char(business_date,'YYYY-MM')` con las
 * mismas columnas y el mismo GROUP BY. Ya se refresca de noche con latido verde
 * (`analytics_refresh_sellout_monthly`, umbral registrado en `CRON_JOBS`). Y agregarla a
 * canal × mes cuesta **384 ms** medidos.
 *
 * O sea: el primitivo existía, estaba bien hecho, tenía latido — y esta vista, del mismo módulo,
 * simplemente no lo usaba. El patrón que ADR-056 documenta una y otra vez.
 *
 * ⛔ **NO cambia ningún número**: mismo universo, mismo `sellout_channel_map`, misma pierna
 *    contable (`ledger_monthly` cuenta 401 sin fletes, que ya costaba 4 ms). La lógica se copia
 *    renglón por renglón; lo único que se sustituye es de dónde sale la suma del sell-out.
 *
 * ⚠️ **Sí cambia la FRESCURA, y se declara** (ADR-056): la pierna de sell-out pasa de viva a un
 *    snapshot nocturno. Para una conciliación contra la balanza mensual —que es un cierre
 *    contable— eso es lo correcto, pero el mes en curso puede ir un día atrás y
 *    `BudgetSalesIndicatorsService.getReconciliation()` lo rotula en sus `notes`. Declararlo es
 *    la diferencia entre un dato con rezago y un dato que miente.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` conserva nombres, tipos y orden de columnas: no se toca ninguno
 *    (si cambiaran, Postgres rechaza el REPLACE, que es justamente la red). Esta vista **no**
 *    tiene `security_invoker` —verificado en `pg_class.reloptions`: viene `null`—, así que no hay
 *    nada que re-aplicar; el GRANT sí se re-afirma, porque eso sí se pierde.
 *
 * @param { import("knex").Knex } knex
 */

/** La pierna contable y la forma de salida son IDÉNTICAS en las dos versiones. Sólo cambia `so`. */
const salida = `
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

/** NUEVA: la pierna de sell-out sale del espejo mensual ya materializado. */
const SO_MATVISTA = `
    CREATE OR REPLACE VIEW analytics.v_sellout_vs_facturacion AS
    WITH so AS (
      SELECT m0.tenant_id,
             COALESCE(cm.canonical_channel, m0.channel) AS channel,
             m0.year_month,
             sum(m0.monto) AS sell_out
        FROM analytics.mv_sellout_monthly m0
        LEFT JOIN analytics.sellout_channel_map cm
          ON cm.tenant_id = m0.tenant_id AND cm.source = m0.source AND cm.raw_channel = m0.channel
       GROUP BY 1, 2, 3${salida}`;

/** ANTERIOR: la vista viva. Sólo para `down`. */
const SO_VIVA = `
    CREATE OR REPLACE VIEW analytics.v_sellout_vs_facturacion AS
    WITH so AS (
      SELECT sd.tenant_id,
             COALESCE(m.canonical_channel, sd.channel) AS channel,
             to_char(sd.business_date::timestamptz, 'YYYY-MM') AS year_month,
             sum(sd.monto) AS sell_out
        FROM analytics.v_sellout_daily sd
        LEFT JOIN analytics.sellout_channel_map m
          ON m.tenant_id = sd.tenant_id AND m.source = sd.source AND m.raw_channel = sd.channel
       GROUP BY 1, 2, 3${salida}`;

exports.up = async function up(knex) {
  // Fotografía del ANTES de la pierna CONTABLE, leída de `ledger_monthly` DIRECTO (4 ms medidos).
  //
  // ⛔ No se consulta la vista vieja para sacarla, aunque sea lo intuitivo: su `FULL JOIN` obliga a
  //    materializar el CTE `so` aunque uno sólo pida `facturacion`, así que ese pre-vuelo costaría
  //    los mismos >300 s que esta migración existe para eliminar. *Filtrar una columna no evita
  //    calcular la otra.*
  const antes = (await knex.raw(`
    SELECT round(sum(l.abonos - l.cargos), 2) AS fac
      FROM analytics.ledger_monthly l
     WHERE l.cuenta_mayor = '401' AND l.cuenta_nombre NOT ILIKE '%FLETE%'
       AND (l.cuenta_nombre ILIKE '%PISO%' OR l.cuenta_nombre ILIKE '%MAYOREO%'
         OR l.cuenta_nombre ILIKE '%VECINAL%' OR l.cuenta_nombre ILIKE '%RD%')`)).rows[0];

  await knex.raw(SO_MATVISTA);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_vs_facturacion TO app_runtime`);

  // ── Candados ─────────────────────────────────────────────────────────────────────────────
  // (a) Tiene que cerrar RÁPIDO. Si volviera a tardar, es que quedó apuntada a la vista viva.
  const t0 = Date.now();
  const d = (await knex.raw(`
    SELECT count(*) AS n, round(sum(sell_out), 2) AS so, round(sum(facturacion), 2) AS fac
      FROM analytics.v_sellout_vs_facturacion`)).rows[0];
  const ms = Date.now() - t0;
  if (ms > 10000) {
    throw new Error(`v_sellout_vs_facturacion tardó ${ms} ms: no está leyendo la matvista`);
  }
  if (Number(d.n) < 10) {
    throw new Error(`v_sellout_vs_facturacion devolvió ${d.n} filas: la dejé vacía`);
  }

  // (b) PRUEBA NEGATIVA de que el sell-out no se perdió: la suma de la vista tiene que
  //     reproducir la del espejo mensual al peso. Si diera 0 o la mitad, el candado (a) —que sólo
  //     mira el reloj— se pondría verde igual.
  const espejo = (await knex.raw(`
    SELECT round(sum(monto), 2) AS so FROM analytics.mv_sellout_monthly`)).rows[0];
  const diff = Math.abs(Number(d.so) - Number(espejo.so));
  if (diff > 1) {
    throw new Error(
      `La pierna de sell-out no cuadra con su fuente: vista ${d.so} vs mv_sellout_monthly `
      + `${espejo.so} (diferencia ${diff.toFixed(2)})`);
  }

  // (c) La pierna CONTABLE no se tocó: tiene que quedar idéntica a la de antes.
  if (Math.abs(Number(d.fac) - Number(antes.fac)) > 1) {
    throw new Error(
      `La pierna de facturación cambió (${antes.fac} → ${d.fac}) y esta migración no la toca`);
  }

  await knex.raw(`COMMENT ON VIEW analytics.v_sellout_vs_facturacion IS '${(
    `[PU.V2] Conciliacion sell-out vs facturacion contable (cta 401). La pierna de sell-out sale `
    + `de analytics.mv_sellout_monthly (espejo nocturno de v_sellout_daily, mismas columnas y `
    + `mismo GROUP BY), NO de la vista viva: agregarla en vivo no terminaba en 300 s y la pantalla `
    + `moria en el statement_timeout. Mismo universo y mismo sellout_channel_map -- ningun numero `
    + `cambia. SI cambia la frescura: el mes en curso puede ir un dia atras, y el service lo `
    + `declara en sus notes.`
  ).replace(/'/g, "''")}'`);

  console.log(
    `  [v_sellout_vs_facturacion] ${d.n} filas en ${ms} ms (antes: no terminaba en 300 s) · `
    + `sell-out $${Number(d.so).toLocaleString('es-MX')} cuadra con el espejo mensual`);
};

exports.down = async function down(knex) {
  await knex.raw(SO_VIVA);
  await knex.raw(`GRANT SELECT ON analytics.v_sellout_vs_facturacion TO app_runtime`);
};
