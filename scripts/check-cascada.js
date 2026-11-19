#!/usr/bin/env node
/**
 * [OPS] — La cascada de `DESIGN.md` §S/§R, medida.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * `DESIGN.md` §S declara BINDING desde ago-2026: la cascada vive en `@layer` (reset, vendor,
 * tokens, components, utilities); **`!important` exige justificar contra qué capa de vendor pelea**
 * y **`::ng-deep` es sólo para vendor, con comentario y horizonte de retiro**. La «métrica de QA»
 * es que el conteo **no sube**.
 *
 * Medido tres veces sin instrumento, la métrica se incumplió sin que nadie se enterara:
 *
 *   | señal       | ago-2026 | sep-2026 | nov-2026 |
 *   |-------------|---------:|---------:|---------:|
 *   | ::ng-deep   |      317 |      370 |     564  |   ⛔ +78 %
 *   | !important  |      971 |      961 |    1046  |   ⛔  +8 %
 *   | @layer      |        0 |        0 |       0  |   la cascada en capas NO existe
 *
 * El propio doc lo escribió: «una regla BINDING que sólo se verifica en review se cumple tanto
 * como la revisión alcance a mirar; una métrica declarada sin instrumento es una intención»
 * (ADR-056). Las tres cifras que empeoran son las tres mecánicamente medibles — las que un gate
 * frena. Esta compuerta es ese instrumento.
 *
 * ── Qué mira ─────────────────────────────────────────────────────────────────────────────────
 *   DEUDA (ratchet) · `::ng-deep` y `!important` se CONGELAN en su conteo de hoy. La compuerta
 *                     frena si CRECEN. No se piden de golpe (son cientos, cada uno pelea una regla
 *                     de vendor concreta): se ratchetean, como la deuda de layout de check-motion.
 *   PRERREQUISITO   · `@layer` global. Hoy = 0, así que la justificación que §S le pide a un
 *                     `!important` («contra qué capa pelea») es imposible de dar: no hay capa.
 *                     Es INFORMATIVO, no frena — una compuerta que nace roja enseña a ignorarla.
 *                     El orden de trabajo de §S: declarar `@layer` una vez, recién después bajar.
 *
 * ── Qué NO mira, y por qué ───────────────────────────────────────────────────────────────────
 *   · `node_modules`, dotfiles y `.spec.ts` quedan fuera (vendor / prueba, no superficie).
 *   · Lo que está DENTRO de un comentario no cuenta: se explica, no se escribe (igual que
 *     check-motion, que marcaba un `width 900ms` comentado).
 *
 * Uso: `node scripts/check-cascada.js` · prueba negativa: `--self-test`
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');

/**
 * Línea de base sellada el 2026-11-18 por ESTA compuerta (con los comentarios quitados, así que
 * es MENOR que un `grep` crudo: el grep contaba los `::ng-deep`/`!important` que viven dentro de
 * comentarios explicativos). La cifra que gobierna es la de la compuerta, porque es la única que
 * se puede volver a correr. Bajar es la dirección; subir frena el push.
 */
const BASE = { ngDeep: 580, important: 1092 };

const AMBITO = ['apps', 'libs'];
const EXT = new Set(['.ts', '.css', '.scss', '.html']);

