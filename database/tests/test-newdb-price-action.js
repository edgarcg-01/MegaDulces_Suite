/**
 * `[PR.L1]` — **La capa 3 del motor de margen: el triage, y las cosas que NO puede volver a
 * hacer.**
 *
 * ⭐ Este candado no comprueba que el motor acierte: comprueba que **no vuelva a mentir de las
 * cuatro maneras en que ya mintio**, cada una encontrada mirando renglones reales despues de que
 * las compuertas de su propia migracion salieran en verde.
 *
 * Bloques:
 *   1. Forma: el grano, las acciones, el default honesto.
 *   2. ⭐⭐ R7 — las 3 senales que mas pesaron, MEDIDAS EN PESOS. Sin coeficientes inventados.
 *   3. ⛔ Las regresiones prohibidas:
 *        a. un SALDO en la columna de FLUJO (se llevaba los 12 primeros lugares de la cola)
 *        b. la MERMA en R7 (su razon no es una tasa aplicable a la venta)
 *        c. un "aterrizaje" que el cliente SI percibe (TIEMPO AIRE: $1.00 -> $1.99, +99 %)
 *        d. una accion sin monto NI motivo
 *        e. [PR.V10] la VENTA de la escalera en la columna de flujo (mezclaba unidades en la barra)
 *        f. [PR.V10] un monto de flujo con otra unidad declarada
 *        g. [PR.V10] un "saldo" mayor que el inventario ENTERO: era el consumo de un año
 *   4. ⛔ Lo REFUTADO sigue refutado: el sugerido del ERP es identicamente la deriva de costo.
 *   5. La consulta que hace una PANTALLA, bajo 1 s.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-price-action.js
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
  const q = async (s) => (await c.query(s)).rows;
  console.log('\n=== [PR.L1] · la capa 3: el triage de precio ===\n');

  const [ex] = await q(`SELECT to_regclass('analytics.v_price_action') IS NOT NULL AS ok`);
  if (!ex.ok) noMedido('falta la migracion 20260930230000 en este destino');

  // ── 1 · FORMA ───────────────────────────────────────────────────────────────────────
  console.log('1 · LA FORMA — y el default honesto');
  const t0 = Date.now();
  const [g] = await q(`
    SELECT count(*)::int filas,
           count(DISTINCT accion)::int acciones,
           count(*) FILTER (WHERE accion = 'sin_accion_defendible')::int sin_accion,
           count(*) FILTER (WHERE NOT accionable)::int bloqueadas,
           count(*) FILTER (WHERE accionable AND cardinality(bloqueos) > 0)::int incoherentes,
           count(*) FILTER (WHERE certeza = 'sin_evidencia'
                              AND accion <> 'sin_accion_defendible')::int certeza_mal
      FROM analytics.v_price_action`);
  const ms = Date.now() - t0;
  console.log(`     ${g.filas.toLocaleString()} filas en ${ms} ms · ${g.acciones} acciones distintas`);
  /**
   * [PR.V10] El grano es el de la MV, no un numero fijo: el candado nacio con 86,163 y prod ya
   *    tiene 86,816 (2026-10-30) -- un literal se pone rojo en cualquier base que no sea aquella.
   *    Lo que importa es que la vista no duplique ni pierda celdas (el saldo entra por un join).
   */
  const [{ filas_mv: filasMv }] = await q('SELECT count(*)::int filas_mv FROM analytics.mv_price_signals');
  ck('el grano es el de la MV: el join del saldo no duplica ni pierde celdas', g.filas === filasMv,
    `vista ${g.filas} · MV ${filasMv}`);
  /**
   * ⭐ El default tiene que ser la MAYORIA. Un tablero donde todo es urgente no prioriza nada,
   *    y un motor que siempre tiene algo que decir es un motor que no esta mirando la evidencia.
   */
  ck('⭐ el default `sin_accion_defendible` es la mayoria de las celdas',
    g.sin_accion > g.filas * 0.5,
    `solo ${g.sin_accion} de ${g.filas}: el triage dejo de discriminar`);
  ck('⛔ ninguna celda accionable con bloqueos activos', g.incoherentes === 0);
  ck('⛔ ninguna accion con certeza `sin_evidencia`', g.certeza_mal === 0);
  console.log(`     sin accion ${g.sin_accion.toLocaleString()} `
    + `(${((100 * g.sin_accion) / g.filas).toFixed(1)} %) · bloqueadas ${g.bloqueadas.toLocaleString()}`);

  // ── 2 · ⭐⭐ R7, EN PESOS ────────────────────────────────────────────────────────────
  console.log('\n2 · ⭐⭐ R7 — las 3 senales que mas pesaron, medidas en PESOS');
  const [r] = await q(`
    SELECT count(*) FILTER (WHERE s1_senal IS NOT NULL)::int con_aporte,
           count(*) FILTER (WHERE s2_mxn IS NOT NULL AND abs(s1_mxn) < abs(s2_mxn))::int orden12,
           count(*) FILTER (WHERE s3_mxn IS NOT NULL AND abs(s2_mxn) < abs(s3_mxn))::int orden23,
           count(*) FILTER (WHERE s1_senal IS NOT NULL AND s1_mxn IS NULL)::int senal_sin_monto,
           count(*) FILTER (WHERE aportes_medibles = 0 AND s1_senal IS NOT NULL)::int cuenta_mal,
           count(DISTINCT s1_senal)::int senales_distintas
      FROM analytics.v_price_action`);
  ck('⭐⭐ el orden de R7 es correcto: 1 >= 2 >= 3 en monto absoluto',
    r.orden12 === 0 && r.orden23 === 0, `1<2 en ${r.orden12} · 2<3 en ${r.orden23}`);
  ck('⛔ ninguna senal nombrada sin su monto', r.senal_sin_monto === 0);
  ck('el contador de aportes cuadra con lo publicado', r.cuenta_mal === 0);
  /**
   * ⭐ Si siempre ganara la misma senal, R7 no estaria explicando nada: seria una etiqueta fija.
   */
  ck('⭐ R7 nombra senales DISTINTAS segun la celda', r.senales_distintas >= 3,
    `solo ${r.senales_distintas} senal(es) llega(n) al primer lugar`);
  console.log(`     ${r.con_aporte.toLocaleString()} celdas con aporte medido · `
    + `${r.senales_distintas} senales distintas encabezan`);

  // ── 3 · ⛔ LAS CUATRO REGRESIONES PROHIBIDAS ────────────────────────────────────────
  console.log('\n3 · ⛔ las cuatro maneras en que este motor YA mintio');
  const [p] = await q(`
    SELECT count(*) FILTER (WHERE accion = 'liberar_capital'
                              AND monto_en_juego_mxn IS NOT NULL)::int saldo_en_flujo,
           count(*) FILTER (WHERE s1_senal = 'merma' OR s2_senal = 'merma'
                              OR s3_senal = 'merma')::int merma_en_r7,
           count(*) FILTER (WHERE accion = 'aterrizar_precio'
                              AND d1_alza_99_pct > d4_umbral_percepcion)::int aterrizaje_perceptible,
           count(*) FILTER (WHERE accion <> 'sin_accion_defendible'
                              AND monto_en_juego_mxn IS NULL
                              AND monto_motivo IS NULL)::int sin_monto_ni_motivo,
           max(d1_alza_99_pct) FILTER (WHERE accion = 'aterrizar_precio') AS alza_max,
           count(*) FILTER (WHERE accion = 'precio_atipico')::int atipicos,
           count(*) FILTER (WHERE capital_inmovilizado_mxn IS NOT NULL)::int con_saldo,
           count(*) FILTER (WHERE accion = 'corregir_escalera'
                              AND monto_en_juego_mxn IS NOT NULL)::int escalera_en_flujo,
           count(*) FILTER (WHERE monto_en_juego_mxn IS NOT NULL
                              AND monto_unidad IS DISTINCT FROM 'flujo_30d')::int unidad_mezclada,
           count(*) FILTER (WHERE accion = 'liberar_capital')::int liberar,
           round(sum(capital_inmovilizado_mxn)::numeric, 0) saldo
      FROM analytics.v_price_action`);

  ck('⛔ a · ningun SALDO de inventario en la columna de FLUJO', p.saldo_en_flujo === 0,
    `${p.saldo_en_flujo} celdas — sumaban $60.4 M y se llevaban los 12 primeros lugares`);
  ck('⛔ b · la MERMA no vuelve a R7 (su razon no es una tasa aplicable a la venta)',
    p.merma_en_r7 === 0, `${p.merma_en_r7} celdas la nombran`);
  ck('⛔ c · ningun "aterrizaje" implica un alza que el cliente SI percibe',
    p.aterrizaje_perceptible === 0,
    `${p.aterrizaje_perceptible} celdas — asi es como TIEMPO AIRE pasaba de $1.00 a $1.99`);
  ck('⛔ d · ninguna accion sin monto NI motivo', p.sin_monto_ni_motivo === 0);
  ck('⛔ e · [PR.V10] la venta de la escalera NO va en la columna de flujo', p.escalera_en_flujo === 0,
    `${p.escalera_en_flujo} celdas: la barra volveria a comparar una venta con un incremento`);
  ck('⛔ f · [PR.V10] todo monto de flujo declara la unidad flujo_30d', p.unidad_mezclada === 0,
    `${p.unidad_mezclada} celdas con otra unidad`);

  /**
   * [PR.V15] El freno de ISCAM: SOLO para subir el precio, y ninguna que pierda terreno queda libre.
   */
  const [{ hay: hayH4 }] = await q(`SELECT count(*) > 0 AS hay FROM pg_attribute
     WHERE attrelid = 'analytics.v_price_action'::regclass AND attname = 'h4_pierde_terreno' AND NOT attisdropped`);
  if (!hayH4) {
    sinMedir('h · el freno de ISCAM', 'falta la migracion 20261030123253 en este destino');
  } else {
    const [h] = await q(`
      SELECT count(*) FILTER (WHERE 'pierde_terreno_en_la_categoria' = ANY (bloqueos) AND accion <> 'subir_precio')::int fuera,
             count(*) FILTER (WHERE accion = 'subir_precio' AND h4_pierde_terreno AND accionable)::int libres,
             count(*) FILTER (WHERE h4_pierde_terreno AND (h4_share_delta_pp >= 0 OR h4_crec_competencia_pct <= 0))::int regla
        FROM analytics.v_price_action`);
    ck('⛔ h · [PR.V15] el freno de terreno sólo toca subir_precio', h.fuera === 0, `${h.fuera} celdas de otra acción frenadas`);
    ck('⛔ h · [PR.V15] ninguna subir_precio que pierde terreno queda libre', h.libres === 0, `${h.libres} libres`);
    ck('⛔ h · [PR.V15] pierde terreno = participación baja Y competencia crece', h.regla === 0, `${h.regla} sin cumplir la regla`);
  }

  /**
   * ⛔⛔ g · LA PRUEBA NEGATIVA DE [PR.V10]: el saldo de una PARTE del inventario no puede pasar
   *    del inventario ENTERO valuado igual. El numero viejo (g2_valor_anual, consumo anual) la
   *    violaba: $81.3 M contra $71.7 M de existencia en toda la empresa (prod, 2026-10-30).
   */
  const [inv] = await q(`
    SELECT round(sum(s.e3_existencia * u.costo_unitario)::numeric, 0) inventario
      FROM analytics.mv_price_signals s
      JOIN commercial.warehouses w ON w.kepler_code = s.sucursal AND w.deleted_at IS NULL
      JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.sku::text = s.sku AND p.deleted_at IS NULL
      JOIN analytics.mv_erp_unit_cost u ON u.tenant_id = w.tenant_id AND u.warehouse_id = w.id
                                       AND u.product_id = p.id
     WHERE s.e3_existencia > 0 AND u.costo_unitario > 0`);
  if (p.liberar === 0) {
    sinMedir('g · el saldo contra el inventario', 'no hay celdas de liberar_capital en este destino');
  } else {
    ck('⛔⛔ g · [PR.V10] el saldo de liberar_capital no pasa del inventario entero',
      Number(p.saldo ?? 0) <= Number(inv.inventario ?? 0),
      `saldo $${Number(p.saldo).toLocaleString()} > inventario $${Number(inv.inventario).toLocaleString()}: volvio el consumo anual`);
    ck('[PR.V10] el saldo se pudo valuar en al menos 90 % de las celdas de liberar_capital',
      p.con_saldo >= p.liberar * 0.9, `${p.con_saldo} de ${p.liberar}`);
  }
  console.log(`     el alza maxima de un aterrizaje es ${p.alza_max} % (llego a 99 %) · `
    + `${p.atipicos} precios atipicos apartados · ${p.con_saldo.toLocaleString()} con saldo aparte`);

  /**
   * ⭐ Control positivo del guardia: si NADIE cayera en `precio_atipico`, el guardia no estaria
   *    midiendo nada y el defecto de TIEMPO AIRE habria vuelto sin que nada se pusiera rojo.
   */
  ck('⭐ CONTROL: el guardia de precios atipicos sigue atrapando casos', p.atipicos > 0,
    'cero atipicos: el guardia no mide nada');

  // ── 4 · ⛔ LO REFUTADO SIGUE REFUTADO ───────────────────────────────────────────────
  console.log('\n4 · ⛔ el sugerido del ERP ES la deriva de costo, y por eso no es el motor');
  /**
   * La identidad: precio_sug/precio_actual = [costo_hoy x (1+mk) x (1+t)] / [costo_ficha x
   * (1+mk) x (1+t)] = costo_hoy/costo_ficha. El markup y el impuesto se CANCELAN. Si esto
   * dejara de cumplirse, la formula del ERP cambio y hay que enterarse.
   */
  const [id] = await q(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs((a1_costo_hoy / NULLIF(a2_costo_ficha, 0) - 1) * 100
                                      - a6_deriva_costo_pct) < 0.02)::int identicos
      FROM analytics.v_price_action
     WHERE a1_costo_hoy > 0 AND a2_costo_ficha > 0 AND a6_deriva_costo_pct IS NOT NULL`);
  const pctId = id.n ? (100 * id.identicos) / id.n : 0;
  ck('⛔ la deriva de costo ES el sugerido del ERP (markup e impuesto se cancelan)',
    pctId > 99, `solo ${pctId.toFixed(2)} % de ${id.n.toLocaleString()} celdas`);
  console.log(`     ${id.identicos.toLocaleString()} de ${id.n.toLocaleString()} `
    + `(${pctId.toFixed(2)} %) — por eso ese "motor" no dice nada nuevo`);

  // ── 5 · LA CONSULTA DE PANTALLA ─────────────────────────────────────────────────────
  console.log('\n5 · la consulta que hace una PANTALLA');
  const t1 = Date.now();
  const cola = await q(`
    SELECT sucursal, sku, accion, monto_en_juego_mxn, s1_senal
      FROM analytics.v_price_action
     WHERE sucursal = '03' AND accionable AND accion <> 'sin_accion_defendible'
     ORDER BY abs(monto_en_juego_mxn) DESC NULLS LAST LIMIT 50`);
  const msP = Date.now() - t1;
  ck(`⭐ la cola de una plaza, top 50 por dinero, bajo 1 s (${msP} ms)`,
    msP < 1000 && cola.length > 0, `${msP} ms, ${cola.length} filas`);

  const t2 = Date.now();
  await q(`SELECT accion, certeza, count(*)::int, sum(monto_en_juego_mxn)
             FROM analytics.v_price_action GROUP BY 1, 2`);
  ck('⭐ el resumen por accion, bajo 1 s', Date.now() - t2 < 1000, `${Date.now() - t2} ms`);

  if (ms > 8000) sinMedir('el barrido completo', `tarda ${ms} ms: declarado, no oculto`);

  await c.end();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} ✓ / ${fail} ✗${nm ? ` / ${nm} no medidos` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\n💥', e.message); process.exit(1); });
