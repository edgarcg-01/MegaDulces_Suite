'use strict';
/**
 * ⭐⭐ `[CGA-A.3]` — **Un importer que late y que nadie agendó.**
 * Esta compuerta exige que todo carril con latido tenga **quién lo dispare**.
 *
 * ── El incidente que la funda, medido el 2026-10-16 ────────────────────────────────────────
 *
 * `import-route-collections.js` (`[RC.4]`) es el último tramo de la cadena del cobro de
 * camioneta: sin él, el dinero que la unidad levantó **no llega a la cola de Caja General**.
 * Estaba escrito, commiteado, con su latido en `analytics.cron_runs`… y **no estaba en ningún
 * crontab**. El día que se cablearon cuatro camionetas hubo que invocarlo **tres veces a mano**
 * para que el dinero apareciera en pantalla.
 *
 * ⛔ **Y no daba ninguna señal.** Un carril que nunca corrió no escribe un latido en rojo:
 * **no escribe nada**, y una tabla de latidos sin la fila es indistinguible de un carril que
 * todavía no existe. Es la misma familia que `GOTCHAS` §84 (verde con `rows_affected = 0`) y
 * §86: **el modo de fallar es el silencio.**
 *
 * ⭐ Por eso la pregunta no es «¿corrió?» sino **«¿hay algo que lo corra?»** — y ésa sí se
 * puede contestar sin red, leyendo el repo.
 *
 * ── Qué cuenta como «tener quién lo dispare» ───────────────────────────────────────────────
 *
 *  1. Nombrado en un `crontab` versionado (`ops/vl/crontab.*`).
 *  2. Nombrado en cualquier cosa de `ops/` (un manifiesto de k3s, un script de despliegue).
 *     `import-caos-movements.js` entra por acá: lo corre el deployment `caos-live`.
 *  3. Invocado por un **padre que sí está agendado** (un salto). Así entran los ~50 pasos que
 *     dispara `run-prod-feeds.js`.
 *  4. Declarado abajo, con motivo. Lo que corre fuera de este repo (Tareas de Windows en `.249`)
 *     o lo que no es un carril (la librería del latido, un diagnóstico).
 *
 * ⚠️ **Lo que esta compuerta NO puede ver, y se declara:** mira el REPO, no lo desplegado. El
 * `crontab` va **horneado en la imagen** (`ops/ingest/Dockerfile` lo copia y
 * `26-feeds-cron.deployment.yaml` lo instala al arrancar), así que agregar la línea acá **no
 * agenda nada hasta que se reconstruya y se despliegue `ingesta`**. Que la línea exista y que
 * el carril corra son dos hechos distintos; el segundo lo dice `analytics.cron_runs`.
 *
 * uso:  node scripts/check-importer-sin-agenda.js [--probar-negativo]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DONDE_SE_BUSCA = ['database/importers', 'database/scripts'];
const AGENDA_DIRS = ['ops'];
const EXT = new Set(['.js', '.mjs', '.cjs', '.ps1', '.cmd', '.sh']);
const IGNORAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp']);

/**
 * Lo que NO necesita agenda, con el porqué. **No es una lista de perdón: es una lista de
 * dueños.** Si algo entra acá sin decir quién lo corre, la compuerta deja de servir.
 */
