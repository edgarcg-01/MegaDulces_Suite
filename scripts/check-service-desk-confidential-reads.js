'use strict';
/**
 * `[MSH.2]` H2 — **quién PUEDE leer `servicedesk.requests`, y que la lista no crezca en silencio.**
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * La confidencialidad de la cola de RH vive en TRES capas (la fila lleva `confidential` por trigger, el servicio decide el acceso con
 * `accesoATicket`, y la entrega filtra destinatarios). Las tres se rompen igual: **alguien escribe una consulta nueva a
 * `servicedesk.requests` que no sabe que existe lo confidencial** — un contador para un tablero, un reporte, un aviso, un espejo hacia otro
 * módulo — y devuelve la fila (o su conteo) sin pasar por el servicio. Ningún test lo atrapa: el test del autor prueba lo que el autor creyó.
 *
 * Esta compuerta convierte «¿quién lee la tabla?» en una lista CERRADA. Un archivo que NO está acá y menciona `servicedesk.requests` rompe el
 * build, y quien lo agrega tiene que escribir **por qué es seguro** (la razón queda en el repo, no en una conversación).
 *
 * ── Qué cubre y qué NO ───────────────────────────────────────────────────────────────────────
 *
 * Cubre apps/ y libs/ (código de producto, sin specs). NO cubre `database/` (migraciones, smokes, scripts): ahí se lee a propósito y como
 * dueño de la base. NO prueba que cada archivo permitido filtre bien — eso lo hacen el E2E y los specs del dominio; esto sólo garantiza que
 * ningún lector NUEVO aparezca sin que alguien lo mire. Un archivo permitido que deja de mencionar la tabla se marca como entrada vieja.
 *
 * uso:  node scripts/check-service-desk-confidential-reads.js [--self-test]
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs'];
const IGNORAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp']);
const TABLA = /servicedesk\.requests\b/;

/**
 * archivo → por qué puede leer la tabla sin exponer lo confidencial. `marca` (opcional) = texto que el archivo DEBE seguir conteniendo: si
 * alguien borra la defensa, la compuerta lo avisa.
 */
const PERMITIDOS = {
  'libs/service-desk/src/lib/requests.service.ts': { razon: 'EL servicio: accesoATicket (completo/básico/ninguno), lista y detalle limitados, anti-oráculo, tablero sin confidenciales para el god-mode', marca: 'confidential' },
  'libs/service-desk/src/lib/reports.service.ts': { razon: 'reportes: lo confidencial sale de los globales y su reporte pasa por el mínimo de casos y sólo para su coordinación', marca: 'confidential' },
  'libs/service-desk/src/lib/agents.service.ts': { razon: 'carga de trabajo de quien atiende: el conteo de abiertos excluye lo confidencial', marca: 'confidential' },
  'libs/service-desk/src/lib/notifications.service.ts': { razon: 'avisos: el contenido de un ticket confidencial sale neutro y los destinatarios se filtran', marca: 'confidential' },
  'libs/service-desk/src/lib/queue-members.service.ts': { razon: 'conteo de tickets abiertos de un miembro al quitarlo de la cola; lo administra sólo quien coordina (puedeAdministrarCola)', marca: 'confidential' },
  'libs/service-desk/src/lib/sla.service.ts': { razon: 'barrido de SLA: opera por cola con SLA activo; una cola sin SLA (RH) no se barre y el aviso va a quien atiende esa cola' },
  'libs/service-desk/src/lib/domain/request-state.ts': { razon: 'sólo la MENCIONA en un comentario (no lee la tabla)' },
  'libs/contracts/src/work/task.contract.ts': { razon: 'declara el nombre de la fuente de tareas (una cadena), no lee la tabla' },
  'libs/trade/src/lib/users/me-tasks.ts': { razon: 'tareas del usuario: sólo las que TIENE ASIGNADAS (assigned_to = él); no hay lectura por área' },
  'libs/trade/src/lib/users/me-work.ts': { razon: 'contadores de «Mi trabajo»: acotado a las colas de las que la persona es MIEMBRO (MS.7.18); quien es de la cola confidencial es quien debe verla' },
};

