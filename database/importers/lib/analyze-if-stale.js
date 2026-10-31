/**
 * ANALYZE condicional — refresca estadísticas SÓLO si de verdad cambió algo.
 *
 * [DB-MEM.9] Por qué existe. `import-sales-fact.js` e `import-wincaja-analytics.js` corrían
 * `ANALYZE analytics.sales_daily` **en cada corrida**, con este comentario:
 *
 *     "el bulk-upsert deja stats obsoletas y el planner degrada el sell-out
 *      (medido: rollup de cajas 7.5s→1s con ANALYZE). Barato; corre en cada feed."
 *
 * Era cierto cuando se escribió. Medido en prod el 2026-09-15, ya no:
 *
 *   analytics.sales_daily ......... 4,531,364 filas · 4,488 MB
 *   ANALYZE manual ................ 7,985 veces   (autoanalyze del motor: 1)
 *   ritmo real de cambio .......... 9 inserts + 26 updates en 3 minutos
 *   n_mod_since_analyze ........... 0              ← nada cambió desde el último
 *   costo .......................... 12.2 s × ~20/hora = 4 min de CPU por hora
 *
 * O sea: un ANALYZE completo de una tabla de 4.5 GB, veinte veces por hora, para dar cuenta de
 * ~35 filas — y la mitad de las veces sobre **cero** modificaciones. Lo dispara el carril
 * `livefast` (loop ~60 s), que llama a `import-sales-fact.js` sin parar; el carril nació después
 * de que el ANALYZE se declarara "barato", y nadie volvió a medirlo.
 *
 * Qué hace este helper: le pregunta al propio Postgres cuántas filas se modificaron desde el
 * último ANALYZE (`pg_stat_user_tables.n_mod_since_analyze`) y sólo analiza si pasa el umbral.
 *
 * ⚠️ El umbral NO se inventa: se deriva del que usa el propio motor. El default de
 * `autovacuum_analyze_threshold` + `_scale_factor` es `50 + 0.10 × filas` (para `sales_daily`,
 * ~453,000 filas modificadas). Acá usamos `max(5,000 · 1% de las filas)` = ~45,000, o sea
 * **diez veces más estricto que el motor**: las estadísticas quedan bastante más frescas de lo
 * que el propio Postgres consideraría necesario, y aun así desaparecen los ~20 ANALYZE por hora
 * que hoy corren contra nada.
 *
 * ⚠️ Si no se puede medir (la tabla no existe, o el colector de estadísticas todavía no la
 * reporta), **analiza igual y lo dice** — ADR-056: lo que no se pudo medir se declara, no se
 * asume verde. Saltarse un ANALYZE por ignorancia sí cambiaría resultados (degrada el plan del
 * sell-out); correrlo de más sólo cuesta tiempo.
 */

// Sólo nombres `schema.tabla` de nuestro propio código: ANALYZE no admite parámetros, así que
// el nombre se valida antes de interpolarlo.
const NOMBRE_OK = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/**
 * @param {(sql: string, binds?: any[]) => Promise<{rows: any[]}>} run
 *        Ejecutor. Con node-pg: `s => db.query(s)`. Con knex: `s => db.raw(s)`.
 * @param {string} tabla  `schema.tabla`
 * @param {object} [opt]
 * @param {number} [opt.pct=0.01]   fracción de la tabla que debe haber cambiado
 * @param {number} [opt.minAbs=5000] piso absoluto de filas modificadas
 * @param {(m: string) => void} [opt.log=console.log]
 * @returns {Promise<{analizado: boolean, mods: number|null, umbral: number|null, motivo: string}>}
 */
async function analyzeIfStale(run, tabla, opt = {}) {
  const { pct = 0.01, minAbs = 5000, log = console.log } = opt;
  if (!NOMBRE_OK.test(tabla)) throw new Error(`analyzeIfStale: nombre de tabla inválido: ${tabla}`);

  let mods = null;
  let umbral = null;
  try {
    const r = await run(
      `SELECT n_live_tup::bigint AS vivas, n_mod_since_analyze::bigint AS mods
         FROM pg_stat_user_tables WHERE relid = to_regclass('${tabla}')`);
    const f = r && r.rows && r.rows[0];
    if (f && f.mods != null) {
      mods = Number(f.mods);
      umbral = Math.max(minAbs, Math.round(pct * Number(f.vivas || 0)));
    }
  } catch (e) {
    // El latido nunca rompe al que late: si no se puede medir, se analiza.
    log(`  ⚠ no se pudo medir la frescura de stats de ${tabla} (${e.message}) → ANALYZE igual`);
  }

  if (mods == null) {
    await run(`ANALYZE ${tabla}`);
    return { analizado: true, mods: null, umbral: null, motivo: 'sin medición: se analiza por defecto' };
  }

  if (mods < umbral) {
    log(`  ANALYZE ${tabla}: omitido — ${mods.toLocaleString()} filas modificadas < umbral ${umbral.toLocaleString()}`);
    return { analizado: false, mods, umbral, motivo: 'bajo el umbral' };
  }

  const t0 = Date.now();
  await run(`ANALYZE ${tabla}`);
  log(`  ANALYZE ${tabla}: ${mods.toLocaleString()} filas modificadas ≥ ${umbral.toLocaleString()} → ${Date.now() - t0} ms`);
  return { analizado: true, mods, umbral, motivo: 'sobre el umbral' };
}

