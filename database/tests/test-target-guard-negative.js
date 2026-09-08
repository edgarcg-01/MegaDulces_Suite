/* eslint-disable no-console */
/**
 * `[REP.0.2]` — Prueba NEGATIVA de la guarda de destino/origen.
 *
 * ADR-056: *un gate sin prueba negativa es una intención*. Esta suite rompe la
 * guarda a propósito y verifica el rojo.
 *
 * ── Por qué cada caso corre en un SUBPROCESO ─────────────────────────────────
 * La guarda llama `process.exit(2)`. Probarla en el mismo proceso mata al test
 * — y ésa es justamente la razón por la que las pruebas de guardas suelen estar
 * verdes sin haber ejecutado nunca la guarda: se prueba `classify()` (que no
 * mata a nadie) y se da por probado `assertSafeTarget()` (que sí). Acá se
 * ejercita la función que aborta, y se mide su código de salida.
 *
 * ── Y por qué además se mira el MENSAJE ──────────────────────────────────────
 * El código de salida no alcanza para distinguir "es prod" de "no lo reconozco":
 * los dos son `exit 2`. Una guarda a la que le vaciaron los patrones de prod
 * seguiría abortando —por otra razón— y una suite que sólo mira el código se
 * quedaría verde. Por eso cada caso declara también el fragmento que espera leer.
 *
 * ── La prueba de MUTACIÓN, que es lo que la vuelve negativa de verdad ────────
 * Al final, la suite se corre a sí misma contra copias DESARMADAS del
 * clasificador y exige que se pongan ROJAS. Si con la guarda desarmada la suite
 * sigue verde, la suite es decorativa y hay que tirarla.
 *
 * El corpus mutado vive en el directorio temporal y se pasa por `--corpus`.
 * NUNCA como archivo sonda dentro de `libs/`: ya pasó que una sonda ahí se coló
 * en un commit ajeno, en las dos direcciones, en una sola sesión.
 *
 * Uso:
 *   node database/tests/test-target-guard-negative.js
 *   node database/tests/test-target-guard-negative.js --corpus <ruta-al-.js>
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const GUARD_REAL = path.resolve(__dirname, '../../libs/platform-core/src/lib/provenance/target-guard.js');

const argCorpus = (process.argv.find((a) => a.startsWith('--corpus=')) || '').split('=')[1];
const GUARD = argCorpus ? path.resolve(argCorpus) : GUARD_REAL;
const ES_MUTANTE = Boolean(argCorpus);

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); }
}

/**
 * Corre UNA llamada a la guarda en un proceso aparte.
 * `env` reemplaza el entorno entero: la guarda lee `FLEET_DB_URL` y
 * `TEST_TARGET_ALLOW` de ahí, y no queremos que se filtre el `.env` del repo.
 */
