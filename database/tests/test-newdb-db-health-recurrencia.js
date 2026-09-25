/* eslint-disable no-console */
/**
 * [DH.1] EL TABLERO DEJA DE OLVIDAR — con su prueba NEGATIVA.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 * `/admin/db-health` leía `analytics.cron_runs`, que guarda **una sola fila por carril: la última
 * corrida**. Así el tablero sólo sabía responder *"¿cómo está en este instante?"*, y un carril que
 * falla y se recupera al ciclo siguiente se ve —justo cuando alguien mira— **idéntico a uno sano**.
 *
 * Medido contra prod el 2026-09-25 sobre 7 días de `analytics.cron_run_log`:
 *
 *     cdc_reconcile ............................ 109 de 619 fallaron (17.6 %)
 *       y 103 de esas fallas dicen textual "el carril esta perdiendo filas"
 *     feed_nightly/import-cash-cuts.js .......... 6 de 6 (100 %)   ← una semana entera
 *     backup_prod ............................... 3 de 6 (50 %)
 *     stock_snapshot ............................ 2 de 3 (66.7 %)
 *
 * `cdc_reconcile` es **la única alarma de completitud del ODS**. Estaba gritando seis veces por día
 * y la página lo pintaba VERDE. Y los pasos (`padre/paso.js`) no existían en la pantalla: el runner
 * marca el carril en `error` sólo si fallan TODOS sus pasos, así que el importer de cortes de caja
 * llevaba siete noches fallando con `feed_nightly` en `ok`.
 *
 * ── Qué mide ────────────────────────────────────────────────────────────────────────────────
 *   1. la regla REAL se importa del servicio (`recurrenciaLevantaLaMano`), no se copia acá — un
 *      test que reescribe la regla se pone verde el día que alguien cambia la de producción;
 *   2. **prueba NEGATIVA**: se le pasan semanas sanas y tiene que NO marcar, y semanas enfermas y
 *      tiene que marcar. Los cuatro bordes del umbral, uno por uno;
 *   3. el SQL de la ventana corre contra la DB real y devuelve la forma que el servicio espera;
 *   4. ⭐ y el contraste que de verdad importa: se listan los carriles que HOY están `ok` en
 *      `cron_runs` y sin embargo fallaron por encima del umbral en la semana. Si esa lista está
 *      vacía **el bloque se DECLARA `NO MEDIDO`** en vez de ponerse verde: sin un solo carril
 *      enfermo, esto no comprobó nada.
 *
 * Sólo LEE.
 */
const path = require('path');
const { Client } = require('pg');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); }
catch { /* el runner puede traer el env ya cargado */ }

let ok = 0; let fail = 0; let nm = 0;
const A = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); } };
const ND = (msg) => { nm++; console.log(`  · NO MEDIDO — ${msg}`); };

function cargarRegla() {
  // Se carga el .ts DE PRODUCCIÓN con ts-node. Si no se puede, se DECLARA: copiar la regla acá
  // sería probar mi copia, que es exactamente lo que este test existe para no hacer.
  try {
    // `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir de Nx) y
    // aborta con TS5011 antes de compilar. Mismo patrón que `test-newdb-scope-params.js`.
    require('ts-node').register({
      transpileOnly: true, skipProject: true,
      compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
    });
    return require(path.resolve(__dirname, '..', '..', 'apps', 'api', 'src', 'modules', 'db-health', 'db-health-recurrencia.ts'));
  } catch (e) {
    return { _error: e.message };
  }
}