function archivos(dir, acc) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivos(p, acc);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.(spec|test)\.[tj]s$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Función pura (la que prueba el self-test): dado {ruta → texto} devuelve los hallazgos. */
function evaluar(contenidos, permitidos) {
  const hallazgos = [];
  const vistos = new Set();
  for (const [ruta, texto] of Object.entries(contenidos)) {
    if (!TABLA.test(texto)) continue;
    vistos.add(ruta);
    const regla = permitidos[ruta];
    if (!regla) {
      hallazgos.push(`${ruta}: lee/menciona servicedesk.requests y NO está en la lista de lectores permitidos. Una consulta nueva a esa tabla puede devolver tickets CONFIDENCIALES sin pasar por accesoATicket. Páselo por RequestsService o agréguelo a PERMITIDOS con la razón por la que es seguro.`);
    } else if (regla.marca && !texto.includes(regla.marca)) {
      hallazgos.push(`${ruta}: ya no contiene «${regla.marca}» — se quitó la defensa que justificaba su lugar en la lista (${regla.razon}).`);
    }
  }
  for (const ruta of Object.keys(permitidos)) {
    if (!vistos.has(ruta)) hallazgos.push(`${ruta}: está en PERMITIDOS pero ya no menciona servicedesk.requests (o no existe) — borre la entrada vieja para que la lista diga la verdad.`);
  }
  return hallazgos;
}

function autoprueba() {
  const ok = { 'libs/a.ts': 'knex("servicedesk.requests")  // confidential' };
  const permitidos = { 'libs/a.ts': { razon: 'x', marca: 'confidential' } };
  const casos = [
    ['⭐ control: lector permitido con su marca → limpio', () => evaluar(ok, permitidos).length === 0],
    ['⛔ NEGATIVA: lector NUEVO fuera de la lista → hallazgo', () => evaluar({ ...ok, 'libs/nuevo.ts': 'trx("servicedesk.requests").select("*")' }, permitidos).length === 1],
    ['⛔ NEGATIVA: se borró la marca de defensa → hallazgo', () => evaluar({ 'libs/a.ts': 'knex("servicedesk.requests")' }, permitidos).length === 1],
    ['⛔ NEGATIVA: entrada vieja (ya no lee la tabla) → hallazgo', () => evaluar({ 'libs/a.ts': 'nada' }, permitidos).length === 1],
    ['una mención en un archivo ajeno sin la tabla no es hallazgo', () => evaluar({ ...ok, 'libs/b.ts': 'servicedesk.queues' }, permitidos).length === 0],
  ];
  let mal = 0;
  for (const [nombre, f] of casos) {
    const pasa = f();
    console.log(`${pasa ? '✔' : '✘'} ${nombre}`);
    if (!pasa) mal++;
  }
  process.exit(mal ? 1 : 0);
}

function main() {
  if (process.argv.includes('--self-test')) return autoprueba();
  const contenidos = {};
  for (const d of DIRS) {
    for (const f of archivos(path.join(RAIZ, d), [])) {
      const txt = fs.readFileSync(f, 'utf8');
      if (TABLA.test(txt)) contenidos[path.relative(RAIZ, f).split(path.sep).join('/')] = txt;
    }
  }
  const hallazgos = evaluar(contenidos, PERMITIDOS);
  if (hallazgos.length) {
    console.error(`✘ check-service-desk-confidential-reads: ${hallazgos.length} hallazgo(s)\n`);
    for (const h of hallazgos) console.error(`  · ${h}`);
    process.exit(1);
  }
  console.log(`✔ check-service-desk-confidential-reads: ${Object.keys(contenidos).length} archivos leen servicedesk.requests, todos en la lista cerrada`);
}

main();
