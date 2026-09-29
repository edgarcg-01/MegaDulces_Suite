#!/usr/bin/env node
/**
 * [UIM.1] — Una tabla que declara un ancho mínimo grande ya confesó que no cabe en un teléfono.
 * Esta compuerta exige que, además de confesarlo, haga algo al respecto.
 *
 * ── Qué mide, y por qué ese umbral ───────────────────────────────────────────────────────────
 * Un `[tableStyle]="{ 'min-width': 'NNrem' }"` es un PISO: por debajo de NN la tabla no se
 * encoge, desplaza. Con NN >= 48rem (768 px) no hay teléfono que la contenga — el más ancho de
 * la flota anda por 430 px. A partir de ahí la tabla tiene que declarar qué hace cuando el
 * contenedor es estrecho:
 *
 *   · .dt-stack                   → apila el renglón (libs/ui-web/src/dense-table.css)
 *   · .dt-matrix-ok               → es un PIVOTE y pierde un eje por su cuenta; el eje se elige
 *                                   arriba como alcance. Apilar una matriz da N renglones por
 *                                   registro, que es peor que el scroll — ver DESIGN_TABLES.md.
 *
 * Y si lleva .dt-stack, alguien tiene que establecer el contenedor: sin un .dt-scope en el mismo
 * archivo, la consulta de contenedor no tiene contra qué medir y el CSS entero es INERTE. Ese es
 * el modo de falla que importa: la clase puesta, el archivo importado, el build verde, y la
 * pantalla exactamente igual de rota. Un gate que no mira el .dt-scope se pone verde sobre eso.
 *
 * ── Prueba negativa ──────────────────────────────────────────────────────────────────────────
 * `node scripts/check-dense-tables.js --self-test` construye en memoria los cuatro casos malos
 * y verifica que los cuatro salgan ROJOS. Si un día alguien afloja el regex, el self-test cae
 * antes que la compuerta, que es el orden que sirve. Un gate sin prueba negativa es una
 * intención (regla del repo).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];

/** A partir de acá ningún teléfono la contiene. 48rem = 768 px; la flota tope ronda 430 px. */
const UMBRAL_REM = 48;

/**
 * DEUDA DECLARADA — las que ya estaban rotas cuando se escribió la compuerta (2026-09-28).
 *
 * No se silencian: se CUENTAN y se imprimen en cada corrida. La compuerta existe para que no
 * entre una número doce, no para fingir que las once no están. Sacar un archivo de esta lista
 * es el trabajo; agregarle uno nuevo es hacer trampa, y por eso la lista se revisa en review.
 *
 * ⛔ La lista también se cae sola: si un archivo de acá deja de tener tabla ancha (porque lo
 * arreglaron) la compuerta lo dice y hay que sacarlo. Una lista de excepciones que no avisa
 * cuando sobra es una lista que crece para siempre.
 */
const DEUDA = new Set([
  'apps/view/src/app/modules/compras/pages/compras-pedido-real.component.ts',
]);

const RE_MINWIDTH = /'min-width'\s*:\s*'([0-9.]+)rem'/g;

function analizar(src) {
  const anchos = [];
  let m;
  RE_MINWIDTH.lastIndex = 0;
  while ((m = RE_MINWIDTH.exec(src)) !== null) anchos.push(parseFloat(m[1]));

  const grandes = anchos.filter((n) => n >= UMBRAL_REM);
  if (!grandes.length) return null;

  const tieneStack = /\bdt-stack\b/.test(src);
  const tieneMatrix = /\bdt-matrix-ok\b/.test(src);
  const tieneScope = /\bdt-scope\b/.test(src);

  if (!tieneStack && !tieneMatrix) {
    return {
      anchos: grandes,
      motivo:
        'declara min-width >= ' + UMBRAL_REM + 'rem y no dice qué hace en estrecho: ' +
        'le falta dt-stack (+ dt-scope), o dt-matrix-ok si es un pivote.',
    };
  }
  if (tieneStack && !tieneScope) {
    return {
      anchos: grandes,
      motivo:
        'lleva dt-stack pero NINGÚN dt-scope: sin contenedor declarado la consulta no mide nada ' +
        'y el apilado no ocurre. Se ve igual de roto, pero en verde.',
    };
  }
  return null;
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    ['sin nada', "[tableStyle]=\"{ 'min-width': '60rem' }\"", true],
    ['justo en el umbral', "[tableStyle]=\"{ 'min-width': '48rem' }\"", true],
    ['stack sin scope', "[tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-stack\"", true],
    ['stack ancho sin scope', "[tableStyle]=\"{ 'min-width': '78rem' }\" styleClass=\"dt-stack\"", true],
    ['stack con scope', "<div class=\"dt-scope\"> [tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-stack\"", false],
    ['pivote declarado', "[tableStyle]=\"{ 'min-width': '60rem' }\" styleClass=\"dt-matrix-ok\"", false],
    ['angosta, no aplica', "[tableStyle]=\"{ 'min-width': '32rem' }\"", false],
  ];
  let fallos = 0;
  for (const [nombre, src, debeFallar] of casos) {
    const r = analizar(src);
    const fallo = r !== null;
    if (fallo !== debeFallar) {
      console.error(`  ❌ self-test "${nombre}": esperaba ${debeFallar ? 'ROJO' : 'verde'} y dio ${fallo ? 'ROJO' : 'verde'}`);
      fallos++;
    } else {
      console.log(`  ✅ self-test "${nombre}": ${debeFallar ? 'rojo' : 'verde'}, como debe`);
    }
  }
  if (fallos) {
    console.error(`\n❌ La compuerta no detecta ${fallos} caso(s) que debería. Arreglala antes de confiar en su verde.\n`);
    process.exit(1);
  }
  console.log(`\n✅ ${casos.length} casos: la compuerta se pone roja exactamente donde debe.\n`);
  process.exit(0);
}

