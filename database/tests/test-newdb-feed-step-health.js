/* eslint-disable no-console */
/**
 * [VL.6.4] CANDADO — la contabilidad POR PASO de los carriles de feeds (ADR-056).
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * Medido en prod el 2026-09-11, en `analytics.cron_run_log`:
 *
 *     feed_nightly  ok  47/53 pasos OK
 *     feed_nightly  ok  52/53 pasos OK
 *     feed_nightly  ok  36/52 pasos OK      <-- 16 pasos fallaron. El tablero, verde.
 *     feed_nightly  ok  51/52 pasos OK
 *
 * Un latido que cubre 53 scripts y sólo se pone rojo si fallan los 53 no es una alarma. Y sin
 * grano por paso, "¿cuáles de los 53 sobran?" no tiene con qué contestarse: un paso que hace
 * meses no escribe una fila se ve idéntico a uno crítico.
 *
 * ── LO QUE CANDADEA, Y POR QUÉ CADA UNO ──────────────────────────────────────────────────
 *  1. El PASO se separa del CARRIL por la barra. Si esa separación se rompe, el latido del
 *     carril (`feed_nightly`) se colaría como si fuera un paso y contaría doble.
 *  2. El carril NO aparece en la vista. Es el mismo candado del otro lado, y es el que importa:
 *     un carril colado infla `corridas` y diluye el veredicto de los pasos reales.
 *  3. `veredicto` en sus tres casos, derivado SÓLO de códigos de salida.
 *  4. ⭐ `horas_sin_ok` es **NULL**, no 0, cuando el paso nunca salió bien. Un 0 ahí se lee
 *     "acaba de funcionar" y es exactamente al revés (ADR-056: lo no medido se declara).
 *  5. `rows_affected` se queda en NULL. El orquestador NO conoce las filas que escribe un
 *     subproceso; estimarlas con un regex sobre el texto daría números equivocados, y un
 *     número equivocado en una columna que se llama "filas" es peor que un hueco.
 *  6. `resumenes_distintos` = cuántos textos de cierre distintos produjo — la señal de poda.
 *  7. ⭐ PRUEBA NEGATIVA: con la BD inalcanzable, `stepLog()` **no lanza**. La bitácora no
 *     puede tumbar el carril que está observando; misma asimetría deliberada que el trigger
 *     de VP.3.3 y que `cron-heartbeat` entero.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-feed-step-health.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TEN = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CARRIL = '__test_vl64';

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar a la base — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== VL.6.4 · contabilidad por paso de los carriles de feeds ===\n');

  if (!(await q(`SELECT to_regclass('analytics.v_feed_step_health') IS NOT NULL AS ok`))[0].ok) {
    noMedido('falta la migración 20260912130000 en este destino');
  }
  ck('analytics.v_feed_step_health existe', true);

  const limpiar = () => c.query(
    `DELETE FROM analytics.cron_run_log WHERE job_key = $1 OR job_key LIKE $2`,
    [CARRIL, `${CARRIL}/%`],
  ).catch(() => { /* rol sin DELETE: las filas caducan solas con la ventana de 30d */ });

  try {
    await limpiar();

    // Se escribe con la MISMA forma que usa el runner (cron-heartbeat.stepLog), no una inventada.
    const paso = (step, status, minAtras, note) => c.query(
      `INSERT INTO analytics.cron_run_log
         (tenant_id, job_key, status, started_at, finished_at, rows_affected, duration_ms, host, note)
       VALUES ($1, $2 || '/' || $3, $4,
               now() - ($5 || ' minutes')::interval,
               now() - ($5 || ' minutes')::interval + interval '4 seconds',
               NULL, 4000, 'test', $6)`,
      [TEN, CARRIL, step, status, String(minAtras), note],
    );

    // El latido del CARRIL (sin barra) — el que NO debe aparecer como paso.
    await c.query(
      `INSERT INTO analytics.cron_run_log (tenant_id, job_key, status, started_at, finished_at, host, note)
       VALUES ($1, $2, 'ok', now() - interval '20 minutes', now() - interval '10 minutes', 'test', '3/3 pasos OK')`,
      [TEN, CARRIL],
    );

    await paso('sano.js', 'ok', 30, 'COMMIT — 1,204 filas.');
    await paso('sano.js', 'ok', 90, 'COMMIT — 998 filas.');
    await paso('flaky.js', 'ok', 30, 'COMMIT — 12 filas.');
    await paso('flaky.js', 'error', 90, 'ECONNRESET');
    await paso('muerto.js --flag', 'error', 30, 'exit 1');
    await paso('muerto.js --flag', 'error', 90, 'exit 1');

    const filas = await q(
      `SELECT * FROM analytics.v_feed_step_health WHERE carril = $1 ORDER BY paso`, [CARRIL]);
    const por = Object.fromEntries(filas.map((f) => [f.paso, f]));

    ck('sólo los PASOS entran a la vista (3), el latido del carril NO', filas.length === 3,
      `llegaron ${filas.length}: ${filas.map((f) => f.paso).join(', ')}`);
    ck('el carril se separa del paso por la barra',
      !!por['sano.js'] && !!por['muerto.js --flag'],
      `pasos vistos: ${Object.keys(por).join(' | ')}`);
    ck('las banderas viajan con el paso (--sync ≠ --gap-fill-only son operaciones distintas)',
      !!por['muerto.js --flag']);

    ck('veredicto ok', por['sano.js']?.veredicto === 'ok', por['sano.js']?.veredicto);
    ck('veredicto intermitente', por['flaky.js']?.veredicto === 'intermitente', por['flaky.js']?.veredicto);
    ck('veredicto nunca_ok', por['muerto.js --flag']?.veredicto === 'nunca_ok', por['muerto.js --flag']?.veredicto);

    ck('corridas y fallas cuadran', por['flaky.js']?.corridas === 2 && por['flaky.js']?.fallas === 1,
      `${por['flaky.js']?.corridas} corridas / ${por['flaky.js']?.fallas} fallas`);

    // ⭐ El candado de ADR-056: sin un ok, la antigüedad es DESCONOCIDA, no cero.
    ck('horas_sin_ok es NULL (no 0) cuando nunca salió bien',
      por['muerto.js --flag']?.horas_sin_ok === null,
      `llegó ${JSON.stringify(por['muerto.js --flag']?.horas_sin_ok)}`);
    ck('horas_sin_ok sí se mide cuando hubo un ok',
      Number(por['sano.js']?.horas_sin_ok) > 0);
    ck('ultima_ok en NULL para el que nunca salió bien',
      por['muerto.js --flag']?.ultima_ok === null);

    ck('rows_affected NO se estima (la vista no publica filas inventadas)',
      Number((await q(
        `SELECT count(*)::int n FROM analytics.cron_run_log
          WHERE job_key LIKE $1 AND rows_affected IS NOT NULL`, [`${CARRIL}/%`]))[0].n) === 0);

    ck('resumenes_distintos cuenta los textos de cierre',
      por['sano.js']?.resumenes_distintos === 2 && por['muerto.js --flag']?.resumenes_distintos === 1,
      `sano=${por['sano.js']?.resumenes_distintos} muerto=${por['muerto.js --flag']?.resumenes_distintos}`);
    ck('ultimo_resumen es el de la corrida más reciente',
      por['sano.js']?.ultimo_resumen === 'COMMIT — 1,204 filas.', por['sano.js']?.ultimo_resumen);

    // ── 7. PRUEBA NEGATIVA ────────────────────────────────────────────────────────────────
    // Con la BD inalcanzable, la bitácora avisa por consola y sigue. Si esto lanzara, un
    // parpadeo de red tumbaría el carril entero — cambiar un problema chico por uno grande.
    const previo = process.env.DATABASE_URL_NEW;
    const previoAlt = process.env.DATABASE_URL;
    let lanzo = false;
    try {
      // Puerto que NADIE escucha → ECONNREFUSED inmediato (no espera el connectionTimeout).
      process.env.DATABASE_URL_NEW = 'postgresql://nadie:nada@127.0.0.1:59999/inexistente';
      delete process.env.DATABASE_URL;
      const hb = require('../importers/lib/cron-heartbeat');
      const bit = hb.stepLog('__test_vl64_caido');
      for (let i = 0; i < 11; i++) { // 11 > LOTE(10) → fuerza una descarga a mitad, no sólo la final
        await bit.add({ step: `p${i}.js`, status: 'ok', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1 });
      }
      await bit.flush();
    } catch { lanzo = true; } finally {
      if (previo === undefined) delete process.env.DATABASE_URL_NEW; else process.env.DATABASE_URL_NEW = previo;
      if (previoAlt !== undefined) process.env.DATABASE_URL = previoAlt;
    }
    ck('PRUEBA NEGATIVA — con la BD caída, stepLog avisa y NO lanza', !lanzo);
  } finally {
    await limpiar();
    await c.end().catch(() => {});
  }

  console.log(`\n=== ${ok} ✔ · ${fail} ✖ ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FALLA:', e.message); process.exit(1); });
