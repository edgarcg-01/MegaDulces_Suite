#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[NX.3]` CANDADO: un archivo de la RAÍZ del que dependa un config de proyecto tiene que estar
 * en el `COPY` de los Dockerfiles que compilan con Nx.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Al migrar a Vitest se creó `vitest.shared.ts` en la raíz, importado por los 7
 * `vitest.config.ts` de `apps/` y `libs/`. En local todo verde. En el contenedor:
 *
 *     ✘ [ERROR] Could not resolve "../../vitest.shared"
 *         libs/contracts/vitest.config.ts:2:46
 *     NX  Failed to process project graph.
 *     7 errors occurred while processing files for the @nx/vitest plugin
 *
 * El `Dockerfile` copia la raíz **archivo por archivo** (a propósito: un `COPY . .` invalida la
 * caché del bundle de Angular por cualquier cambio en un README), y `vitest.shared.ts` no estaba
 * en la lista. Lo que lo vuelve grave es que el plugin `@nx/vitest` **carga esos configs para
 * armar el grafo de proyectos**, o sea en CUALQUIER comando de Nx — `build` incluido. No es que
 * fallaran las pruebas: no arrancaba el deploy.
 *
 * ⚠️ El defecto es INVISIBLE en la máquina de quien lo introduce. Sólo aparece en el contenedor,
 * y ahí aparece como un error de resolución de módulos que no menciona ni Docker ni el COPY.
 *
 * ── Qué vigila, y qué NO ────────────────────────────────────────────────────────────────────
 * Sólo los Dockerfiles que copian `apps/` o `libs/` de forma granular. Los que hacen `COPY . .`
 * (portal, vendor) se llevan todo y no pueden tener este problema.
 *
 * Límite declarado: esto mira los `import`/`require` RELATIVOS de los configs de proyecto que
 * salen a la raíz. No resuelve dependencias transitivas ni imports dinámicos — si mañana
 * `vitest.shared.ts` importa otro archivo de la raíz, este candado no lo ve. Se deja así porque
 * la alternativa (un resolvedor completo) sería un gate que discute con el bundler; lo que
 * importa es atrapar el caso que ya nos costó un deploy.
 *
 *   node scripts/check-docker-context.js
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const rel = (p) => path.relative(RAIZ, p).split(path.sep).join('/');

