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

module.exports = { analyzeIfStale };
