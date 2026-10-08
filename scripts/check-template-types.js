#!/usr/bin/env node
/**
 * `npm run check:templates-types` — LOS TIPOS DENTRO DE LAS PLANTILLAS DE ANGULAR.
 *
 * ── Por qué existe, medido ──────────────────────────────────────────────────────────────────
 *
 * El 2026-10-08 entró a `main` una pantalla con un error de tipo **en su plantilla**:
 *
 * ```text
 *   TS2345: Argument of type 'CountSelectionItem | CountSelectionItem[] | undefined'
 *           is not assignable to parameter of type 'CountSelectionItem'.
 * ```
 *
 * (PrimeNG declara `TableRowSelectEvent.data` como `T | T[] | undefined` porque `[(selection)]`
 * admite single y múltiple.) **Las tres compuertas locales dieron verde**, y cada una por una
 * razón distinta:
 *
 *   · `check:templates`  mira que el literal esté entero y que el CSS parsee — no los tipos
 *   · `tsc -p tsconfig.app.json`  **no compila plantillas**: para TypeScript son strings
 *   · `nx build`  es el único con `strictTemplates`… y está prohibido correrlo en local
 *
 * ⚠️ Y una cuarta que PARECE cubrirlo y no: **montar el componente en un spec tampoco alcanza**.
 * Se midió revirtiendo el arreglo — el `TestBed` compila en JIT, atrapa bindings rotos y
 * directivas sin importar, pero **no aplica `strictTemplates`**: la prueba de «monta» siguió
 * verde con el error puesto.
 *
 * Resultado: el único que lo veía era el CI, o sea **después del push**, cuando ya frenó la
 * tubería de todos. Esta compuerta lo adelanta.
 *
 * ── Qué hace, y por qué NO es «compilar para verificar» ─────────────────────────────────────
 *
 * Corre `ngc --noEmit` sobre el `tsconfig.app.json` de cada app de Angular. **No emite nada**, no
 * levanta servidor y no toca ninguna base: es el equivalente de `tsc --noEmit`, que este repo ya
 * usa, extendido a las plantillas. La regla de «nada de compilar en local» existe porque un
 * backend local apuntando a prod es un escritor que nadie declaró y toma el candado de
 * migraciones; nada de eso ocurre acá.
 *
 * ── Errores frenan · advertencias se informan ──────────────────────────────────────────────
 *
 * ⚠️ `ngc` también emite advertencias (`NG8113`: una directiva en `imports:` que la plantilla no
 * usa). Medido el 2026-10-08 el repo trae varias y **cero errores**. Si la compuerta fallara con
 * ellas nacería roja, y una compuerta que nace roja se aprende a ignorar — el proyecto ya pagó
 * eso con `verify` en el CI. Así que las advertencias se **cuentan y se muestran**, no frenan.
 *
 * ── Costo ───────────────────────────────────────────────────────────────────────────────────
 *
 * Medido: **~67 s** para `view` (la app grande). ⛔ Por eso **no lleva `push: true`**: el criterio
 * de admisión del hook de push es ~3 s. Vive en `npm run check` y en el CI.
 *
 *   node scripts/check-template-types.js            # todas las apps de Angular
 *   node scripts/check-template-types.js --app=view # una sola
 *   node scripts/check-template-types.js --self-test
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RAIZ = path.join(__dirname, '..');

/** Apps de Angular: las que tienen `tsconfig.app.json` **y** un `angularCompilerOptions` arriba. */
function appsDeAngular() {
  const dir = path.join(RAIZ, 'apps');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((a) => {
    const tsc = path.join(dir, a, 'tsconfig.app.json');
    if (!fs.existsSync(tsc)) return false;
    // `apps/api` es NestJS: tiene tsconfig.app.json y ninguna plantilla que chequear.
    const base = path.join(dir, a, 'tsconfig.json');
    const txt = (fs.existsSync(base) ? fs.readFileSync(base, 'utf8') : '')
      + fs.readFileSync(tsc, 'utf8');
    return txt.includes('angularCompilerOptions');
  });
}

/** Separa errores de advertencias en la salida de `ngc`, sin los códigos de color. */
function analizar(salida) {
  // El regex se arma con `RegExp` y no como literal para no llevar un carácter de control en el
  // fuente (eslint `no-control-regex`). Mismo efecto, y el archivo sigue siendo legible.
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const limpio = salida.replace(ANSI, '');
  const errores = [];
  const avisos = [];
  for (const linea of limpio.split(/\r?\n/)) {
    // `ruta:linea:col - error TS1234: ...`  /  `- warning NG8113: ...`
    const m = linea.match(/^(.*?):(\d+):(\d+) - (error|warning) ([A-Z]{2}\d+|TS\d+): (.*)$/);
    if (!m) continue;
    const item = { archivo: m[1], linea: Number(m[2]), col: Number(m[3]), codigo: m[5], texto: m[6] };
    (m[4] === 'error' ? errores : avisos).push(item);
  }
  return { errores, avisos };
}

