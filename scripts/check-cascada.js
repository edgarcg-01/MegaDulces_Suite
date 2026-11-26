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
 * ── A quién culpa ([OPS.CASCADA.1], 2026-11-25) ──────────────────────────────────────────────
 *   El `pre-push` (`gate-push.js`) culpa a un push cuando la salida de una compuerta en rojo NOMBRA
 *   un archivo que viaja en él. Esta compuerta nombraba los 10 archivos con MÁS ::ng-deep: un
 *   ranking de la deuda, no de quién la subió. Medido el 2026-11-25: `main` en 585/580 y 1094/1092
 *   (lo subieron 8 commits ya fusionados), y un push que agregaba CERO quedaba frenado por tocar
 *   `finanzas-calendario-pagos.component.ts`, 2º del ranking con 43. Ahora, en rojo, compara cada
 *   archivo que difiere de la base (`CASCADA_BASE`, `NX_BASE` o `origin/main`) y nombra sólo los
 *   que CRECIERON. El ranking sigue a mano con `--ranking`. Sin base comparable, se queda como
 *   antes (nombra el ranking): no poder medir no absuelve a nadie.
 *
 * Uso: `node scripts/check-cascada.js [--ranking]` · prueba negativa: `--self-test`
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

/**
 * `[OPS.CASCADA.1]` Los archivos que CRECIERON contra la base: `hoy` (archivo → cuenta en el árbol) y
 * `antesDe(archivo)` (su cuenta en la base; 0 si no existía). Igual o menos no es crecer.
 */
function crecieron(hoy, antesDe) {
  const out = [];
  for (const [rel, n] of hoy) {
    const antes = antesDe(rel);
    if (n > antes) out.push({ rel, antes, hoy: n });
  }
  return out.sort((a, b) => b.hoy - b.antes - (a.hoy - a.antes) || a.rel.localeCompare(b.rel));
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
  // `[OPS.CASCADA.1]` A quién se culpa: sólo a lo que creció contra la base.
  const base = new Map([['a.ts', 3], ['b.ts', 5], ['c.ts', 2]]);
  const antesDe = (rel) => base.get(rel) ?? 0;
  const culpa = [
    // [nombre, hoy, esperados]
    ['igual que la base → nadie',           [['a.ts', 3]],                         []],
    ['bajó → nadie',                         [['b.ts', 4]],                         []],
    ['subió 1 → ése',                        [['a.ts', 4]],                         ['a.ts']],
    ['archivo nuevo con 2 → ése',            [['nuevo.ts', 2]],                     ['nuevo.ts']],
    ['mezcla → sólo los que suben, el mayor primero', [['a.ts', 3], ['b.ts', 9], ['c.ts', 3], ['d.ts', 1]], ['b.ts', 'c.ts', 'd.ts']],
  ];
  for (const [nombre, hoy, esperados] of culpa) {
    const dio = crecieron(new Map(hoy), antesDe).map((x) => x.rel);
    if (JSON.stringify(dio) === JSON.stringify(esperados)) console.log('  ✅ "' + nombre + '"');
    else {
      console.error('  ❌ "' + nombre + '": esperaba [' + esperados.join(', ') + '], dio [' + dio.join(', ') + ']');
      fallos++;
    }
  }
  if (fallos) {
    console.error('\n❌ La compuerta no cuenta ' + fallos + ' caso(s) como debe. Arreglala antes de confiar en su verde.\n');
    process.exit(1);
  }
  console.log('\n✅ ' + (casos.length + culpa.length) + ' casos: cuenta ng-deep, !important y @layer, respeta los comentarios y culpa sólo a lo que creció.\n');
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

function git(...args) {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

/** `[OPS.CASCADA.1]` La base de la comparación: una explícita, la del CI (`NX_BASE`) o `origin/main`. */
function baseDeComparacion() {
  for (const ref of [process.env.CASCADA_BASE, process.env.NX_BASE, 'origin/main']) {
    if (!ref) continue;
    try {
      return { ref, sha: git('rev-parse', '--verify', '--quiet', ref + '^{commit}').trim() };
    } catch { /* la siguiente */ }
  }
  return null;
}

/** Los archivos del ámbito que difieren de la base: commiteados, sin commitear o nuevos sin versionar. */
function difierenDe(sha) {
  const lista = (...args) => git(...args).split('\n').map((s) => s.trim()).filter(Boolean);
  const todos = new Set([
    ...lista('diff', '--name-only', sha, '--', ...AMBITO),
    ...lista('ls-files', '--others', '--exclude-standard', '--', ...AMBITO),
  ]);
  return [...todos].filter((rel) => EXT.has(path.extname(rel)) && !rel.endsWith('.spec.ts'));
}

/** Su cuenta en la base; 0 si el archivo no existía ahí. */
function cuentaEnBase(sha, rel, clave) {
  try { return analizar(git('show', sha + ':' + rel))[clave]; } catch { return 0; }
}

const subio = [];
if (ngDeep > BASE.ngDeep) subio.push(['::ng-deep', BASE.ngDeep, ngDeep, porArchivoNg, 'ngDeep']);
if (important > BASE.important) subio.push(['!important', BASE.important, important, porArchivoImp, 'important']);

if (subio.length) {
  // ⛔ Ninguna línea de este bloque escribe una ruta que no sea culpable: `gate-push.js` culpa a todo
  // archivo NOMBRADO en la salida (por eso el ranking se pide aparte y el comando va sin ruta).
  const conRanking = process.argv.includes('--ranking');
  const b = conRanking ? null : baseDeComparacion();
  let difieren = null;
  if (b) { try { difieren = difierenDe(b.sha); } catch { difieren = null; } }
  for (const [nombre, base, hoy, mapa, clave] of subio) {
    console.error('\n❌ ' + nombre + ' creció: ' + base + ' sellado → ' + hoy + ' hoy (+' + (hoy - base) + ').');
    if (difieren) {
      const hoyAhi = new Map(difieren.filter((rel) => mapa.has(rel)).map((rel) => [rel, mapa.get(rel)]));
      const suben = crecieron(hoyAhi, (rel) => cuentaEnBase(b.sha, rel, clave));
      const contra = 'Contra ' + b.ref + ' (' + b.sha.slice(0, 9) + ')';
      if (suben.length) {
        console.error('   ' + contra + ', crecieron en este árbol:');
        for (const s of suben) console.error('   +' + String(s.hoy - s.antes).padStart(2) + '  ' + s.rel + '  (' + s.antes + ' → ' + s.hoy + ')');
      } else {
        console.error('   ' + contra + ', ningún archivo de este árbol creció: la deuda ya venía en esa base.');
      }
      console.error('   Dónde está: npm run check:cascada -- --ranking');
    } else {
      if (!conRanking) console.error('   (sin base para comparar archivo por archivo: se nombran los 10 con más)');
      for (const [rel, n] of topOfensores(mapa)) console.error('   ×' + String(n).padStart(3) + '  ' + rel);
    }
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
