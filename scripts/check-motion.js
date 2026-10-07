#!/usr/bin/env node
/**
 * [DS.1] — El techo de motion de `DESIGN.md` §Motion, medido.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * `DESIGN.md` declara BINDING desde hace meses: **350ms de techo duro** (`--dur-max`) y
 * **sólo `transform` + `opacity`**. Su propia tabla de cumplimiento publicaba
 * «19 declaraciones por encima del techo» y el arquetipo canónico —`MetricStrip`, en 81
 * pantallas— animaba `width 900ms`: 2.6× el techo y sobre una propiedad de layout.
 *
 * Dos cosas hicieron que eso viviera tres semanas sin que nadie lo frenara:
 *
 *   1. **Nadie lo medía.** La regla decía «se verifica en review» y el review la pasó por alto
 *      en el componente más copiado del repo. Una regla sin instrumento es una intención.
 *   2. **La medición que SÍ se hizo estaba sesgada**: contaba sólo notación en milisegundos.
 *      Auditando el 2026-10-02 aparecieron **21 `transition` más** escritas en segundos
 *      (`.5s`, `0.8s`, `.7s`) que la cifra publicada no veía. El número real era el doble.
 *      Por eso esta compuerta normaliza **las dos notaciones** antes de comparar.
 *
 * ── Qué mira ─────────────────────────────────────────────────────────────────────────────────
 *   ROJO  · duración > --dur-max (350ms) en un `transition`/`animation` de Operations.
 *           Frena. Al encenderla (2026-10-03) el repo quedó en **0**, a propósito: una
 *           compuerta que nace roja enseña a ignorarla en la primera corrida.
 *   DEUDA · `transition` sobre una propiedad de LAYOUT (width/height/margin/padding/flex/
 *           top/left/right/bottom) o sobre `all`. Hay 25 declaradas; la compuerta frena si
 *           CRECEN. Convertirlas a `transform: scaleX()` pide tocar cada plantilla, así que
 *           se ratchetea en vez de pedirse de golpe.
 *
 * ── Qué NO mira, y por qué ───────────────────────────────────────────────────────────────────
 *   · **`apps/portal` (Storefront) queda fuera.** §Motion dice «nada supera 350ms» pero el doc
 *     de cards dice que el Storefront puede ser más expresivo (count-up hasta 2s), y el código
 *     tiene 4 archivos de portal con celebraciones de 420–1100ms. Es una contradicción del
 *     DOCUMENTO, no del código: se resolvió declarando el techo **por surface**. Si algún día
 *     el Storefront quiere techo, se agrega acá y se mide antes de encender.
 *   · **`animation ... infinite`** (shimmer ~1.2s, dot «live» ~2s) está exento: el doc de cards
 *     los prescribe con esas duraciones. Un loop lento no es una transición lenta.
 *   · **`stroke-dashoffset` / `stroke-dasharray`**: J17 los bendice para micro-viz SVG (es la
 *     única forma de dibujar un arco progresivo) y no disparan layout. Su DURACIÓN sí entra.
 *
 * Uso: `node scripts/check-motion.js` · prueba negativa: `--self-test`
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const TECHO_MS = 350;

/**
 * Línea de base de la deuda de layout, medida por ESTA compuerta el 2026-10-03.
 * ⚠️ El barrido manual de la auditoría dio **25** con un `grep` más angosto. La cifra que
 * gobierna es la de la compuerta —48—, porque es la única que se puede volver a correr.
 * Las 48 se revisaron una por una antes de congelarlas: **cero falsos positivos** (todas
 * animan width/height/padding/flex/max-width, o usan `all`, que arrastra layout sin que
 * nadie lo haya elegido). Es la lección de `check-keyboard-nav`, que encendió marcando
 * 7 falsos de 8 y por un rato enseñó a ignorarla.
 */
const DEUDA_LAYOUT_BASE = 48;

/** Raíces que viven bajo el techo de Operations. `apps/portal` queda fuera a propósito (ver cabecera). */
const AMBITO = ['apps/view', 'apps/vendor', 'libs'];
const EXT = new Set(['.ts', '.css', '.html']);

const PROPS_LAYOUT = /\b(width|height|margin|padding|flex|flex-basis|top|left|right|bottom|inset)\b/;

/** Quita comentarios de bloque y de línea para no marcar lo que está explicado, no escrito. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 900ms → 900 · .5s → 500 · 0.8s → 800 */
function aMs(valor, unidad) {
  const n = parseFloat(valor);
  return unidad === 's' ? n * 1000 : n;
}

/**
 * Devuelve { lentas, layout } de un fuente.
 *   lentas: duraciones por encima del techo (excluye loops infinitos)
 *   layout: declaraciones de transition sobre una propiedad que dispara layout
 */
