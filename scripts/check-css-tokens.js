#!/usr/bin/env node
/**
 * [UIM.5] — Un `var(--token)` que no resuelve es una declaración que el navegador TIRA.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Este defecto se arregló DOS VECES EN DOS DÍAS y las dos veces había estado vivo meses:
 *
 *   2026-09-27  --text-color-secondary   164 declaraciones de `color` en 25 archivos, 0 con respaldo
 *   2026-09-28  --text-color y 12 más    119 declaraciones en 23 archivos
 *
 * Y la primera vez el diagnóstico YA ESTABA ESCRITO en el repo, en el encabezado de
 * `tienda-cambios-precio.component.ts`, con dos meses de antigüedad: se arregló esa pantalla y
 * nadie contó el resto. Un defecto que reaparece no necesita otro arreglo, necesita una compuerta.
 *
 * ── Qué es lo que rompe, exactamente ─────────────────────────────────────────────────────────
 * Una propiedad personalizada indefinida SIN fallback deja la declaración **inválida al calcular
 * el valor**. Eso NO es "se ve un poco distinto", y no es lo mismo según la propiedad:
 *
 *   · propiedad HEREDADA (`color`)         → cae en `inherit`: el texto atenuado sale idéntico
 *                                            al primario. La jerarquía que el código cree tener
 *                                            no existe, y la pantalla se ve "casi bien" — que es
 *                                            la peor forma de estar rota.
 *   · propiedad NO heredada (`background`) → cae en `initial`: fondo transparente. Un encabezado
 *                                            pegajoso deja leer las filas POR DEBAJO al scrollear.
 *   · `font-weight`                        → una clase llamada `.strong` se pinta en peso normal.
 *   · dentro de `color-mix()`              → la función entera es inválida: el hover no existe.
 *
 * ⛔ Y el build no dice NADA, porque para el navegador no es un error: es una declaración que se
 * descarta. Por eso hace falta medirlo acá.
 *
 * ── Qué mide, y qué NO cuenta como falta ─────────────────────────────────────────────────────
 * Referencias `var(--x)` en las 3 apps contra lo declarado en `libs/design-tokens/tokens.css` y
 * en el `styles.css` de cada app. NO son falta:
 *
 *   · `--p-*`                  el tema de PrimeNG los declara en runtime.
 *   · declarados en el mismo archivo  (`--x: …` en su propio bloque de estilos).
 *   · inyectados por binding   (`[style.--x]="…"` desde el template). ⭐ Este caso salvó a
 *     `--mc-accent` y `--g` de un barrido que los habría "arreglado" rompiéndolos: el grep los
 *     ve ausentes y existen en runtime.
 *
 * ── La línea entre rojo y deuda ──────────────────────────────────────────────────────────────
 * ROJO: token indefinido SIN respaldo → la declaración se cae, hoy, en silencio.
 * DEUDA: token indefinido CON respaldo → pinta, pero con un literal hardcodeado que **no voltea
 * en oscuro** y casi siempre está fuera de paleta (medido: seis rojos distintos para un mismo
 * semántico que la paleta ya tiene). Se cuenta y se imprime; no frena.
 *
 * `--self-test` construye los casos en memoria y verifica que los malos salgan ROJOS. Un gate sin
 * prueba negativa es una intención.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];

function declaradosGlobales() {
  const out = new Set();
  const archivos = [
    'libs/design-tokens/tokens.css',
    'apps/view/src/styles.css',
    'apps/vendor/src/styles.css',
    'apps/portal/src/styles.css',
  ];
  for (const rel of archivos) {
    const p = path.join(RAIZ, rel);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/^\s*(--[a-zA-Z0-9_-]+)\s*:/gm)) out.add(m[1]);
  }
  return out;
}

/**
 * Saca los comentarios antes de medir.
 *
 * ⚠️ Lo encontró la propia compuerta en su primera corrida: marcó en rojo
 * `tienda-cambios-precio.component.ts` por dos `var(--text-color-secondary)` que están **dentro
 * del comentario que DOCUMENTA el bug**. Un gate que no distingue código de prosa obliga a
 * borrar la evidencia para ponerse verde — justo al revés de lo que se quiere.
 *
 * Sólo se quitan bloques `⁠/* … *⁠/` y líneas que arrancan con `//` o `*`: alcanza para el caso y
 * no toca un `https://` en medio de una cadena, que un barrido ingenuo de `//` sí cortaría.
 */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