(async () => {
  console.log('\n1) la regla REAL del servicio (no una copia)');
  const mod = cargarRegla();
  if (mod._error || typeof mod.recurrenciaLevantaLaMano !== 'function') {
    ND(`no se pudo cargar db-health.service.ts: ${mod._error || 'no exporta recurrenciaLevantaLaMano'}`);
  } else {
    const { recurrenciaLevantaLaMano: R, RECURRENCIA: CFG } = mod;
    A(CFG.dias === 7 && CFG.minFallas === 2 && CFG.pctFlojo === 5,
      `umbral vigente: ${CFG.minFallas}+ fallas y >= ${CFG.pctFlojo}% en ${CFG.dias} días`);

    console.log('\n2) prueba NEGATIVA — semanas SANAS no pueden marcar');
    A(!R({ runs: 619, fails: 0, pasos: [] }).marca, 'cero fallas en 619 corridas → no marca');
    // 3.7% = store_poller real. Por debajo del 5% no debe encender: si encendiera, el tablero
    // gritaría por 30 carriles y volveríamos a enseñar a ignorarlo.
    A(!R({ runs: 21278, fails: 794, pasos: [] }).marca, 'store_poller real (794/21,278 = 3.7%) → no marca');
    A(!R({ runs: 239, fails: 11, pasos: [] }).marca, 'auto_deploy real (11/239 = 4.6%) → no marca, queda debajo del 5%');
    // El piso de 2 fallas: un carril diario con UN tropiezo da 14% y NO debe encender.
    A(!R({ runs: 7, fails: 1, pasos: [] }).marca, 'un solo tropiezo en 7 corridas (14%) → no marca (piso de 2 fallas)');

    console.log('\n3) y semanas ENFERMAS tienen que marcar — con los números reales de prod');
    A(R({ runs: 619, fails: 109, pasos: [] }).propio, 'cdc_reconcile real (109/619 = 17.6%) → marca');
    A(R({ runs: 6, fails: 3, pasos: [] }).propio, 'backup_prod real (3/6 = 50%) → marca');
    A(R({ runs: 3, fails: 2, pasos: [] }).propio, 'stock_snapshot real (2/3 = 66.7%) → marca');
    // ⭐ El caso que estaba INVISIBLE: el padre sale perfecto y un paso suyo falla todas las noches.
    A(R({ runs: 6, fails: 0, pasos: ['import-cash-cuts.js 6/6'] }).marca,
      'feed_nightly con 0 fallas propias pero un PASO fallando 6/6 → marca igual');
    A(!R({ runs: 6, fails: 0, pasos: [] }).marca,
      '…y el mismo carril SIN pasos fallados no marca — o sea que lo que enciende es el paso, no el ruido');

    console.log('\n4) el umbral es un parámetro, no un número escondido');
    const flojo = { runs: 100, fails: 4, pasos: [] };
    A(!R(flojo).marca && R(flojo, { minFallas: 2, pctFlojo: 3 }).marca,
      '4/100 no marca al 5% y SÍ marca al 3% — la regla depende del umbral declarado');
  }

  // ── 5) Contra la DB real ───────────────────────────────────────────────────────────────────
  const cs = process.env.EXISTENCIA_TEST_DB_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) {
    console.log('\n5) contra la DB real');
    ND('sin DATABASE_URL_NEW/DATABASE_URL');
    console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
    process.exit(fail ? 1 : 0);
  }
  const c = new Client({
    connectionString: cs,
    ssl: /localhost|127\.0\.0\.1|pg-prod|192\.168\./.test(cs) ? false : { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await c.connect();

  console.log('\n5) la ventana de 7 días existe y tiene la forma que el servicio espera');
  const reg = (await c.query(`SELECT to_regclass('analytics.cron_run_log') AS t`)).rows[0].t;
  if (!reg) {
    ND('analytics.cron_run_log no existe en esta base: sin historial no hay recurrencia que medir');
  } else {
    const { rows } = await c.query(
      `SELECT job_key, count(*)::int AS runs, count(*) FILTER (WHERE status='error')::int AS fails
         FROM analytics.cron_run_log
        WHERE finished_at > now() - make_interval(days => 7)
        GROUP BY job_key`);
    A(rows.length > 0, `${rows.length} carriles con historial en la ventana`);
    A(rows.every((r) => Number.isInteger(r.runs) && Number.isInteger(r.fails) && r.fails <= r.runs),
      'runs/fails son enteros y fails nunca supera runs');

    console.log('\n6) ⭐ carriles VERDES ahora mismo que la semana desmiente');
    const verdes = (await c.query(`
      WITH h AS (
        SELECT split_part(job_key,'/',1) AS padre, job_key,
               count(*)::int AS runs, count(*) FILTER (WHERE status='error')::int AS fails
          FROM analytics.cron_run_log
         WHERE finished_at > now() - make_interval(days => 7)
         GROUP BY 1,2)
      SELECT r.job_key, h.runs, h.fails,
             round(100.0*h.fails/NULLIF(h.runs,0),1) AS pct, h.job_key AS origen
        FROM analytics.cron_runs r
        JOIN h ON h.padre = r.job_key
       WHERE r.status = 'ok' AND h.fails >= 2 AND (100.0*h.fails/NULLIF(h.runs,0)) >= 5
       ORDER BY pct DESC`)).rows;
    if (!verdes.length) {
      // Sin ni un carril enfermo esto no comprobó nada, y un ✔ acá sería exactamente la
      // "ausencia leyéndose como salud" que esta pantalla existe para matar.
      ND('ningún carril verde con semana mala en esta base: no hay con qué comprobar el contraste');
    } else {
      A(true, `${verdes.length} carriles salían VERDES y su semana dice otra cosa:`);
      for (const v of verdes.slice(0, 8)) {
        const suf = v.origen === v.job_key ? '' : `  (por su paso ${v.origen.split('/')[1]})`;
        console.log(`       · ${v.job_key.padEnd(34)} ${v.fails}/${v.runs} = ${v.pct}%${suf}`);
      }
    }
  }

  await c.end();
  console.log(`\n=== ${ok} ✔ · ${fail} ✖ · ${nm} NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
