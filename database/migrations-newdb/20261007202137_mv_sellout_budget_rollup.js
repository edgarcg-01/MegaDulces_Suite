/**
 * [PU.V1] `analytics.mv_sellout_budget_rollup` — el real del sell-out al grano que Presupuestos
 * necesita (entidad × año fiscal × periodo 13×4), con el join de canal ARREGLADO.
 *
 * ── Lo que arregla (medido contra PROD el 2026-10-07) ──────────────────────────────────────
 *
 * `analytics.v_sales_entity` traduce el canal CRUDO al CANÓNICO (pasa por `sellout_channel_map`:
 * Wincaja `credito` → `mayoreo`, Kepler `contado_nf` → `mostrador`). Los tres consumidores de
 * Presupuestos joineaban el canal crudo del sell-out contra el canónico de la entidad:
 *
 *     se.channel = sd.channel        -- se.channel es CANÓNICO, sd.channel es CRUDO
 *
 * Sólo casan cuando crudo == canónico. Los dos que no casan se caían ENTEROS:
 *
 *     credito    (wincaja) → mayoreo     $312,951,449
 *     contado_nf (kepler)  → mostrador   $  1,477,412
 *                                        ─────────────
 *                                        $314,428,861 = 28.70 % del sell-out
 *
 * Y no era un sesgo parejo: tres celdas publicaban **$0 sobre $208 millones**.
 *
 *     mayoreo:01  FY2025   $0  →  $67,746,920     (Padre Hidalgo)
 *     mayoreo:06  FY2025   $0  →  $67,130,507     (Canindo)
 *     mayoreo:08  FY2025   $0  →  $73,499,658     (Morelia Abastos)
 *     mayoreo:08  FY2026   $2,736,550 → $44,492,091
 *
 * Dibujar un cero donde hay dato es justo lo que ADR-056 prohíbe. Total FY2025+FY2026:
 * $780,918,721 → $1,095,091,288 (**+40.2 %**).
 *
 * ⭐ El primitivo correcto YA existía y estaba aplicado a UN solo consumidor: la vista
 * `analytics.v_sellout_vs_facturacion`, del MISMO módulo, sí pasa por el mapa de canal. Mismo
 * patrón que ADR-056 documenta una y otra vez.
 *
 * ── Por qué además se MATERIALIZA (GOTCHAS §19: materializar por costo es legítimo) ────────
 *
 * `v_sellout_daily` es un UNION de `mv_kepler_sales_daily` (359 MB) + `mv_wincaja_sales_daily`
 * (1,335 MB) al grano producto × día, con un EXISTS correlacionado por fila contra
 * `v_branch_erp_cutover`. Agregarla en vivo, medido contra prod:
 *
 *     /budgets/:id/sales-comparison   56,397 ms máx / 45,796 ms prom  (7 hits)
 *     /budgets/:id/sales-indicators   61,182 ms máx                   (2 hits)
 *
 * contra un gate de 500 ms. Esta MV son **~520 filas**: la lectura queda en milisegundos.
 *
 * ⛔ NO es una segunda definición del sell-out: es la MISMA `v_sellout_daily`, rolada por el
 *    MISMO calendario y el MISMO catálogo de entidades. La verdad sigue siendo `v_sellout_daily`.
 *
 * ── Qué SUSTITUYE ──────────────────────────────────────────────────────────────────────────
 *
 * El Parquet+DuckDB de ADR-075 (`SelloutRollupService`), que calculaba exactamente esto pero
 * sobre un sustrato que la medición del 2026-10-07 encontró roto en producción:
 *
 *   · `BUDGET_ROLLUP_DIR` no está definida en NINGÚN lado → cae a `os.tmpdir()` del pod.
 *   · El Deployment `api` corre `replicas: 2` y **no monta ningún volumen** (sólo `redis` monta
 *     `/data`) → dos pods, dos Parquets distintos, y el usuario ve una cifra u otra según a cuál
 *     lo mande el balanceador.
 *   · Se pierde en cada despliegue → el primer request después de cada deploy responde 503
 *     «El histórico de ventas se está generando». Ya le pasó a una persona real en una sesión.
 *   · El rebuild cuesta **25 s** y lo dispara un request de usuario, ×2 pods.
 *
 * En este repo hay **20 agregados pesados** servidos por matvista + refresco nocturno + latido
 * con umbral. El Parquet era el único que no. Acá se alinea: lo refresca `AnalyticsRefreshService`
 * (job `analytics_refresh_sellout_budget`), con su umbral en `CRON_JOBS` — sin esa fila el sensor
 * cae en `cfg ? classify : 'ok'` y una MV parada se ve VERDE (lección OBS.1).
 *
 * ── Universo declarado (ADR-056) ───────────────────────────────────────────────────────────
 *
 * Medido contra prod ya con el arreglo: del sell-out crudo ($1,095,381,307) esta MV cubre
 * $1,095,131,580 = **99.977 %**. Lo que queda fuera son **$249,727 (0.023 %)** de fechas que
 * `v_retail_calendar` no cubre (hay renglones con `business_date` en 2000 y 2014). **Cero filas**
 * quedan fuera por falta de entidad — eso es lo que el arreglo cierra.
 *
 * ⚠️ Las MV no soportan RLS (limitación de Postgres, vivida en C.1): el filtro por `tenant_id`
 *    va EXPLÍCITO en el service, igual que lo hacía el Parquet (un archivo por tenant).
 *
 * ⚠️ `CREATE INDEX CONCURRENTLY` es trampa en esta base (espera transacciones ajenas). Índice normal.
 *
 * ⚠️⚠️ **EL POBLADO CUESTA 281.1 s. APLICARLA EN VENTANA.** Y la cifra tiene historia, porque
 *    primero medí 28 s y escribí eso acá: ésa era la consulta **filtrada a un tenant**. El
 *    `CREATE MATERIALIZED VIEW` corre SIN filtro, y sin él el planner cambia de `HashAggregate` a
 *    `GroupAggregate` —o sea, ordena— y pasa de 28 s a 281 s. Mismo costo estimado (6.77M vs
 *    6.67M), diez veces el tiempo. *Medir la consulta parecida no es medir la consulta real.*
 *
 *    Nace igual **WITH DATA**, y no `WITH NO DATA` como `mv_erp_margin_daily`: crearla vacía
 *    dejaría la pestaña sin real hasta el nocturno de las 06:20. 281 s está en línea con lo que
 *    este repo ya paga de noche (`mv_erp_count_rollforward` 292.9 s), un `CREATE MATERIALIZED
 *    VIEW` toma `ACCESS SHARE` y no bloquea al CDC —un costo de lectura no es una escritura
 *    pesada (lección CE)—, y `apply-one-migration-prod.js` corre con `statement_timeout=0` y
 *    `lock_timeout=15s`, así que no hace cola delante del tráfico.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * El rollup. ⭐ El `LEFT JOIN sellout_channel_map` + `COALESCE` es EL arreglo: reproduce
 * exactamente la traducción que `v_sales_entity` hace puertas adentro para fabricar su catálogo.
 * `LEFT` y no `JOIN` a propósito: un canal sin fila en el mapa pasa con su nombre crudo en vez de
 * desaparecer — que es como se perdieron los $314M.
 */