function analizar(src) {
  const limpio = sinComentarios(src);
  const lentas = [];
  const layout = [];

  const decl = /(transition|animation)(-duration|-property)?\s*:\s*([^;}"'`]*)/g;
  let m;
  while ((m = decl.exec(limpio)) !== null) {
    const tipo = m[1];
    const cuerpo = m[3];
    if (/^\s*(none|unset|initial|inherit)\s*$/.test(cuerpo)) continue;

    // Un loop infinito no es una transición lenta: el doc de cards los prescribe (shimmer, breathe).
    const esLoop = tipo === 'animation' && /\binfinite\b/.test(cuerpo);

    if (!esLoop) {
      const dur = /(\d*\.?\d+)(ms|s)\b/g;
      let d;
      while ((d = dur.exec(cuerpo)) !== null) {
        const ms = aMs(d[1], d[2]);
        if (ms > TECHO_MS) lentas.push({ ms, cuerpo: cuerpo.trim() });
      }
    }

    if (tipo === 'transition') {
      // `all` arrastra también las de layout: nadie eligió qué se anima.
      if (/\ball\b/.test(cuerpo) || PROPS_LAYOUT.test(cuerpo)) {
        layout.push({ cuerpo: cuerpo.trim() });
      }
    }
  }
  return { lentas, layout };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    ['ms sobre el techo → rojo',          'transition: opacity 900ms ease;',                    1, 0],
    ['ms bajo el techo → limpio',         'transition: opacity 250ms ease;',                    0, 0],
    ['SEGUNDOS sobre el techo → rojo',    'transition: opacity .5s ease;',                      1, 0],
    ['segundos bajo el techo → limpio',   'transition: opacity 0.15s ease;',                    0, 0],
    ['justo en el techo → limpio',        'transition: transform 350ms ease;',                  0, 0],
    ['width → deuda de layout',           'transition: width 250ms ease;',                      0, 1],
    ['all → deuda de layout',             'transition: all 0.2s ease;',                         0, 1],
    ['transform+opacity → limpio',        'transition: transform 250ms, opacity 150ms;',        0, 0],
    ['loop infinito lento → exento',      'animation: shimmer 1.2s linear infinite;',           0, 0],
    ['animation lenta NO loop → rojo',    'animation: reveal 500ms ease both;',                 1, 0],
    ['transition:none → exento',          'transition: none;',                                  0, 0],
    ['token sin numero → limpio',         'transition: width var(--dur-standard,250ms) ease;',  0, 1],
    // Las tres que la compuerta se perdería si no lo pensara:
    ['dentro de un comentario → exento',  '/* antes era transition: width 900ms ease; */',      0, 0],
    ['stroke-dashoffset lento → rojo',    'transition: stroke-dashoffset .7s ease;',            1, 0],
    ['stroke-dashoffset NO es layout',    'transition: stroke-dashoffset 250ms ease;',          0, 0],
  ];
  let fallos = 0;
  for (const [nombre, src, esperaLenta, esperaLayout] of casos) {
    const r = analizar(src);
    const ok = r.lentas.length === esperaLenta && r.layout.length === esperaLayout;
    if (ok) console.log('  ✅ "' + nombre + '"');
    else {
      console.error('  ❌ "' + nombre + '": esperaba ' + esperaLenta + ' lenta/' + esperaLayout +
        ' layout, dio ' + r.lentas.length + '/' + r.layout.length);
      fallos++;
    }
  }
  if (fallos) {
    console.error('\n❌ La compuerta no clasifica ' + fallos + ' caso(s) como debe. Arreglala antes de confiar en su verde.\n');
    process.exit(1);
  }
  console.log('\n✅ ' + casos.length + ' casos: distingue techo, layout, loop y comentario exactamente donde debe.\n');
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
const rojos = [];
const deuda = [];

for (const abs of archivos) {
  const rel = path.relative(RAIZ, abs).replace(/\\/g, '/');
  const { lentas, layout } = analizar(fs.readFileSync(abs, 'utf8'));
  for (const l of lentas) rojos.push({ rel, ...l });
  for (const l of layout) deuda.push({ rel, ...l });
}

if (rojos.length) {
  console.error('\n❌ ' + rojos.length + ' declaracion(es) por encima del techo de ' + TECHO_MS + 'ms que DESIGN.md §Motion marca BINDING:\n');
  for (const r of rojos.sort((a, b) => b.ms - a.ms).slice(0, 25)) {
    console.error('   ' + String(Math.round(r.ms)).padStart(5) + 'ms  ' + r.rel);
    console.error('          ' + r.cuerpo.slice(0, 110));
  }
  if (rojos.length > 25) console.error('   … y ' + (rojos.length - 25) + ' más');
  console.error('\n   Cómo se arregla: usá var(--dur-micro|short|standard|max). El techo es --dur-max (350ms).');
  console.error('   ⛔ Subir el techo NO es el arreglo: 350ms es la frontera donde una transicion');
  console.error('      deja de sentirse como respuesta y empieza a sentirse como espera.\n');
  process.exit(1);
}

if (deuda.length > DEUDA_LAYOUT_BASE) {
  console.error('\n❌ Las transiciones sobre propiedades de LAYOUT crecieron: ' + DEUDA_LAYOUT_BASE +
    ' declaradas → ' + deuda.length + ' hoy.\n');
  const porArchivo = new Map();
  for (const d of deuda) porArchivo.set(d.rel, (porArchivo.get(d.rel) || 0) + 1);
  for (const [rel, n] of [...porArchivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.error('   ×' + n + '  ' + rel);
  }
  console.error('\n   Una barra se anima con transform: scaleX() sobre un elemento de ancho fijo,');
  console.error('   con el radio en el track (que ya recorta). Ver MetricCard como referencia.');
  console.error('   Si de verdad no se puede (segmentos hermanos de un flex), se DECLARA con su razón.\n');
  process.exit(1);
}

const deudaTxt = deuda.length
  ? '\n⚠️  ' + deuda.length + ' transicion(es) sobre propiedades de layout, declaradas como deuda [DS.1]' +
    ' (tope ' + DEUDA_LAYOUT_BASE + '). Frena si crecen.'
  : '';

console.log('✅ ' + archivos.length + ' archivo(s) de Operations: ninguna animación supera el techo de ' +
  TECHO_MS + 'ms.' + deudaTxt);