/**
 * Borra los respaldos INALCANZABLES antes de medir.
 *
 * ⚠️ Tercer defecto que encontró su propia corrida, y el más sutil: el repo encadena respaldos,
 * `var(--surface-card, var(--surface-0))`. Si `--surface-card` EXISTE, el `--surface-0` de adentro
 * no se evalúa nunca — reportarlo son 12 falsos positivos que mandarían a "arreglar" algo que
 * funciona. Y si el de afuera NO existe (`var(--border-soft, var(--c-border))`, con los dos sin
 * declarar), entonces el de adentro sí manda y la declaración SÍ se cae.
 *
 * O sea: lo que importa no es que el nombre aparezca, es si la cadena llega a él.
 */
function podarRespaldosInalcanzables(src, resoluble) {
  let out = src;
  const re = /var\(\s*(--[a-zA-Z0-9_-]+)\s*,/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    if (!resoluble(m[1])) continue; // el de afuera no resuelve: el de adentro sí se evalúa
    // Buscar el paréntesis que cierra ESTE var( y blanquear su respaldo.
    let prof = 1;
    let i = m.index + m[0].length;
    for (; i < out.length && prof > 0; i++) {
      if (out[i] === '(') prof++;
      else if (out[i] === ')') prof--;
    }
    const fin = i - 1;
    out = out.slice(0, m.index + m[0].length) + ' '.repeat(fin - (m.index + m[0].length)) + out.slice(fin);
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

/** Devuelve { sinRespaldo: [{token, prop}], conRespaldo: [token] } de UN archivo. */
function analizar(srcCrudo, globales) {
  const src = sinComentarios(srcCrudo);
  // Lo que el propio archivo define o inyecta no es una falta.
  const locales = new Set([...src.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]));
  const bindings = new Set([...src.matchAll(/\[style\.(--[a-zA-Z0-9_-]+)\]/g)].map((m) => m[1]));
  // ⚠️ Segundo defecto que encontró su propia corrida: un token ARMADO en tiempo de ejecución
  // (`var(--avatar-${i})`, `var(--chart-${serie})`) se lee como el trozo previo al `${` y termina
  // reportado como `--avatar-`. No existe como nombre y no hay forma estática de saber a qué
  // resuelve: lo que sí se sabe es que NO es una falta. Un token que termina en `-` es eso.
  const exento = (t) =>
    t.startsWith('--p-') || t.endsWith('-') || globales.has(t) || locales.has(t) || bindings.has(t);

  // Poda ANTES de contar: un respaldo que la cadena nunca alcanza no es una falta.
  const podado = podarRespaldosInalcanzables(src, exento);

  const sinRespaldo = [];
  const conRespaldo = [];
  // La propiedad que precede sirve para explicar el daño; puede no existir (var dentro de otra var).
  for (const m of podado.matchAll(/(?:([a-zA-Z-]+)\s*:[^;{}]*?)?var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g)) {
    const [, prop, token, coma] = m;
    if (exento(token)) continue;
    if (coma) conRespaldo.push(token);
    else sinRespaldo.push({ token, prop: prop || '?' });
  }
  return { sinRespaldo, conRespaldo };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const G = new Set(['--text-main', '--action']);
  const casos = [
    ['sin respaldo → rojo', 'color: var(--no-existe);', 1, 0],
    ['con respaldo → deuda', 'color: var(--no-existe, #333);', 0, 1],
    ['declarado → limpio', 'color: var(--text-main);', 0, 0],
    ['tema PrimeNG → exento', 'color: var(--p-text-color);', 0, 0],
    ['definido en el archivo → exento', '.a { --mio: red; } .b { color: var(--mio); }', 0, 0],
    ['inyectado por binding → exento', '[style.--g]="c()" ... border-color: var(--g);', 0, 0],
    ['dentro de color-mix → rojo', 'background: color-mix(in srgb, var(--ink) 3%, transparent);', 1, 0],
    // Los dos casos que la compuerta se perdió en su PRIMERA corrida contra el repo real.
    ['dentro de un comentario → exento', '/* color: var(--murio) aca se explicaba el bug */', 0, 0],
    ['token armado en runtime → exento', 'background: var(--avatar-' + '${i});', 0, 0],
    // El tercero, el sutil: si el de AFUERA existe, el de adentro no se evalúa nunca.
    ['respaldo inalcanzable → exento', 'background: var(--text-main, var(--murio));', 0, 0],
    ['respaldo SÍ alcanzable → rojo', 'background: var(--tampoco, var(--murio));', 1, 1],
  ];
  let fallos = 0;
  for (const [nombre, src, esperaRojo, esperaDeuda] of casos) {
    const r = analizar(src, G);
    const ok = r.sinRespaldo.length === esperaRojo && r.conRespaldo.length === esperaDeuda;
    if (!ok) {
      console.error(`  ❌ "${nombre}": esperaba ${esperaRojo} rojo/${esperaDeuda} deuda, dio ${r.sinRespaldo.length}/${r.conRespaldo.length}`);
      fallos++;
    } else {
      console.log(`  ✅ "${nombre}"`);
    }
  }
  if (fallos) {
    console.error(`\n❌ La compuerta no clasifica ${fallos} caso(s) como debe. Arreglala antes de confiar en su verde.\n`);
    process.exit(1);
  }
  console.log(`\n✅ ${casos.length} casos: clasifica rojo, deuda y exento exactamente donde debe.\n`);
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

const globales = declaradosGlobales();
const archivos = [];
for (const app of APPS) recorrer(path.join(RAIZ, app), archivos);

// ── `[CD.2]` LA COMPUERTA CORTA POR LO QUE ESTE CAMBIO ESCRIBIO ────────────────────────────
// Barría las 3 apps enteras, así que un token roto en una pantalla ajena ponía roja la corrida
// de cualquiera. Medido el 2026-10-02: el commit `1d3c504dc` tocó UN archivo y su CI se cayó por
// cinco que no tocó. Mismo ratchet que `lint-changed.js`; la deuda vieja se sigue imprimiendo
// más abajo (PENDIENTE_DISENO), o sea que no se esconde: cambia quién la paga.
// `--todo` fuerza el barrido completo, para auditar el repo a propósito.
const { acotarACambiados, declararAlcance } = require('./lib/alcance-diff');
const _totalTokens = archivos.length;
const _alcanceTokens = acotarACambiados(archivos, {
  raiz: RAIZ,
  activar: process.argv.includes('--todo') ? false : null,
});
archivos.length = 0;
archivos.push(..._alcanceTokens.archivos);
console.log(declararAlcance(_alcanceTokens, _totalTokens));

const rojos = new Map(); // token -> [{rel, prop}]
const deuda = new Map(); // token -> n

for (const f of archivos) {
  const src = fs.readFileSync(f, 'utf8');
  if (!src.includes('var(--')) continue;
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  const { sinRespaldo, conRespaldo } = analizar(src, globales);
  for (const { token, prop } of sinRespaldo) {
    if (!rojos.has(token)) rojos.set(token, []);
    rojos.get(token).push({ rel, prop });
  }
  for (const t of conRespaldo) deuda.set(t, (deuda.get(t) || 0) + 1);
}

/**
 * DEUDA DECLARADA — tokens SIN respaldo que siguen vivos porque su arreglo es una decisión de
 * DISEÑO, no una corrección. Se imprimen con su motivo en cada corrida.
 */
const PENDIENTE_DISENO = new Map([
  ['--fw-semibold',
   'La escala declara regular 400 / medium 500 / bold 700 y OMITE el 600. Hoy los usos (todos ' +
   'énfasis: .strong, <strong>, chips) caen en peso heredado, o sea que una clase llamada .strong ' +
   'se pinta normal. Dos salidas legítimas y opuestas: agregar --fw-semibold: 600 a tokens.css ' +
   '(que 9 sitios independientes lo asuman es evidencia de que la escala lo necesita), o ' +
   'reescribirlos a --fw-bold. La decide quien manda en el sistema de diseño.'],
  ['--fs-md',
   'Misma forma: la escala salta de --fs-body (14px) a --fs-lg (18px) y estos usos asumen un ' +
   'paso intermedio de 16px que no existe.'],
  ['--fs-xl',
   'La escala declara --fs-display (40px) y --fs-lg (18px) y NADA entre medio. Este uso asume ' +
   'un paso ~24px. Misma decisión que --fs-md: se agrega el peldaño o se baja a --fs-lg.'],
  ['--fs-base',
   'Sinónimo de --fs-body (14px) que nunca se declaró. El arreglo parece obvio — apuntarlo a ' +
   '--fs-body — pero conviene resolverlo junto con --fs-md/--fs-xl: son la misma pregunta sobre ' +
   'cuántos peldaños tiene la escala y cómo se llaman.'],
]);

const rojosReales = [...rojos.entries()].filter(([t]) => !PENDIENTE_DISENO.has(t));
const enDiseno = [...rojos.entries()].filter(([t]) => PENDIENTE_DISENO.has(t));

if (rojosReales.length) {
  console.error('\n❌ Tokens SIN respaldo que no existen — la declaración se cae, hoy, en silencio:\n');
  for (const [token, usos] of rojosReales.sort((a, b) => b[1].length - a[1].length)) {
    const props = [...new Set(usos.map((u) => u.prop))].slice(0, 3).join(', ');
    console.error(`   ${token}  ×${usos.length}  (${props})`);
    for (const u of usos.slice(0, 3)) console.error(`      · ${u.rel}`);
    if (usos.length > 3) console.error(`      · … y ${usos.length - 3} más`);
  }
  console.error('\n   Cómo se arregla: apuntá al token REAL de libs/design-tokens/tokens.css.');
  console.error('   ⛔ Ponerle un fallback con un hex NO es el arreglo: pinta en claro y se rompe');
  console.error('      en oscuro, que es como llegamos acá. Si de verdad falta un paso en la');
  console.error('      escala, se agrega a tokens.css — esa es una decisión, no un parche.\n');
  process.exit(1);
}

const disenoTxt = enDiseno.length
  ? '\n⚠️  ' + enDiseno.length + ' token(s) SIN respaldo esperando una DECISIÓN DE DISEÑO:\n' +
    enDiseno.map(([t, u]) => `     · ${t} ×${u.length}\n       ${PENDIENTE_DISENO.get(t)}`).join('\n')
  : '';

const totalDeuda = [...deuda.values()].reduce((a, b) => a + b, 0);
const deudaTxt = totalDeuda
  ? `\n⚠️  ${totalDeuda} referencia(s) a tokens inexistentes PERO con respaldo, en ${deuda.size} tokens. ` +
    'Pintan, así que no frenan — pero su respaldo es un literal que NO voltea en oscuro. ' +
    'Los 5 de mayor volumen:\n' +
    [...deuda.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([t, n]) => `     · ${t} ×${n}`).join('\n')
  : '';

console.log(`✅ ${archivos.length} componente(s): ninguna declaración se cae por un token inexistente.${disenoTxt}${deudaTxt}`);