// ── Barrido ────────────────────────────────────────────────────────────────────────────────
function recorrer(dir, salida) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return salida;
  }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, salida);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) salida.push(p);
  }
  return salida;
}

const archivos = [];
for (const app of APPS) recorrer(path.join(RAIZ, app), archivos);

const malos = [];
const enDeuda = [];
const vistos = new Set();
let conAncho = 0;

for (const f of archivos) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('min-width')) continue;
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  const r = analizar(src);
  if (r) {
    conAncho++;
    vistos.add(rel);
    if (DEUDA.has(rel)) enDeuda.push({ rel, ...r });
    else malos.push({ rel, ...r });
  } else if (/'min-width'\s*:\s*'[0-9.]+rem'/.test(src)) {
    conAncho++;
    vistos.add(rel);
  }
}

// La lista de deuda se cae sola cuando sobra: un archivo que ya se arregló (o que se renombró)
// tiene que SALIR de la lista, y eso sólo pasa si la compuerta lo reclama.
const sobrantes = [...DEUDA].filter((d) => !vistos.has(d) || !enDeuda.some((e) => e.rel === d));
if (sobrantes.length) {
  console.error('\n❌ Estos archivos están en la lista de deuda y ya no la necesitan:');
  for (const s of sobrantes) console.error(`   · ${s}`);
  console.error('   Sacalos de DEUDA en scripts/check-dense-tables.js. Una lista de excepciones');
  console.error('   que no se poda deja de decir cuánto falta.\n');
  process.exit(1);
}

if (malos.length) {
  console.error('');
  for (const m of malos) {
    console.error(`❌ ${m.rel}`);
    console.error(`   min-width: ${m.anchos.map((n) => n + 'rem').join(', ')}`);
    console.error(`   ${m.motivo}`);
  }
  console.error(`\n${malos.length} de ${conAncho} tabla(s) anchas sin salida en estrecho.`);
  console.error('   Cómo se arregla, en DESIGN_TABLES.md §"Tabla estrecha":');
  console.error('     · columnas = CAMPOS de un registro → .dt-scope en el contenedor + .dt-stack en la tabla');
  console.error('       + data-label y role="cell" en cada <td>.');
  console.error('     · columnas = otra DIMENSIÓN (pivote) → el eje se elige arriba como alcance, la');
  console.error('       comparación se muda al detalle, y la tabla se marca .dt-matrix-ok.');
  console.error('   ⛔ Subir el umbral de esta compuerta no es una de las dos salidas.\n');
  process.exit(1);
}

const deudaTxt = enDeuda.length
  ? `\n⚠️  ${enDeuda.length} pantalla(s) en DEUDA DECLARADA — anchas y sin salida en estrecho, con nombre y fecha:\n` +
    enDeuda.map((d) => `     · ${d.rel} (${d.anchos.map((n) => n + 'rem').join(', ')})`).join('\n') +
    '\n   No son un aprobado: son el trabajo que falta. Tracker: [UIM.2].'
  : '';

console.log(
  `✅ ${archivos.length} componente(s) · ${conAncho} tabla(s) con ancho mínimo declarado: ` +
  `ninguna NUEVA sin salida en estrecho.${deudaTxt}`,
);