const MV = `
CREATE MATERIALIZED VIEW analytics.mv_sellout_budget_rollup AS
SELECT sd.tenant_id,
       se.entity_key,
       se.channel,
       -- Denormalizado a propósito: el tablero de indicadores lo rotula, y traerlo acá le evita
       -- joinear v_sales_entity, que cuesta 549 ms medidos (hace DISTINCT sobre los 444 MB de
       -- mv_sellout_monthly). No es un segundo origen: es la MISMA columna del MISMO join.
       se.branch_name,
       cal.fiscal_year::int                AS fiscal_year,
       cal.period_no::int                  AS period_no,
       sum(sd.monto)::numeric(18,2)        AS monto,
       -- ⭐ La frescura del dato QUE ESTA FILA CONTIENE. No es un lujo: el sondeo que hacían los
       -- tres services era max(business_date) sobre v_sellout_daily, y eso solo costaba
       -- **14,587 ms** medidos contra prod — o sea que arreglar la consulta principal y dejar el
       -- sondeo habría dejado la ruta en 14.6 s igual. Acá sale gratis, y además es más honesto:
       -- declara la fecha de lo que se PUBLICA, no la de un dato que existe en otro lado.
       max(sd.business_date)               AS max_business_date,
       now()                               AS refreshed_at
  FROM analytics.v_sellout_daily sd
  JOIN analytics.v_retail_calendar cal
    ON cal.date = sd.business_date
  LEFT JOIN analytics.sellout_channel_map cm
    ON cm.tenant_id = sd.tenant_id AND cm.source = sd.source AND cm.raw_channel = sd.channel
  JOIN analytics.v_sales_entity se
    ON se.tenant_id = sd.tenant_id
   AND se.channel = COALESCE(cm.canonical_channel, sd.channel)
   AND se.warehouse_code = sd.warehouse_code
 GROUP BY 1, 2, 3, 4, 5, 6`;