function correr(tsconfig, cwd = RAIZ) {
  const bin = path.join(RAIZ, 'node_modules', '.bin', process.platform === 'win32' ? 'ngc.cmd' : 'ngc');
  const r = spawnSync(bin, ['-p', tsconfig, '--noEmit'], {
    cwd, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 1 << 26,
  });
  return { ...analizar((r.stdout || '') + (r.stderr || '')), code: r.status };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
// Un gate sin prueba negativa es una intención. Acá se construye un componente MÍNIMO con un
// error de tipo SOLO en su plantilla, se comprueba que sale rojo, y después el control: el mismo
// componente bien escrito tiene que salir limpio. Sin el control, un `ngc` que fallara por
// cualquier otro motivo (un tsconfig mal armado) haría pasar la prueba por la razón equivocada.
if (process.argv.includes('--self-test')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-tpl-tipos-'));
  const escribir = (comp) => {
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler', strict: true,
        experimentalDecorators: true, skipLibCheck: true, noEmit: true,
        types: [], lib: ['ES2022', 'DOM'],
        paths: { '*': [path.join(RAIZ, 'node_modules', '*').replace(/\\/g, '/')] },
      },
      angularCompilerOptions: { strictTemplates: true },
      files: ['comp.ts'],
    }, null, 2));
    fs.writeFileSync(path.join(tmp, 'comp.ts'), comp);
  };

  const ROTO = `
import { Component } from '@angular/core';
@Component({
  selector: 'x-roto',
  standalone: true,
  template: '<button (click)="recibe(valor)">x</button>',
})
export class Roto {
  valor: string | undefined = undefined;
  recibe(_v: string) { /* exige string, la plantilla le pasa string|undefined */ }
}
`;
  const SANO = ROTO.replace('recibe(_v: string)', 'recibe(_v: string | undefined)');

  let fallos = 0;
  escribir(ROTO);
  const malo = correr(path.join(tmp, 'tsconfig.json'), tmp);
  if (malo.errores.length > 0) {
    console.log(`  ✅ "plantilla con tipo incompatible → ROJO" (${malo.errores[0].codigo})`);
  } else {
    console.error('  ❌ "plantilla con tipo incompatible → ROJO": salió limpia, la compuerta no ve nada');
    fallos++;
  }

  escribir(SANO);
  const bueno = correr(path.join(tmp, 'tsconfig.json'), tmp);
  if (bueno.errores.length === 0) {
    console.log('  ✅ "la misma plantilla, bien tipada → LIMPIA" (control del arnés)');
  } else {
    console.error(`  ❌ control del arnés: el caso SANO también dio rojo (${bueno.errores[0].texto})`);
    console.error('     la compuerta estaría fallando por el armado, no por el defecto');
    fallos++;
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (fallos) { console.error(`\n❌ self-test: ${fallos} caso(s) mal`); process.exit(1); }
  console.log('\n✅ self-test: la compuerta ve el defecto y no grita sobre lo sano.');
  process.exit(0);
}

// ── Qué cuenta como "tuyo" ─────────────────────────────────────────────────────────────────
/**
 * ⭐ **El ámbito es LO QUE SE VA A PUSHEAR, no el árbol sucio.** Y la distinción no es teórica:
 * se midió en las dos primeras corridas de esta compuerta, el 2026-10-08.
 *
 * **Primera corrida:** 28 errores, **ninguno de quien la corría** — otra sesión estaba a medio
 * escribir en el **árbol compartido** (ya había puesto las referencias en la plantilla, todavía
 * no los miembros del componente). `main` estaba sano.
 *
 * **Segunda, con el primer criterio puesto:** seguía roja, y el defecto era del criterio. Había
 * definido «tuyo» como *todo lo no commiteado*, y en un árbol que comparten 10 sesiones **«sin
 * commitear» no es «mío»: es de todos**. No hay forma de distinguir mi edición de la de otra
 * sesión dentro del mismo working tree — esa información no existe ahí.
 *
 * Dónde **sí** existe: en los **commits**. Lo que esta rama tiene sobre `origin/main` es trabajo
 * commiteado y es, literalmente, lo que el push va a mandar. Si ahí hay una plantilla rota, el CI
 * se va a poner rojo — así que frenar por eso es correcto, y frenar por el borrador de otra
 * sesión no lo es.
 *
 * Con 10+ sesiones sobre un árbol, una compuerta de workspace entero **nace roja casi siempre**
 * y por código ajeno a medias, que es exactamente como se enseña a ignorarla. El criterio ya
 * estaba escrito en `CLAUDE.md` para el hook de push: *gates sobre tus archivos, sin frenarte con
 * la deuda ajena*.
 *
 *   (default)        frena por lo commiteado que falta pushear
 *   --files=a,b      frena sólo por esos (útil antes de un commit con pathspec)
 *   --all            frena por todo: el modo del CI, donde el árbol está limpio
 */
