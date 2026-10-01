/**
 * `[PR.X]` — **El expediente del SKU: la historia, el umbral y lo que NO se puede medir.**
 *
 * ⭐ Lo que este candado vigila no es que los números estén bien: es que **las cosas que no se
 * pueden medir sigan declarándose**, y que los cuatro filtros que limpian la bitácora de precios
 * no se aflojen sin que nadie lo note.
 *
 * Bloques:
 *   1. ⭐ El umbral de equilibrio, probado **aislado con valores elegidos** — sin datos ni
 *      ambiente, como las tres funciones de `v_price_psychology`.
 *   2. La serie mensual: ningún costo sin unidades detrás, y la cobertura parcial **existe**.
 *   3. ⛔ Los cuatro filtros de la bitácora, cada uno con su prueba.
 *   4. ⭐⭐ El event-study y su PLACEBO — incluida la prueba de que hoy **no es legible**.
 *   5. La demanda perdida y su fecha de caducidad.
 *   6. Las matvistas ≡ sus vistas, y la consulta que hace la ventana bajo 1 s.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-expediente.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};
const sinMedir = (l, d) => { nm++; console.log(`  ⓘ NO MEDIDO: ${l} — ${d}`); };

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
    statement_timeout: 300000,
  });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== [PR.X] · el expediente del SKU ===\n');

  const [ex] = await q(`SELECT to_regclass('analytics.v_sku_cost_sales_monthly') IS NOT NULL AS ok`);
  if (!ex.ok) noMedido('faltan las migraciones 202609302500xx en este destino');

  // ── 1 · ⭐ EL UMBRAL, AISLADO ───────────────────────────────────────────────────────
  console.log('1 · ⭐ el umbral de equilibrio, con valores elegidos');
  /**
   * ⭐ Sin datos y sin ambiente. Es lo que hace que un signo invertido o un divisor mal puesto
   *    se vea acá y no seis semanas después, dentro de una decisión de precio.
   */
  const CASOS = [
    [100, 80, 110, 33.33, 'sube 10 %: margen 20 → 30, se tolera perder un tercio'],
    [100, 80, 120, 50.00, 'sube 20 %: margen 20 → 40, se tolera perder la mitad'],
    [100, 80, 90, -100.00, '⭐ BAJA 10 %: margen 20 → 10, hay que DUPLICAR el volumen'],
    [100, 90, 101, 9.09, 'margen flaco: un alza de 1 % ya tolera 9 % de caída'],
    [100, 80, 80, null, '⛔ el precio nuevo queda EN el costo'],
    [100, 80, 70, null, '⛔ el precio nuevo queda BAJO el costo'],
    [100, 120, 130, null, '⛔ ya se vende bajo costo: el punto de partida no es comparable'],
    [100, null, 110, null, '⛔ sin costo no hay umbral'],
  ];
  let malos = 0;
  for (const [pa, co, pn, esp, por] of CASOS) {
    const [{ r }] = await q(
      `SELECT analytics.fn_umbral_equilibrio($1::numeric,$2::numeric,$3::numeric) AS r`, [pa, co, pn]);
    const bien = esp === null ? r === null : (r !== null && Math.abs(Number(r) - esp) < 0.01);
    if (!bien) { malos += 1; console.log(`     ✖ (${pa}, ${co}, ${pn}) = ${r}, se esperaba ${esp} · ${por}`); }
  }
  ck(`⭐ los ${CASOS.length} casos del umbral, aislados`, malos === 0, `${malos} fallan`);

  // ── 2 · LA SERIE MENSUAL ────────────────────────────────────────────────────────────
  console.log('\n2 · la serie de costo, precio y volumen');
  const [m] = await q(`
    SELECT count(*)::int filas, count(DISTINCT (sucursal, sku))::int pares,
           count(*) FILTER (WHERE costo_unitario IS NOT NULL
                              AND COALESCE(unidades_costeadas, 0) <= 0)::int fantasma,
           count(*) FILTER (WHERE cobertura_costo_pct < 0 OR cobertura_costo_pct > 100)::int rota,
           count(*) FILTER (WHERE cobertura_costo_pct < 100)::int parciales,
           to_char(min(mes), 'YYYY-MM') desde, to_char(max(mes), 'YYYY-MM') hasta
      FROM analytics.v_sku_cost_sales_monthly`);
  console.log(`     ${m.filas.toLocaleString()} filas · ${m.pares.toLocaleString()} pares · `
    + `${m.desde} → ${m.hasta} · meses con cobertura parcial ${m.parciales.toLocaleString()}`);
  ck('⛔ ningún costo unitario sin unidades costeadas detrás', m.fantasma === 0);
  ck('⛔ ninguna cobertura fuera de 0-100', m.rota === 0);
  /**
   * ⭐ La cobertura parcial TIENE que existir. Si diera cero, el filtro por `metodo_costo` no
   *    estaría separando nada y las 143,194 unidades sin costo quedarían escondidas dentro del
   *    promedio — que es justo lo que esta vista existe para evitar.
   */
  ck('⭐ la cobertura parcial existe (el filtro por metodo_costo separa de verdad)',
    m.parciales > 0, 'cero meses parciales: el hueco de costo quedaría escondido');

  // ── 3 · ⛔ LOS CUATRO FILTROS DE LA BITÁCORA ───────────────────────────────────────
  console.log('\n3 · ⛔ los cuatro filtros que limpian la bitácora de precios');
  const [e] = await q(`
    SELECT count(*)::int eventos,
           count(*) FILTER (WHERE precio_antes <= 1 OR precio_despues <= 1)::int centinelas,
           round(min(abs(cambio_pct))::numeric, 3) min_pct,
           count(*) FILTER (WHERE veredicto_unidad = 'unidades_discrepan')::int discrepan,
           count(*) FILTER (WHERE unidades_en_evento > 1)::int multi
      FROM analytics.mv_sku_price_events`);
  ck('⛔ 1 · ningún centinela de $1 o menos sobrevive (es la oscilación, no un precio)',
    e.centinelas === 0, `${e.centinelas} quedaron`);
  ck('⛔ 3 · ningún cambio por debajo del 1 % (eso es recosteo, no decisión)',
    Number(e.min_pct) >= 1, `el mínimo es ${e.min_pct} %`);
  /**
   * ⛔ 4 · La dedup. Yo di por hecho que el % sería idéntico entre PAQ, CJA, PZA y KG, y la
   *    medición lo refutó: 24 % de los eventos multi-unidad difieren más de 2 pp. Si esto
   *    diera cero, el veredicto no estaría discriminando y volvería el riesgo de publicar
   *    el porcentaje de una unidad al azar.
   */
  ck('⛔ 4 · hay eventos multi-unidad y los que discrepan están marcados',
    e.multi > 0 && e.discrepan > 0,
    `multi ${e.multi}, discrepan ${e.discrepan}`);
  // El neto del día: un par no puede tener dos filas la misma fecha.
  const [dup] = await q(`
    SELECT count(*)::int n FROM (
      SELECT sucursal, sku, fecha FROM analytics.mv_sku_price_events
       GROUP BY 1, 2, 3 HAVING count(*) > 1) z`);
  ck('⛔ 2 · un par tiene UNA fila por fecha (el neto del día, no cada escritura)', dup.n === 0,
    `${dup.n} fechas con más de una fila`);
  console.log(`     ${e.eventos.toLocaleString()} eventos · multi-unidad ${e.multi.toLocaleString()} `
    + `· discrepan ${e.discrepan.toLocaleString()}`);

  // ── 4 · ⭐⭐ EL EVENT-STUDY Y SU PLACEBO ───────────────────────────────────────────
  console.log('\n4 · ⭐⭐ qué pasó las veces anteriores — y por qué hoy NO se puede leer');
  const [r] = await q(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE veredicto = 'medible')::int medibles,
           count(*) FILTER (WHERE veredicto = 'sin_linea_base')::int sin_base,
           count(*) FILTER (WHERE veredicto = 'sin_linea_base' AND lr_post IS NOT NULL)::int fantasma,
           count(*) FILTER (WHERE veredicto <> 'medible' AND motivo IS NULL)::int mudas,
           count(*) FILTER (WHERE veredicto = 'medible' AND lr_pre IS NULL)::int sin_placebo,
           round(avg(lr_post) FILTER (WHERE veredicto = 'medible')::numeric, 4) efecto,
           round(avg(lr_pre)  FILTER (WHERE veredicto = 'medible')::numeric, 4) placebo
      FROM analytics.mv_sku_price_response`);
  console.log(`     ${r.medibles.toLocaleString()} medibles de ${r.filas.toLocaleString()} · `
    + `efecto ${r.efecto} · ⭐ PLACEBO ${r.placebo}`);
  ck('⛔ ningún efecto publicado sin línea base (eso infló +4.67 pp un DiD previo)',
    r.fantasma === 0);
  ck('⛔ todo veredicto que no es medible lleva su motivo', r.mudas === 0);
  ck('⭐ el placebo viaja en la MISMA fila que el efecto', r.sin_placebo === 0,
    `${r.sin_placebo} medibles sin placebo`);
  ck('⭐ los que no tienen línea base existen y están separados', r.sin_base > 0,
    'cero sin_linea_base: el guard no separa nada');

  /**
   * ⭐⭐ LA PRUEBA QUE SOSTIENE TODA LA PANTALLA. Hoy esta medición NO es legible, y hay dos
   * hechos que lo demuestran. Si alguno dejara de ser cierto, la pantalla estaría diciendo
   * "no comparable" sobre un dato que SÍ se volvió comparable — y eso hay que enterarse.
   */
  const [inc] = await q(`
    SELECT round(avg(lr_pre)::numeric, 4) AS placebo,
           round(avg(lr_post) FILTER (WHERE es_alza)::numeric, 4) AS efecto_alza,
           round(avg(lr_post) FILTER (WHERE NOT es_alza)::numeric, 4) AS efecto_baja,
           round((avg(lr_post) FILTER (WHERE es_alza) - avg(lr_pre) FILTER (WHERE es_alza))::numeric, 4) AS did_alza,
           round((avg(lr_post) FILTER (WHERE NOT es_alza) - avg(lr_pre) FILTER (WHERE NOT es_alza))::numeric, 4) AS did_baja
      FROM analytics.mv_sku_price_response WHERE veredicto = 'medible'`);
  console.log(`     alza: DiD ${inc.did_alza} · baja: DiD ${inc.did_baja} · placebo ${inc.placebo}`);
  ck('⛔ la pre-tendencia NO es plana: las ventanas no son comparables',
    Math.abs(Number(inc.placebo)) > 0.1,
    `el placebo bajó a ${inc.placebo}: puede que ya SE PUEDA medir — revisar la pantalla`);
  /**
   * ⭐⭐ Y la prueba más fuerte: una BAJA de precio y un ALZA producen el mismo signo. Ninguna
   *    curva de demanda hace eso. Es reversión a la media — el precio se toca justo después
   *    de un pico de ventas, y el pico revierte solo.
   */
  ck('⛔ un alza y una baja mueven el volumen en el MISMO sentido (es un artefacto)',
    Number(inc.did_alza) < 0 && Number(inc.did_baja) < 0,
    `alza ${inc.did_alza}, baja ${inc.did_baja}: los signos se separaron — puede que ahora SÍ `
    + 'se esté midiendo el precio y no la reversión');

  // ── 5 · LA DEMANDA PERDIDA ──────────────────────────────────────────────────────────
  console.log('\n5 · la demanda perdida, con su fecha de caducidad');
  const [p] = await q(`
    SELECT count(*)::int filas, count(DISTINCT sucursal)::int plazas,
           round(sum(importe_perdido)::numeric, 0) importe,
           max(dias_de_atraso)::int atraso_max,
           count(*) FILTER (WHERE dias_de_atraso > 45 AND motivo_atraso IS NULL)::int mudas
      FROM analytics.v_sku_lost_demand`);
  console.log(`     ${p.filas.toLocaleString()} filas · ${p.plazas} plazas · `
    + `$${Number(p.importe).toLocaleString()} · atraso máximo ${p.atraso_max} días`);
  ck('⛔ toda fila atrasada lleva su motivo', p.mudas === 0);
  /**
   * ⭐ El atraso TIENE que existir: Wincaja dejó de registrar el día que cada plaza migró a
   *    Kepler. Si diera cero, la pantalla publicaría como actual un dato que se detuvo hace
   *    meses — y el importe se leería como presión competitiva de hoy.
   */
  ck('⭐ el corte a Kepler se refleja (el dato no se publica como actual)', p.atraso_max > 30,
    `atraso máximo de ${p.atraso_max} días: el corte dejó de reflejarse`);

  // ── 6 · LAS MATVISTAS Y LA VENTANA ─────────────────────────────────────────────────
  console.log('\n6 · las matvistas ≡ sus vistas, y lo que tarda la ventana');
  for (const [mv, vista] of [
    ['analytics.mv_sku_price_events', 'analytics.v_sku_price_events'],
    ['analytics.mv_sku_price_response', 'analytics.v_sku_price_response'],
  ]) {
    const [col] = await q(`
      SELECT count(*)::int falta FROM pg_attribute a
       WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname NOT IN (SELECT b.attname FROM pg_attribute b
                                WHERE b.attrelid = $2::regclass AND b.attnum > 0
                                  AND NOT b.attisdropped)`, [vista, mv]);
    const [pob] = await q(`SELECT relispopulated p FROM pg_class WHERE oid = $1::regclass`, [mv]);
    ck(`⭐ ${mv.split('.')[1]} conserva todas las columnas de su vista y está poblada`,
      col.falta === 0 && pob.p === true, `faltan ${col.falta}`);
  }

  const [par] = await q(`
    SELECT sucursal, sku FROM analytics.mv_sku_price_response
     WHERE veredicto = 'medible' GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`);
  if (!par) {
    sinMedir('la consulta de la ventana', 'ningún par con event-study medible');
  } else {
    const CONS = [
      ['historia', `SELECT * FROM analytics.v_sku_cost_sales_monthly
                     WHERE sucursal = $1 AND sku = $2 ORDER BY mes`],
      ['eventos', `SELECT * FROM analytics.mv_sku_price_events
                    WHERE sucursal = $1 AND sku = $2 ORDER BY fecha DESC LIMIT 40`],
      ['event-study', `SELECT * FROM analytics.mv_sku_price_response
                        WHERE sucursal = $1 AND sku = $2 ORDER BY fecha DESC`],
      // ⚠️ Los casts no son decorativos: estas dos no usan $1 y sin `::text` Postgres no puede
      //    inferir su tipo (42P18), y el candado muere con un mensaje que no se parece a la causa.
      ['plazas', `SELECT * FROM analytics.v_price_action
                   WHERE sku = $2::text AND $1::text IS NOT NULL ORDER BY sucursal`],
      ['perdida', `SELECT * FROM analytics.v_sku_lost_demand
                    WHERE sku = $2::text AND $1::text IS NOT NULL ORDER BY mes DESC LIMIT 24`],
    ];
    let peor = 0; let peorN = '';
    for (const [n, sql] of CONS) {
      const t = Date.now();
      await q(sql, [par.sucursal, par.sku]);
      const ms = Date.now() - t;
      if (ms > peor) { peor = ms; peorN = n; }
    }
    ck(`⭐ las 5 consultas de la ventana, bajo 1 s (peor: ${peorN} ${peor} ms)`, peor < 1000,
      `${peorN} tarda ${peor} ms — sobre la vista eran 3,166 y 6,925`);
  }

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗${nm ? ` / ${nm} no medidos` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