/**
 * `[CP.9.3c]` ANALYZE de las tablas de un schema que tienen un índice de EXPRESIÓN sin estadísticas.
 *
 * Por qué existe. Un índice sobre una expresión (`upper(btrim(uuid))`) no le sirve al planificador hasta que un ANALYZE
 * junta las estadísticas DE LA EXPRESIÓN: las de la columna no cuentan. Sin ellas, cualquier igualdad sobre la
 * expresión se estima con la selectividad por defecto, el 0.5 % de la tabla. Y autovacuum no vuelve a analizar una
 * tabla que casi no cambia (su umbral es el 10 % de las filas): un índice creado DESPUÉS de la carga se queda ciego.
 * Medido en prod el 2026-10-30: los nueve índices de expresión de CP.9.3 sobre `contpaqi_ods` se crearon sin ANALYZE;
 * para un UUID con 4 asociaciones el planificador estimaba 4,999 (el 0.5 % de 999,786) y la consulta del dictamen
 * tardaba ~9 s, con seq scan.
 *
 * Qué hace: busca las tablas del schema con algún índice de expresión sin fila en `pg_stats`, las analiza y vuelve a
 * mirar. ⚠️ `pg_stats` sólo le muestra las estadísticas de un índice al DUEÑO de la tabla (o a un superusuario): corrida
 * desde otro rol, todas parecen pendientes, el ANALYZE se las salta y la función las devuelve en `siguenSin`. Es lo
 * correcto —ese rol no puede arreglarlas—, pero no dice que falten. El replicador corre como el dueño. Una tabla vacía ya analizada (`reltuples = 0`) no cuenta: no tiene filas de las que sacar estadísticas.
 * ⛔ Un ANALYZE sin permiso NO falla: avisa y se salta la tabla. Por eso devuelve las que SIGUEN sin estadísticas
 * después de analizar, y quien llama lo declara (ADR-056) en vez de darlo por hecho.
 *
 * @param {(sql: string) => Promise<{rows: any[]}>} run  Ejecutor, como en `analyzeIfStale`.
 * @param {string} esquema
 * @param {object} [opt]
 * @param {(m: string) => void} [opt.log=console.log]
 * @returns {Promise<{analizadas: string[], siguenSin: string[]}>}
 */
async function analyzeIndicesSinEstadisticas(run, esquema, opt = {}) {
  const { log = console.log } = opt;
  if (!/^[a-z_][a-z0-9_]*$/.test(esquema)) throw new Error(`analyzeIndicesSinEstadisticas: schema inválido: ${esquema}`);
  const pendientes = async () => (await run(`
    SELECT DISTINCT t.relname AS tabla
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = '${esquema}' AND x.indexprs IS NOT NULL AND t.reltuples <> 0
       AND NOT EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = n.nspname AND s.tablename = i.relname)
     ORDER BY 1`)).rows.map((r) => r.tabla);

  const antes = await pendientes();
  for (const tabla of antes) {
    const t0 = Date.now();
    await run(`ANALYZE ${esquema}."${tabla.replace(/"/g, '""')}"`);
    log(`  ANALYZE ${esquema}.${tabla}: tenía índices de expresión sin estadísticas → ${Date.now() - t0} ms`);
  }
  const siguenSin = antes.length ? await pendientes() : [];
  if (siguenSin.length) {
    log(`  ⚠ siguen sin estadísticas en ${esquema}: ${siguenSin.join(', ')} (un ANALYZE sin permiso sólo avisa: ¿es el dueño?)`);
  }
  return { analizadas: antes.filter((t) => !siguenSin.includes(t)), siguenSin };
}

module.exports = { analyzeIfStale, analyzeIndicesSinEstadisticas };