const SIN_AGENDA_A_PROPOSITO = [
  { archivo: '_diag-catbulk.js', motivo: 'diagnóstico de un solo uso; se corre a mano y a propósito' },
  { archivo: 'access-replicate.js', motivo: 'Fase CA: lo dispara una Tarea de Windows en `.249` (Jet 32-bit), fuera de este repo' },
  { archivo: 'run-wincaja-live.ps1', motivo: 'carril Wincaja en `.249`: Tarea de Windows, fuera de este repo (Fase VL.5)' },
  { archivo: 'run-wincaja-replica.ps1', motivo: 'ídem Wincaja en `.249`' },
  { archivo: 'sync-wincaja-actual.ps1', motivo: 'ídem Wincaja en `.249`' },
  { archivo: 'sync-wincaja-concentrada.ps1', motivo: 'ídem Wincaja en `.249`' },
  { archivo: 'install-concentrate-task.ps1', motivo: 'RETIRADO por [NORM.3]: instalaba una tarea de Windows, el sustrato que ADR-060 sacó' },
  { archivo: 'pull-prod-to-local.js', motivo: 'herramienta de desarrollo (espejo prod→local), no es un carril de producción' },
  { archivo: 'prevuelo-corte-asistencia.js', motivo: '[RH.1.8] PRE-VUELO de sólo lectura: se corre antes del corte, a mano y a propósito' },
  { archivo: 'ecosystem.sync.config.js', motivo: 'config de PM2 (era el orquestador anterior a k3s); no se dispara, se lee' },
  { archivo: 'ecosystem.caja-general.config.js', motivo: 'ídem PM2' },
  { archivo: 'ecosystem.wincaja.config.js', motivo: 'ídem PM2' },
  { archivo: 'ods-cdc-forward.js', motivo: 'drenaje del CDC: lo invoca el carril de replicación, no el cron (ver `replicate-ods-live.js`)' },
];

/**
 * ⛔⛔ **DEUDA MEDIDA, no exenta.** Esto NO es «no necesita agenda»: es «debería tener y no
 * tiene», con el daño medido. La compuerta **lo cuenta y lo imprime en cada corrida**, pero no
 * se pone roja por ello — un rojo por deuda ajena se apaga el primer día. **Sí se pone roja por
 * la siguiente**, que es todo el punto.
 */
const DEUDA_SIN_AGENDA = [
  {
    archivo: 'import-route-stock.js',
    duele: '[RD.32] la foto de existencia del camión NO LLEGA A PROD. Medido el 2026-10-16: ' +
      'el runner tiene 30,146 renglones de 10 camionetas, frescos de HOY; ' +
      '`commercial.route_counts` con `source=kepler` tiene UNA fila, del 2026-10-06 — ' +
      'el día que alguien lo corrió a mano. Diez días sin ancla de saldo de ruta.',
    decide: 'Edgar: agendarlo cambia el ancla del saldo de 10 camionetas, y eso es alcance de negocio',
  },
];

function archivos(dir, acc) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (EXT.has(path.extname(e.name))) acc.push(p);
  }
  return acc;
}

const leer = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

/** Los que LATEN: usan el helper de `cron_runs`. Son los que prometen ser un carril. */
function conLatido() {
  const out = [];
  for (const d of DONDE_SE_BUSCA) {
    for (const f of archivos(path.join(RAIZ, d), [])) {
      const s = leer(f);
      if (/cron-heartbeat|cron_runs/.test(s)) out.push({ rel: path.relative(RAIZ, f), base: path.basename(f), texto: s });
    }
  }
  return out;
}

/**
 * Todo lo de `ops/`, concatenado: crontabs, manifiestos de k3s, scripts de despliegue.
 *
 * ⚠️ **SIN filtro de extensión, y no es un descuido.** La primera versión reusaba el recorrido
 * de arriba, que sólo mira `.js/.ps1/.cmd/.sh` — y el archivo que más importa es
 * `ops/vl/crontab.feeds`, **que no tiene ninguna de esas**. Resultado: la compuerta declaraba
 * huérfanos a 16 carriles que sí estaban agendados, incluido el que la funda. Una compuerta con
 * 16 falsos en 22 hallazgos se apaga el primer día.
 */
function textoDeLaAgenda() {
  const todos = (dir, acc) => {
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entradas) {
      if (IGNORAR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) todos(p, acc);
      else acc.push(p);
    }
    return acc;
  };
  let s = '';
  for (const d of AGENDA_DIRS) for (const f of todos(path.join(RAIZ, d), [])) s += '\n' + leer(f);
  return s;
}