function archivosEnAlcance() {
  const explicito = (process.argv.find((a) => a.startsWith('--files=')) || '').split('=')[1];
  const salida = new Set();
  const add = (txt) => (txt || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .forEach((f) => salida.add(f.replace(/\\/g, '/')));
  if (explicito) { add(explicito.split(',').join('\n')); return salida; }
  const git = (args) => spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' }).stdout;
  const base = (git(['merge-base', 'HEAD', 'origin/main']) || '').trim();
  // ⛔ A propósito NO se miran `git diff` ni los untracked: en un árbol compartido eso es el
  //    borrador de cualquiera, y frenar a alguien por el código a medias de otro es el defecto
  //    que esta compuerta estaría introduciendo en vez de resolviendo.
  if (base) add(git(['diff', '--name-only', `${base}...HEAD`]));
  return salida;
}

// ── Corrida normal ─────────────────────────────────────────────────────────────────────────
const TODO = process.argv.includes('--all');
const ALCANCE_INICIAL = TODO ? null : archivosEnAlcance();

/**
 * ⛔ **El hueco que esta compuerta tuvo en su primera hora de vida: VERDE POR VACUIDAD.**
 *
 * Medido el 2026-10-08, el mismo día que nació. `[PROC.4]` fijó que se trabaja sobre `main`, así
 * que otra sesión pusheó y `git rev-list --count base..HEAD` dio **0**: cero commits sin pushear
 * → alcance **vacío** → la compuerta imprimió *«✅ Las plantillas que se van a pushear
 * typechequean»* **sobre cero archivos**, mientras `origin/main` tenía una plantilla rota
 * (`whParam` privado usado desde el template, TS2341, del commit `98d6fcdd7`).
 *
 * Una afirmación vacuamente cierta se lee igual que una medición — es el mismo defecto que esta
 * fase persiguió todo el día en los datos, ahora en una compuerta. ⭐ Con el alcance vacío **no
 * hay nada que acotar, así que se revisa todo**: es más lento pero es lo único honesto, y además
 * es el caso en que no hay trabajo propio que el ruido ajeno pueda ensuciar.
 */
const VACIO = !TODO && ALCANCE_INICIAL.size === 0;

/**
 * Archivos con cambios **sin commitear** en este árbol. En un worktree compartido son el borrador
 * en vuelo de cualquiera, y por definición **no están en `main`**.
 */
function archivosSucios() {
  const git = (args) => spawnSync('git', args, { cwd: RAIZ, encoding: 'utf8' }).stdout;
  const s = new Set();
  for (const cmd of [['diff', '--name-only'], ['diff', '--name-only', '--cached'],
    ['ls-files', '--others', '--exclude-standard']]) {
    (git(cmd) || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
      .forEach((f) => s.add(f.replace(/\\/g, '/')));
  }
  return s;
}

/**
 * ⭐ Con el alcance vacío, lo que frena son los archivos **LIMPIOS**, no todos.
 *
 * Primera versión de este bloque: con 0 commits sin pushear se revisaba *todo*, y volvió a nacer
 * roja — esta vez por errores de **sintaxis** de otra sesión editando en ese mismo momento. Dos
 * intentos, dos veces el mismo error de mi parte: confundir «está en el árbol» con «es un
 * problema de alguien».
 *
 * La distinción que de verdad importa es otra: **¿está roto en `main`?** Eso es lo que frena el
 * `Build & typecheck`, lo que impide sellar `ci-green` y lo que deja a prod sin desplegar.
 *
 *   · archivo **sucio** con error  → alguien está a medio escribir  → se informa
 *   · archivo **limpio** con error → está así en el árbol commiteado → **frena**
 *
 * Y no es teórico: así se encontró que `origin/main` tenía `whParam` privado usado desde una
 * plantilla (TS2341, commit `98d6fcdd7`) mientras esta compuerta decía ✅ sobre cero archivos.
 */
const SUCIOS = VACIO ? archivosSucios() : null;
if (VACIO) {
  console.log('ⓘ No hay commits sin pushear. En vez de dar un ✅ sobre cero archivos —que se lee'
    + ' igual que una revisión y no lo es— se revisa el árbol COMMITEADO:');
  console.log(`  frenan los archivos limpios (están así en main); los ${SUCIOS.size} con cambios`
    + ' sin commitear son borrador de alguna sesión y sólo se informan.');
}
const EN_ALCANCE = TODO || VACIO ? null : ALCANCE_INICIAL;
const AMBITO = TODO ? 'todo el workspace' : (VACIO ? 'lo commiteado en el árbol' : 'lo que se va a pushear');
const soloApp = (process.argv.find((a) => a.startsWith('--app=')) || '').split('=')[1];
const apps = appsDeAngular().filter((a) => !soloApp || a === soloApp);

if (!apps.length) {
  console.error(soloApp ? `❌ no hay app de Angular llamada "${soloApp}"` : '❌ no se encontró ninguna app de Angular');
  process.exit(1);
}

let tuyos = 0;
let ajenos = 0;
let avisos = 0;
/** Comparación por ruta COMPLETA (o sufijo con separador): un `endsWith` suelto atribuía a quien
 *  corría la compuerta archivos de otra sesión que sólo coincidían en el nombre. */
const enConjunto = (conj, e, app) => {
  const rel = `apps/${app}/${e.archivo}`.replace(/\\/g, '/');
  const relArchivo = e.archivo.replace(/\\/g, '/');
  return conj.has(rel) || [...conj].some((m) => m === rel || m.endsWith(`/${relArchivo}`));
};

const frena = (e, app) => {
  if (TODO) return true;
  // Alcance vacío: frena lo que está LIMPIO (o sea, así está en main). Ver el bloque de arriba.
  if (VACIO) return !enConjunto(SUCIOS, e, app);
  return enConjunto(EN_ALCANCE, e, app);
};

for (const app of apps) {
  const t0 = Date.now();
  const r = correr(path.join('apps', app, 'tsconfig.app.json'));
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  avisos += r.avisos.length;

  const mios = r.errores.filter((e) => frena(e, app));
  const otros = r.errores.filter((e) => !frena(e, app));
  tuyos += mios.length;
  ajenos += otros.length;

  if (mios.length) {
    console.error(`\n❌ ${app}: ${mios.length} error(es) de tipo en plantillas de ${AMBITO}  (${seg}s)`);
    for (const e of mios.slice(0, 20)) {
      console.error(`   ${e.archivo}:${e.linea}:${e.col}  ${e.codigo}  ${e.texto}`);
    }
    if (mios.length > 20) console.error(`   … y ${mios.length - 20} más`);
  } else {
    console.log(`✅ ${app}: sin errores de tipo en ${AMBITO}  (${seg}s · ${r.avisos.length} advertencia(s))`);
  }

  if (otros.length) {
    // Se NOMBRAN, no se esconden: callarlos dejaría a alguien creyendo que el árbol está sano.
    const archivos = [...new Set(otros.map((e) => e.archivo))];
    console.log(`ⓘ ${app}: ${otros.length} error(es) en ${archivos.length} archivo(s) fuera de alcance (arbol compartido/deuda previa)`
      + ' (árbol compartido). No frenan acá:');
    for (const a of archivos.slice(0, 6)) console.log(`     ${a}`);
    if (archivos.length > 6) console.log(`     … y ${archivos.length - 6} más`);
  }
}

if (avisos) {
  console.log(`\nⓘ ${avisos} advertencia(s) de Angular (p. ej. NG8113, una directiva importada que`
    + ' la plantilla no usa). NO frenan: el repo ya las traía y una compuerta que nace roja se'
    + ' aprende a ignorar. Vale limpiarlas aparte.');
}

if (ajenos && !tuyos) {
  console.log(`\n⚠️ Hay ${ajenos} error(es) de plantilla de otras sesiones en este árbol. Si llegan`
    + ' a `main` tiran el build de todos — pero no son tuyos y esta compuerta no te frena por'
    + ' ellos. Corré con `--all` para verlos como rojo (es lo que hace el CI).');
}

if (tuyos) {
  console.error(`\n❌ ${tuyos} error(es) de tipo en plantillas de ${AMBITO}. El CI los iba a`
    + ' encontrar igual, pero después del push — y ahí ya frenó la tubería de todos.');
  process.exit(1);
}
console.log(`\n✅ Las plantillas de ${AMBITO} typechequean.`);
