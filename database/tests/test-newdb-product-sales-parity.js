/* eslint-disable no-console */
/**
 * `[CANON.5.9]` — **Nadie lee la venta mensual por producto: quedó congelada.**
 *
 * ── DE DÓNDE SALE ESTE CANDADO ──────────────────────────────────────────────────────────────
 * Hasta el 2026-11-05 este archivo era `[AUD-DAT.10]`: exigía que `analytics.product_sales_monthly`
 * fuera EXACTAMENTE el rollup de `analytics.product_sales_daily`, por almacén y mes cerrado. Ese
 * candado nació de un daño real (en 2026 la mensual llegó a publicar 44.7 % menos que la diaria,
 * y `MD-32` en cero con 94,400 u) y se arregló haciendo de la mensual un rollup con un solo dueño.
 *
 * `[CANON.5.9]` retiró ese dueño (`import-product-sales-monthly.js`): su único lector de carril,
 * `thot-build-features.js`, ahora suma la diaria por mes él mismo (36,502 de 36,502 filas
 * idénticas, medido en prod), y `deactivate-legacy-skus.js` ya exigía «sin venta diaria», que
 * implica «sin venta mensual» (0 productos en la mensual sin diaria).
 *
 * Desde entonces la mensual NO se actualiza. El invariante viejo se volvería rojo en cuanto cierre
 * el primer mes, y ese rojo no diría nada útil. El riesgo nuevo es otro: que alguien vuelva a LEER
 * una tabla congelada y publique venta vieja como si fuera de hoy. Eso es lo que guarda ahora.
 *
 * ── QUÉ GUARDA ──────────────────────────────────────────────────────────────────────────────
 * Ningún archivo de código (libs, apps, services, database/scripts, database/importers) nombra
 * `product_sales_monthly`, salvo como comentario. Sin base de datos: lee el repo.
 *
 * ⚠️ El bloque 2 es la **prueba negativa**: le pasa al detector un lector inventado y exige el
 * rojo. Sin eso este archivo sería una intención, no una compuerta.
 *
 * ⚠️ DEUDA CON NOMBRE: la etiqueta de este archivo en `database/run-all-tests.js` todavía describe
 * el candado viejo; se corrige cuando ese archivo no tenga cambios de otra sesión a medio commitear.
 * Y la tabla se borra con D2 (anexo CANON.5).
 *
 *   node database/tests/test-newdb-product-sales-parity.js
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');
const DONDE = ['libs', 'apps', 'services', 'database/scripts', 'database/importers'];
const EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.sql']);
const IGNORAR = new Set(['node_modules', 'dist', '.nx', 'coverage']);
const TABLA = /\bproduct_sales_monthly\b/;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

/** Quita comentarios para que mencionar la tabla en una explicación no cuente como leerla. */
function sinComentarios(texto, ext) {
  if (ext === '.sql') return texto.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}

/** El detector: UNA función, la que usan el veredicto real y la prueba negativa. */
function lectores(archivos) {
  return archivos.filter(({ ruta, texto }) => TABLA.test(sinComentarios(texto, path.extname(ruta))))
    .map(({ ruta }) => ruta);
}

function recorrer(dir, acc) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entradas) {
    if (IGNORAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, acc);
    else if (EXT.has(path.extname(e.name)) && !e.name.endsWith('.spec.ts')) acc.push(p);
  }
  return acc;
}

console.log('\n[CANON.5.9] analytics.product_sales_monthly está congelada: nadie la lee\n');

console.log('1 · VEREDICTO');
const archivos = DONDE.flatMap((d) => recorrer(path.join(RAIZ, d), []))
  .map((p) => ({ ruta: path.relative(RAIZ, p).replace(/\\/g, '/'), texto: fs.readFileSync(p, 'utf8') }));
const hallados = lectores(archivos);
ok(archivos.length > 100, `se recorrieron ${archivos.length} archivos de código (un recorrido vacío no prueba nada)`);
ok(hallados.length === 0, hallados.length
  ? `lee una tabla congelada: ${hallados.join(', ')} — derivá de analytics.product_sales_daily`
  : 'ningún archivo de código lee product_sales_monthly');

console.log('\n2 · PRUEBA NEGATIVA');
const falso = [
  { ruta: 'libs/x/lector.ts', texto: 'const q = `SELECT units FROM analytics.product_sales_monthly`;' },
  { ruta: 'libs/x/comentario.ts', texto: '// antes leía analytics.product_sales_monthly\nconst q = 1;' },
];
const neg = lectores(falso);
ok(neg.length === 1 && neg[0] === 'libs/x/lector.ts', 'un lector inventado da ROJO y un comentario no');

console.log(`\n  ${pass} OK · ${fail} falla(s)\n`);
process.exit(fail ? 1 : 0);