/** Quita comentarios de bloque y de línea para no contar lo que está explicado, no escrito. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Cuenta ocurrencias de ::ng-deep, !important y @layer en un fuente (sin comentarios). */
function analizar(src) {
  const limpio = sinComentarios(src);
  const cuenta = (re) => (limpio.match(re) || []).length;
  return {
    ngDeep: cuenta(/::ng-deep\b/g),
    important: cuenta(/!\s*important\b/gi),
    layer: cuenta(/@layer\b/g),
  };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    // [nombre, src, ngDeep, important, layer]
    ['::ng-deep se cuenta',              ':host ::ng-deep .p-foo { color: red }',        1, 0, 0],
    ['!important se cuenta',             '.x { color: red !important }',                 0, 1, 0],
    ['!important con espacio',           '.x { color: red ! important }',                0, 1, 0],
    ['@layer se cuenta',                 '@layer reset, vendor, tokens;',                0, 0, 1],
    ['los tres juntos',                  '@layer a; ::ng-deep .b { c: d !important }',   1, 1, 1],
    ['dentro de bloque /* */ → exento',  '/* ::ng-deep y color:red !important viejos */', 0, 0, 0],
    ['dentro de // → exento',            '// antes: ::ng-deep .x !important',             0, 0, 0],
    ['limpio → cero',                    '.x { color: var(--text-main) }',               0, 0, 0],
    ['ng-deep sin :: no cuenta',         '.ng-deep-legacy { x: y }',                     0, 0, 0],
    ['importante en español no cuenta',  '/* esto es importante */ .x{y:z}',             0, 0, 0],
  ];
  let fallos = 0;
  for (const [nombre, src, eNg, eImp, eLay] of casos) {
    const r = analizar(src);
    const ok = r.ngDeep === eNg && r.important === eImp && r.layer === eLay;
    if (ok) console.log('  ✅ "' + nombre + '"');
    else {
      console.error('  ❌ "' + nombre + '": esperaba ' + eNg + '/' + eImp + '/' + eLay +
        ' (ng/imp/layer), dio ' + r.ngDeep + '/' + r.important + '/' + r.layer);
      fallos++;
    }
  }
  if (fallos) {
    console.error('\n❌ La compuerta no cuenta ' + fallos + ' caso(s) como debe. Arreglala antes de confiar en su verde.\n');
    process.exit(1);
  }
  console.log('\n✅ ' + casos.length + ' casos: cuenta ng-deep, !important y @layer, y respeta los comentarios.\n');
  process.exit(0);
}

// ── Barrido ────────────────────────────────────────────────────────────────────────────────
function recorrer(dir, salida) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return salida; }
  for (const e of entradas) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, salida);
    else if (EXT.has(path.extname(e.name)) && !e.name.endsWith('.spec.ts')) salida.push(p);
  }
  return salida;
}

const archivos = AMBITO.flatMap((a) => recorrer(path.join(RAIZ, a), []));
let ngDeep = 0;
let important = 0;
let layer = 0;
const porArchivoNg = new Map();
const porArchivoImp = new Map();

for (const abs of archivos) {
  const rel = path.relative(RAIZ, abs).replace(/\\/g, '/');
  const r = analizar(fs.readFileSync(abs, 'utf8'));
  ngDeep += r.ngDeep;
  important += r.important;
  layer += r.layer;
  if (r.ngDeep) porArchivoNg.set(rel, r.ngDeep);
  if (r.important) porArchivoImp.set(rel, r.important);
}

function topOfensores(mapa) {
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

const subio = [];
if (ngDeep > BASE.ngDeep) subio.push(['::ng-deep', BASE.ngDeep, ngDeep, porArchivoNg]);
if (important > BASE.important) subio.push(['!important', BASE.important, important, porArchivoImp]);

if (subio.length) {
  for (const [nombre, base, hoy, mapa] of subio) {
    console.error('\n❌ ' + nombre + ' creció: ' + base + ' sellado → ' + hoy + ' hoy (+' + (hoy - base) + ').');
    for (const [rel, n] of topOfensores(mapa)) console.error('   ×' + String(n).padStart(3) + '  ' + rel);
  }
  console.error('\n   DESIGN.md §S: la cascada va en @layer; ::ng-deep es sólo para vendor (con comentario y');
  console.error('   horizonte de retiro) y un !important justifica contra qué capa de vendor pelea. Sobre un');
  console.error('   componente NUESTRO, ::ng-deep es un token de Tier-3 mal hecho (@scope o token, no ng-deep).');
  console.error('   ⛔ Resellar el baseline NO es el arreglo: la métrica es que BAJE, no que se acomode.\n');
  process.exit(1);
}

const bajo = (nombre, base, hoy) =>
  hoy < base ? '  ↓ ' + nombre + ' bajó: ' + base + ' → ' + hoy + ' (resellá BASE con el nuevo mínimo).' : '';

const lineas = [bajo('::ng-deep', BASE.ngDeep, ngDeep), bajo('!important', BASE.important, important)].filter(Boolean);
const avisoLayer = layer === 0
  ? '\n⚠️  @layer = 0: la cascada en capas de §S NO existe, así que ningún !important puede justificarse\n    contra una capa. Prerrequisito de §S: declararla UNA vez global antes de bajar los conteos.'
  : '\n✅ @layer presente (' + layer + ' decl.): la cascada en capas de §S ya tiene dónde vivir.';

console.log('✅ ' + archivos.length + ' archivo(s): ::ng-deep ' + ngDeep + '/' + BASE.ngDeep +
  ' · !important ' + important + '/' + BASE.important + ' — ninguno creció.' +
  (lineas.length ? '\n' + lineas.join('\n') : '') + avisoLayer);