function resolver() {
  const latidos = conLatido();
  const agenda = textoDeLaAgenda();
  const directos = new Set(latidos.filter((x) => agenda.includes(x.base)).map((x) => x.base));

  // Un salto: ¿lo invoca un archivo que SÍ está agendado?
  const porPadre = new Map();
  for (const x of latidos) {
    if (directos.has(x.base)) continue;
    const padre = latidos.find((p) => directos.has(p.base) && p.texto.includes(x.base));
    if (padre) porPadre.set(x.base, padre.base);
  }

  const exentos = new Set(SIN_AGENDA_A_PROPOSITO.map((e) => e.archivo));
  const deuda = new Set(DEUDA_SIN_AGENDA.map((e) => e.archivo));
  const huerfanos = latidos.filter((x) => !directos.has(x.base) && !porPadre.has(x.base)
    && !exentos.has(x.base) && !deuda.has(x.base));
  const exentosDeMas = [...SIN_AGENDA_A_PROPOSITO, ...DEUDA_SIN_AGENDA]
    .filter((e) => directos.has(e.archivo) || porPadre.has(e.archivo));

  return { latidos, directos, porPadre, huerfanos, exentosDeMas };
}

// ── Prueba negativa ─────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--probar-negativo')) {
  const { latidos, directos, porPadre } = resolver();
  const fallos = [];

  // ⭐ El caso REAL que la funda: `import-route-collections.js`. Si se le quita la línea del
  // crontab, tiene que quedar huérfano. Se simula sin tocar el archivo.
  const agendaSinCobros = textoDeLaAgenda().split('\n')
    .filter((l) => !l.includes('import-route-collections.js')).join('\n');
  const sigueAgendado = agendaSinCobros.includes('import-route-collections.js');
  if (sigueAgendado) fallos.push('quitar su línea del crontab no lo deja huérfano: la detección no mira ahí');

  // Un nombre que no existe no puede aparecer agendado.
  if (directos.has('import-esto-no-existe.js')) fallos.push('detecta como agendado algo inexistente');

  // El salto por padre tiene que estar ejerciéndose de verdad, no ser código muerto.
  if (porPadre.size === 0) {
    console.log('  · Hoy ningún carril entra por padre agendado: ese camino NO se ejerció.');
    console.log('    Se DECLARA (ADR-056) en vez de darlo por bueno.');
  }

  console.log('\n[prueba negativa]');
  console.log(`  ${latidos.length} archivos con latido · ${directos.size} agendados directo · ${porPadre.size} por padre`);
  console.log(`  quitar la línea de import-route-collections.js lo deja huérfano: ${sigueAgendado ? 'NO ✗' : 'SÍ ✓'}`);
  console.log('');
  if (fallos.length) { for (const f of fallos) console.log(`  ✗ ${f}`); console.log(''); process.exit(1); }
  console.log('✓ prueba negativa: la detección depende de la línea del crontab, y el salto por padre se ejerce.\n');
  process.exit(0);
}

const { latidos, directos, porPadre, huerfanos, exentosDeMas } = resolver();

console.log('');
console.log(`[CGA-A.3] ${latidos.length} archivos laten en cron_runs:`);
console.log(`          ${directos.size} agendados directo · ${porPadre.size} por padre agendado · ` +
  `${SIN_AGENDA_A_PROPOSITO.length} declarados sin agenda`);

for (const e of exentosDeMas) {
  console.log(`\n·  ${e.archivo} ya tiene quién lo dispare: quitá su entrada de la lista.`);
}

for (const d of DEUDA_SIN_AGENDA) {
  console.log(`\n⚠️  DEUDA — ${d.archivo} (no frena, pero está medido)`);
  console.log(`    ${d.duele}`);
  console.log(`    decide: ${d.decide}`);
}

if (!huerfanos.length) {
  console.log('\n✓ Ningún carril con latido quedó sin quién lo dispare.');
  console.log('  ⚠️ Esto mira el REPO. El crontab va horneado en la imagen: la línea no agenda');
  console.log('     nada hasta que se reconstruya y despliegue `ingesta`.\n');
  process.exit(0);
}

console.log(`\n⛔ ${huerfanos.length} carril(es) con latido y SIN quién los dispare:\n`);
for (const h of huerfanos) console.log(`     ${h.rel}`);
console.log('\n   Un carril que nunca corre no escribe un latido en rojo: NO ESCRIBE NADA, y eso');
console.log('   es indistinguible de un carril que todavía no existe. Agendalo en');
console.log('   `ops/vl/crontab.feeds`, o declaralo en SIN_AGENDA_A_PROPOSITO diciendo QUIÉN lo corre.\n');
process.exit(1);
