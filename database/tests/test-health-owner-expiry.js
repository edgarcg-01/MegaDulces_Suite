/* eslint-disable no-console */
/**
 * [OBS.4.4] CANDADO de la guarda de DUEÑO del healthcheck de entrega (`ops/ingest/health.js`).
 *
 * ── LAS DOS FALLAS QUE TIENE QUE SEPARAR ────────────────────────────────────────────────────
 * `analytics.cron_runs` tiene PK `(tenant_id, job_key)`: **una fila por carril, sin host**. Dos
 * procesos con la misma clave se pisan el renglón, así que el healthcheck puede terminar
 * tomándole el pulso al otro. De ahí la guarda de dueño. Pero hay dos situaciones que se ven
 * idénticas si sólo se mira `host <> yo`, y exigen veredictos OPUESTOS:
 *
 *   1. COMPETIDOR VIVO (incidente 04-09-2026): el contenedor llevaba **15 h colgado** y salía
 *      `healthy` porque una tarea de Windows escribía ese mismo renglón desde la máquina de al
 *      lado. El host ajeno mantenía el latido **fresco** — esa era la trampa. Veredicto: ENFERMO.
 *
 *   2. CADÁVER (incidente 2026-09-30): tras un redespliegue el renglón conserva el hostname del
 *      contenedor ANTERIOR, que ya no existe. El nuevo se declaraba enfermo por un proceso
 *      muerto; `ods-autoheal` reinició `ods-reconcile-full` **109 veces en 30 h** y de paso mató
 *      el trabajo nocturno a mitad, cada noche. Veredicto: NO es problema de dueño.
 *
 * Lo que los distingue es la EDAD del latido ajeno: un competidor vivo lo mantiene fresco, un
 * cadáver no. Por eso la propiedad caduca.
 *
 * ⚠️ Este archivo ejerce la función REAL importada de `ops/ingest/health.js`, no una copia. Una
 * copia se desincroniza y el candado certifica la copia, no el código que corre.
 *
 *   node database/tests/test-health-owner-expiry.js
 */
const path = require('path');

let ok = 0, fail = 0;
const pass = (m) => { ok++; console.log('  ✔', m); };
const bad = (m) => { fail++; console.log('  x FALLA:', m); };

const { otroEntregando } = require(path.join(__dirname, '..', '..', 'ops', 'ingest', 'health.js'));

const YO = 'contenedor-nuevo';
const MAX = 20; // minutos

const casos = [
  // [nombre, fila, esperado, por qué]
  ['COMPETIDOR VIVO — el incidente del 04-09-2026',
    { host: 'maquina-windows', min_age: 3 }, true,
    'otro proceso mantiene el latido fresco: este contenedor NO está entregando aunque el carril lata'],
  ['CADÁVER — el incidente del 2026-09-30',
    { host: 'contenedor-viejo', min_age: 2000 }, false,
    'el host ajeno lleva 2000 min sin latir: no entrega nadie, no es un problema de dueño'],
  ['borde exacto: el ajeno late justo en el tope',
    { host: 'otro', min_age: MAX }, true,
    'el tope es inclusivo — todavía está entregando'],
  ['borde exacto + 1: el ajeno acaba de vencer',
    { host: 'otro', min_age: MAX + 1 }, false,
    'un minuto pasado el tope ya no entrega'],
  ['soy yo, al día',
    { host: YO, min_age: 1 }, false, 'mi propio latido nunca es un competidor'],
  ['soy yo, vencido',
    { host: YO, min_age: 5000 }, false,
    'vencido es problema de ANTIGÜEDAD, no de dueño: lo juzga el otro control'],
  ['fila sin host (latido viejo, antes de que existiera la columna)',
    { host: null, min_age: 5 }, false, 'sin host no se puede afirmar que sea de otro'],
];

console.log('\n[1] La guarda distingue un competidor vivo de un cadáver');
let malos = 0;
for (const [nombre, fila, esperado, porque] of casos) {
  const got = otroEntregando(fila, YO, MAX);
  if (got === esperado) {
    console.log(`     · ${nombre} → ${got ? 'BLOQUEA' : 'no bloquea'} ✔  (${porque})`);
  } else {
    malos++;
    console.log(`     · ${nombre} → ${got ? 'BLOQUEA' : 'no bloquea'} pero se esperaba lo contrario ✘  (${porque})`);
  }
}
if (malos) bad(`${malos} de ${casos.length} veredictos no coinciden.`);
else pass(`los ${casos.length} veredictos coinciden, incluidos los dos bordes del tope.`);

// ── 2. PRUEBA NEGATIVA: la guarda no puede volverse permisiva ────────────────────────────────
console.log('\n[2] Prueba negativa: la guarda sigue teniendo dientes');
// Si alguien "simplifica" la función a `return false`, el bloque 1 pasaría 6 de 7 casos —
// justo los que NO bloquean. Este bloque exige que exista AL MENOS un caso que bloquee, y que
// sea exactamente el del incidente: un detector que nunca bloquea se ve casi igual de verde.
const bloquean = casos.filter(([, f]) => otroEntregando(f, YO, MAX));
if (!bloquean.length) {
  bad('la guarda NO bloquea en NINGÚN caso: es utilería, y el incidente del 04-09-2026 volvería a pasar inadvertido.');
} else if (bloquean.some(([n]) => n.includes('COMPETIDOR VIVO'))) {
  pass(`bloquea en ${bloquean.length} de ${casos.length} casos, e incluye el del competidor vivo.`);
} else {
  bad('bloquea, pero NO en el caso del competidor vivo — que es el único para el que existe.');
}

// ── 3. PRUEBA NEGATIVA: tampoco puede volverse absoluta ─────────────────────────────────────
console.log('\n[3] Prueba negativa: la guarda tampoco bloquea todo');
// El defecto que se corrige es el contrario: bloquear SIEMPRE que el host difiera. Si alguien
// le quita la caducidad, este bloque lo atrapa.
if (otroEntregando({ host: 'contenedor-viejo', min_age: 2000 }, YO, MAX)) {
  bad('un host ajeno VENCIDO sigue bloqueando: la propiedad no caduca y el bucle de reinicios vuelve.');
} else {
  pass('un host ajeno vencido NO bloquea: el cadáver de un redespliegue ya no se lee como competidor.');
}

console.log(`\n=== ${ok} OK · ${fail} FALLAS · 0 NO MEDIDOS ===`);
process.exitCode = fail ? 1 : 0;