/** Configs de proyecto que Nx carga para armar el grafo. */
function configsDeProyecto() {
  const out = [];
  for (const base of ['apps', 'libs']) {
    const dir = path.join(RAIZ, base);
    if (!fs.existsSync(dir)) continue;
    for (const proy of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!proy.isDirectory()) continue;
      for (const f of ['vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js']) {
        const p = path.join(dir, proy.name, f);
        if (fs.existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/** Archivos de la RAÍZ que un config importa con ruta relativa. */
function dependenciasEnLaRaiz(archivoConfig) {
  const src = fs.readFileSync(archivoConfig, 'utf8');
  const dir = path.dirname(archivoConfig);
  const encontrados = new Set();
  const re = /(?:from\s+|require\(\s*|import\(\s*)['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const destino = path.resolve(dir, m[1]);
    if (path.dirname(destino) !== RAIZ) continue;   // sólo lo que sale a la raíz
    // El import puede venir sin extensión.
    const cand = [destino, `${destino}.ts`, `${destino}.js`, `${destino}.mjs`, `${destino}.cjs`];
    const real = cand.find((c) => fs.existsSync(c));
    if (real) encontrados.add(path.basename(real));
  }
  return encontrados;
}

/** Dockerfiles del repo, sin node_modules. */
function dockerfiles(dir = RAIZ, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.nx' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dockerfiles(p, acc);
    else if (/^Dockerfile(\..+)?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Las instrucciones COPY que traen archivos del CONTEXTO (no de otra etapa). */
function copiasDelContexto(contenido) {
  const lineas = contenido.split('\n');
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    let l = lineas[i];
    if (!/^\s*COPY\s/i.test(l)) continue;
    while (/\\\s*$/.test(l) && i + 1 < lineas.length) l = l.replace(/\\\s*$/, '') + lineas[++i];
    if (/--from=/.test(l)) continue;                      // viene de otra etapa, no del contexto
    const args = l.replace(/^\s*COPY\s+/i, '').trim().split(/\s+/).filter((a) => !a.startsWith('--'));
    out.push(args.slice(0, -1));                          // el último es el destino
  }
  return out;
}

// ── Medición ────────────────────────────────────────────────────────────────────────────────
const configs = configsDeProyecto();
const necesarios = new Map();                             // archivo raíz -> quién lo pide
for (const c of configs) {
  for (const dep of dependenciasEnLaRaiz(c)) {
    if (!necesarios.has(dep)) necesarios.set(dep, []);
    necesarios.get(dep).push(rel(c));
  }
}

console.log('[NX.3] Contexto de Docker · archivos de la raíz que los configs de proyecto necesitan\n');
console.log(`  configs de proyecto revisados : ${configs.length}`);
console.log(`  archivos de la raíz requeridos: ${necesarios.size}${necesarios.size ? ` (${[...necesarios.keys()].join(', ')})` : ''}`);

if (necesarios.size === 0) {
  console.log('\n  ⊘ NO MEDIDO — ningún config de proyecto importa un archivo de la raíz.');
  console.log('     El candado no puede afirmar nada: no hay nada que vigilar todavía.');
  process.exit(0);
}

const fallas = [];
let revisados = 0;

for (const df of dockerfiles()) {
  const contenido = fs.readFileSync(df, 'utf8');
  const copias = copiasDelContexto(contenido);
  const fuentes = copias.flat();

  // `COPY . .` se lleva todo: no puede tener este defecto.
  if (fuentes.some((s) => s === '.' || s === './')) continue;
  // Sólo aplica a los que compilan con Nx sobre apps/libs.
  const compilaConNx = fuentes.some((s) => /^\.?\/?(apps|libs)\/?$/.test(s));
  if (!compilaConNx) continue;

  revisados++;
  const faltan = [...necesarios.keys()].filter(
    (f) => !fuentes.some((s) => s === f || s === `./${f}` || s.endsWith(`/${f}`)),
  );
  if (faltan.length) fallas.push({ df: rel(df), faltan });
}

console.log(`  Dockerfiles que compilan con Nx: ${revisados}\n`);

if (revisados === 0) {
  console.log('  ⊘ NO MEDIDO — ningún Dockerfile copia `apps/` o `libs/` de forma granular.');
  console.log('     Sin un Dockerfile así, este candado no vigila nada (ADR-056: se declara, no se');
  console.log('     pinta verde).');
  process.exit(0);
}

// ── La OTRA mitad de la misma trampa: el hash de Nx ─────────────────────────────────────────
// Un archivo de la raíz del que dependa un config de proyecto tiene DOS formas de fallar, y la
// segunda es peor porque es silenciosa:
//
//   · no está en el COPY del Dockerfile  → el build del contenedor no arranca. RUIDOSO.
//   · no está en `sharedGlobals`         → no entra al hash, así que cambiarlo NO invalida la
//                                          caché y `nx test` sirve resultados viejos. MUDO.
//
// MEDIDO el 2026-09-17: con la caché llena, agregándole un comentario a `vitest.shared.ts`,
// `nx test contracts` respondía "Nx read the output from the cache instead of running the
// command". Cambiar la configuración compartida de pruebas no re-corría una sola prueba.
//
// Misma regla que `[NX.1]`: si un target depende de algo fuera de su `projectRoot`, ese algo va
// en los inputs. Allá fueron los assets de `database/migrations` en `apps/api`.
const nx = JSON.parse(fs.readFileSync(path.join(RAIZ, 'nx.json'), 'utf8'));
const globales = (nx.namedInputs && nx.namedInputs.sharedGlobals) || [];
const sinHash = [...necesarios.keys()].filter((f) => !globales.includes(`{workspaceRoot}/${f}`));

if (!fallas.length && !sinHash.length) {
  const n = necesarios.size;
  console.log(`✅ Los ${n} archivo(s) de raíz que los configs piden están en el COPY de los ${revisados}`);
  console.log('   Dockerfile(s) que compilan con Nx, y en `sharedGlobals` (entran al hash de la caché).');
  process.exit(0);
}

if (sinHash.length) {
  console.log('⛔ Fuera del hash de Nx (`namedInputs.sharedGlobals` en nx.json):\n');
  for (const f of sinHash) {
    console.log(`     falta: {workspaceRoot}/${f}   ← lo importa ${necesarios.get(f).join(', ')}`);
  }
  console.log('\n  Sin esto, cambiar ese archivo NO invalida la caché: `nx test` sirve el resultado');
  console.log('  viejo y se lee como verde. Es el modo de falla MUDO, y por eso es el peor.\n');
}

if (!fallas.length) process.exit(1);

console.log('⛔ Falta copiar al contexto:\n');
for (const f of fallas) {
  console.log(`  ${f.df}`);
  for (const x of f.faltan) console.log(`     falta: ${x}   ← lo importa ${necesarios.get(x).join(', ')}`);
}
console.log('\n  El plugin de Nx CARGA esos configs para armar el grafo de proyectos, así que sin el');
console.log('  archivo no falla una prueba: falla `NX Failed to process project graph` y el build');
console.log('  del contenedor no arranca. Agregalo a la línea `COPY` de la raíz de ese Dockerfile.');
process.exit(1);