exports.up = async function up(knex) {
  const ya = (await knex.raw(`SELECT to_regclass('analytics.mv_sellout_budget_rollup') t`)).rows[0].t;
  if (!ya) {
    const t0 = Date.now();
    await knex.raw(MV);
    // UNIQUE es requisito de `REFRESH ... CONCURRENTLY` (sin él el refresco toma lock exclusivo y
    // la pantalla ve la MV vacía mientras dura). `channel` NO va en la llave: está funcionalmente
    // determinada por `entity_key`, que es literalmente `channel || ':' || warehouse_code`.
    await knex.raw(`CREATE UNIQUE INDEX mv_sellout_budget_rollup_pk
                      ON analytics.mv_sellout_budget_rollup (tenant_id, entity_key, fiscal_year, period_no)`);
    await knex.raw(`ANALYZE analytics.mv_sellout_budget_rollup`);
    console.log(`  [mv_sellout_budget_rollup] construida en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  await knex.raw(`GRANT SELECT ON analytics.mv_sellout_budget_rollup TO app_runtime`);

  // ── Auto-verificación ────────────────────────────────────────────────────────────────────
  // (a) La llave es llave. UNIQUE trata los NULL como distintos, así que una llave nullable no
  //     garantizaría nada y `REFRESH CONCURRENTLY` lo descubriría en producción, no acá.
  const k = (await knex.raw(`
    SELECT count(*) AS filas,
           count(*) FILTER (WHERE tenant_id IS NULL OR entity_key IS NULL
                              OR fiscal_year IS NULL OR period_no IS NULL) AS nulos
      FROM analytics.mv_sellout_budget_rollup`)).rows[0];
  if (Number(k.nulos) > 0) {
    throw new Error(`mv_sellout_budget_rollup: ${k.nulos} filas con NULL en la llave`);
  }
  if (Number(k.filas) < 100) {
    throw new Error(`mv_sellout_budget_rollup quedó con ${k.filas} filas: el CREATE no agregó nada`);
  }

  // (b) ⭐ PRUEBA NEGATIVA — un gate sin prueba negativa es una intención (ADR-056).
  //     El join VIEJO (canal crudo contra canónico) tiene que dar ESTRICTAMENTE MENOS.
  //     Si diera igual, el arreglo sería un no-op y esta migración no tendría razón de existir.
  //
  // ⚠️ Los dos lados se miden sobre `mv_sellout_monthly`, NO sobre `v_sellout_daily`. Es el MISMO
  //    universo (verificado leyendo su definición: es `v_sellout_daily` rolada a mes, mismas
  //    columnas, mismo GROUP BY) y cuesta ~1 s en vez de los ~250 s que cuesta cada barrido de la
  //    vista viva sin filtro de tenant. La pregunta que este candado hace es sobre el CANAL, y el
  //    canal no cambia al rolar a mes — pero el precio de preguntarla sí.
  const cmp = (await knex.raw(`
    WITH base AS (SELECT tenant_id, source, channel, warehouse_code, monto FROM analytics.mv_sellout_monthly),
    viejo AS (
      SELECT sum(b.monto) AS v FROM base b
        JOIN analytics.v_sales_entity se
          ON se.tenant_id = b.tenant_id AND se.channel = b.channel
         AND se.warehouse_code = b.warehouse_code
    ), nuevo AS (
      SELECT sum(b.monto) AS v FROM base b
        LEFT JOIN analytics.sellout_channel_map cm
          ON cm.tenant_id = b.tenant_id AND cm.source = b.source AND cm.raw_channel = b.channel
        JOIN analytics.v_sales_entity se
          ON se.tenant_id = b.tenant_id AND se.channel = COALESCE(cm.canonical_channel, b.channel)
         AND se.warehouse_code = b.warehouse_code
    ), crudo AS (SELECT sum(monto) AS v FROM base)
    SELECT (SELECT v FROM viejo) AS viejo, (SELECT v FROM nuevo) AS nuevo, (SELECT v FROM crudo) AS crudo`)).rows[0];
  const viejo = Number(cmp.viejo) || 0;
  const conMapa = Number(cmp.nuevo) || 0;
  const crudo = Number(cmp.crudo) || 0;
  if (!(conMapa > viejo)) {
    throw new Error(
      `El arreglo del canal es un NO-OP: join viejo ${viejo.toFixed(2)} vs con mapa ${conMapa.toFixed(2)}. `
      + `O el mapa de canal cambió, o esta MV no está arreglando nada.`);
  }

  // (c) Cobertura DECLARADA contra el universo crudo (mismo espejo mensual, misma corrida).
  //     No se exige 100 %: hay renglones con `business_date` fuera de `v_retail_calendar`
  //     (medido: 0.023 %, son fechas en 2000 y 2014). Se exige que el hueco sea el MEDIDO.
  const fuera = crudo > 0 ? (100 * (crudo - conMapa)) / crudo : 0;
  if (fuera > 1) {
    throw new Error(
      `El join por entidad deja fuera ${fuera.toFixed(3)} % del sell-out (medido ~0 %). `
      + `Hay un canal o un almacén sin entidad en el catálogo.`);
  }

  // (d) Y que la MV recién poblada cuadre con ese mismo cálculo, dentro del rezago del espejo
  //     mensual (nocturno) contra esta MV (recién creada): la diferencia es la venta de hoy.
  const nuevo = Number((await knex.raw(
    `SELECT sum(monto) AS v FROM analytics.mv_sellout_budget_rollup`)).rows[0].v) || 0;
  const deriva = conMapa > 0 ? Math.abs(100 * (nuevo - conMapa)) / conMapa : 0;
  if (deriva > 2) {
    throw new Error(
      `La MV ($${nuevo.toFixed(2)}) no cuadra con el mismo cálculo sobre el espejo mensual `
      + `($${conMapa.toFixed(2)}): ${deriva.toFixed(2)} % de deriva, más que el rezago de un día.`);
  }

  const comentario = (
    `[PU.V1] Real del sell-out al grano de Presupuestos (entidad x anio fiscal x periodo 13x4). `
    + `Arregla el join de canal: v_sales_entity declara el canal CANONICO y el sell-out emite el `
    + `CRUDO -- unirlos sin pasar por sellout_channel_map tiraba $314,428,861 (28.70%), con tres `
    + `celdas en $0 sobre $208M. Sustituye el Parquet+DuckDB de ADR-075, que vivia en el /tmp `
    + `efimero de cada uno de los 2 pods del API. Refresca AnalyticsRefreshService `
    + `(job analytics_refresh_sellout_budget). Quien la lea DEBE declarar refreshed_at. `
    + `Cobertura medida 2026-10-07: 99.977% del sell-out; el 0.023% restante son fechas sin `
    + `fila en v_retail_calendar.`
  ).replace(/'/g, "''");
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sellout_budget_rollup IS '${comentario}'`);

  console.log(
    `  [mv_sellout_budget_rollup] ${k.filas} filas · join viejo $${viejo.toLocaleString('es-MX')} `
    + `→ nuevo $${nuevo.toLocaleString('es-MX')} (+$${(nuevo - viejo).toLocaleString('es-MX')}) `
    + `· deja fuera ${fuera.toFixed(3)} %`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sellout_budget_rollup CASCADE`);
};