function correr({ llamada, env = {} }) {
  const script = `
    const g = require(${JSON.stringify(GUARD)});
    ${llamada}
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
  return { code: r.status, salida: `${r.stdout || ''}${r.stderr || ''}` };
}

const U = {
  prodHost:      'postgresql://u:p@trolley.proxy.rlwy.net:39023/railway',
  prodSoloHost:  'postgresql://u:p@algo.proxy.rlwy.net:39023/postgres',
  prodSoloNombre:'postgresql://u:p@nada.example.com:5432/railway',
  fleetRaro:     'postgresql://u:p@10.1.1.1:5432/una_base',
  local:         'postgresql://u:p@localhost:5433/postgres_platform',
  compartida:    'postgresql://u:p@192.168.0.245:5432/platform_test',
  desconocido:   'postgresql://u:p@10.9.9.9:5432/x',
  localOtroNombre:'postgresql://otro:distinta@localhost:5433/postgres_platform',
};

const CASOS = [
  // ── assertSafeTarget: la pregunta de siempre, "¿puedo ESCRIBIR acá?" ──
  { n: 'escribir en prod (host rlwy + base railway) aborta',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.prodHost)} });`,
    code: 2, dice: 'PRODUCCIÓN' },

  { n: 'escribir en prod detectado SOLO por el host aborta',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.prodSoloHost)} });`,
    code: 2, dice: 'PRODUCCIÓN' },

  { n: 'escribir en prod detectado SOLO por el nombre de base aborta',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.prodSoloNombre)} });`,
    code: 2, dice: 'PRODUCCIÓN' },

  { n: 'un destino que ES FLEET_DB_URL aborta aunque el host no lo delate',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.fleetRaro)} });`,
    env: { FLEET_DB_URL: U.fleetRaro },
    code: 2, dice: 'PRODUCCIÓN' },

  { n: 'destino desconocido aborta (fail-closed)',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.desconocido)} });`,
    code: 2, dice: 'no reconozco' },

  { n: 'destino vacío aborta (var sin setear = desconocido)',
    llamada: `g.assertSafeTarget('caso', { url: undefined });`,
    code: 2, dice: 'no reconozco' },

  { n: 'destino local pasa',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.local)} });`,
    code: 0 },

  { n: 'destino compartido pasa pero AVISA',
    llamada: `g.assertSafeTarget('caso', { url: ${JSON.stringify(U.compartida)} });`,
    code: 0, dice: 'COMPARTIDA' },

  // ── assertTarget: la pregunta que faltaba, "¿es este el ORIGEN esperado?" ──
  { n: 'origen local cuando se esperaba prod aborta (el pull silencioso)',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.local)}, intent: 'read', expect: 'prod' });`,
    code: 2, dice: 'ORIGEN' },

  { n: 'origen prod cuando se esperaba prod pasa',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.prodHost)}, intent: 'read', expect: 'prod' });`,
    code: 0 },

  { n: 'escribir en prod vía assertTarget aborta',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.prodHost)}, intent: 'write', expect: 'local' });`,
    code: 2, dice: 'PRODUCCIÓN' },

  { n: 'la COMPARTIDA no cuenta como local cuando se pidió local',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.compartida)}, intent: 'write', expect: 'local' });`,
    code: 2, dice: 'recibido: compartida' },

  { n: 'TEST_TARGET_ALLOW NO abre la puerta en una ESCRITURA',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.desconocido)}, intent: 'write', expect: 'local' });`,
    env: { TEST_TARGET_ALLOW: '10.9.9.9' },
    code: 2, dice: 'no aplica a una operación de ESCRITURA' },

  { n: 'TEST_TARGET_ALLOW sí vale para LEER (no es un bypass, es un alcance)',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.desconocido)}, intent: 'read', expect: 'local' });`,
    env: { TEST_TARGET_ALLOW: '10.9.9.9' },
    code: 0 },

  { n: 'TEST_TARGET_ALLOW tampoco abre la puerta a prod (ya abortó antes)',
    llamada: `g.assertTarget('caso', { url: ${JSON.stringify(U.prodHost)}, intent: 'read', expect: 'local' });`,
    env: { TEST_TARGET_ALLOW: 'trolley.proxy.rlwy.net' },
    code: 2 },

  // ── assertDistinct: copiar una base sobre sí misma no falla, no copia ──
  { n: 'misma base con distinta credencial se detecta como la MISMA',
    llamada: `g.assertDistinct('caso', ${JSON.stringify(U.local)}, ${JSON.stringify(U.localOtroNombre)});`,
    code: 2, dice: 'MISMA base' },

  { n: 'bases distintas pasan',
    llamada: `g.assertDistinct('caso', ${JSON.stringify(U.local)}, ${JSON.stringify(U.compartida)});`,
    code: 0 },
];

/** Escribe una copia DESARMADA del clasificador y devuelve su ruta. */
function mutar(nombre, transformar) {
  const src = fs.readFileSync(GUARD_REAL, 'utf8');
  const out = transformar(src);
  if (out === src) throw new Error(`la mutación '${nombre}' no cambió nada — el patrón ya no existe en el archivo`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-mut-'));
  const f = path.join(dir, 'target-guard.js');
  fs.writeFileSync(f, out);
  return f;
}

const MUTACIONES = [
  {
    nombre: 'PROD_PATTERNS vacío',
    // La mutación que un humano haría sin querer: tocar la lista de patrones.
    transformar: (s) => s.replace(
      /const PROD_PATTERNS = \[[^\]]*\];/,
      'const PROD_PATTERNS = [];',
    ),
  },
  {
    nombre: 'classify() siempre devuelve local',
    // La mutación bruta: la guarda deja de clasificar. Si esto no pone la suite
    // en rojo, no hay nada que la suite esté comprobando.
    transformar: (s) => s.replace(
      /function classify\(url\) \{/,
      'function classify(url) {\n  return { kind: \'local\', host: \'x\', db: \'y\' };',
    ),
  },
];

(async () => {
  console.log(ES_MUTANTE ? `\n[corpus MUTADO: ${GUARD}]` : '\nGuarda de destino/origen — prueba negativa');
  console.log('');

  for (const c of CASOS) {
    const r = correr(c);
    const codeOk = r.code === c.code;
    const diceOk = !c.dice || r.salida.includes(c.dice);
    if (codeOk && diceOk) {
      ok(true, c.n);
    } else {
      const detalle = !codeOk
        ? `exit ${r.code}, esperaba ${c.code}`
        : `no dijo "${c.dice}"`;
      ok(false, `${c.n}  [${detalle}]`);
    }
  }

  // ── La prueba de mutación. Sólo en la corrida normal: si ya somos el mutante,
  //    no nos volvemos a mutar (recursión infinita).
  if (!ES_MUTANTE) {
    console.log('\n  Prueba de mutación — la suite tiene que ponerse ROJA con la guarda desarmada:');
    for (const m of MUTACIONES) {
      let ruta;
      try {
        ruta = mutar(m.nombre, m.transformar);
      } catch (e) {
        ok(false, `mutación "${m.nombre}": ${e.message}`);
        continue;
      }
      const r = spawnSync(process.execPath, [__filename, `--corpus=${ruta}`], { encoding: 'utf8' });
      ok(r.status !== 0, `con "${m.nombre}" la suite se pone en rojo (exit ${r.status})`);
      try { fs.rmSync(path.dirname(ruta), { recursive: true, force: true }); } catch { /* limpieza best-effort */ }
    }
  }

  console.log(`\nREP.0.2 guarda de destino/origen: ${pass} OK, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})();
