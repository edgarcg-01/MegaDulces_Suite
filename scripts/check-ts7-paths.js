#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[NX.7]` Candado de deriva entre `tsconfig.base.json` y `tsconfig.ts7.json`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * `tsconfig.ts7.json` es el config del typecheck rápido (`npm run typecheck:fast`, tsgo / el
 * compilador nativo en Go). NO puede extender `tsconfig.base.json`, y eso está VERIFICADO, no
 * asumido: poniéndole `extends`, tsgo sale 1 con
 *
 *     TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
 *     TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
 *
 * O sea que el mapa de `paths` está duplicado A LA FUERZA, y su única defensa era un comentario
 * que decía "si cambian los paths en tsconfig.base.json, replicarlos acá".
 *
 * Ese comentario no alcanzó. MEDIDO el 2026-09-18: al mapa de ts7 le faltaban los 5 subpaths
 * `@megadulces/contracts/authz/*` y `@megadulces/ui-web`, y le sobraban 3 de
 * `@megadulces/shared-auth` — una lib que NO EXISTE en el repo y que nadie importa. El typecheck
 * estaba rojo con 5 × TS2307 "Cannot find module", que NO son errores de tipos: es el gate
 * fallando por su propia configuración. Un gate que está rojo por deriva enseña a ignorarlo, y
 * un gate que se ignora no es un gate.
 *
 * ── Qué compara ─────────────────────────────────────────────────────────────────────────────
 * Las CLAVES de `compilerOptions.paths` de los dos archivos, en los dos sentidos, y además que
 * el destino apunte al mismo archivo (salvo el `./` que TS 7 exige). Un alias que sobra es tan
 * malo como uno que falta: el de `shared-auth` apuntaba a rutas inexistentes y nadie lo notó.
 *
 * Prueba negativa ejercida el 2026-09-18: borrando una entrada de `tsconfig.ts7.json` sale 1 y
 * la nombra; agregando una que no está en base, también.
 *
 *   node scripts/check-ts7-paths.js
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const BASE = 'tsconfig.base.json';
const TS7 = 'tsconfig.ts7.json';

/**
 * Los dos archivos llevan comentarios (JSONC). Se quitan antes de parsear.
 *
 * ⚠️ EL ORDEN IMPORTA, y lo aprendí rompiéndolo acá mismo: hay que sacar las líneas `//`
 * PRIMERO. Al revés, un comentario de línea que contenga `/*` —por ejemplo al documentar el
 * alias `@megadulces/contracts/authz/[asterisco]`— abre un comentario de bloque falso que se come
 * el archivo hasta el siguiente cierre, y el JSON deja de parsear en una línea que no tiene
 * nada que ver. Salió textual: "Unexpected non-whitespace character after JSON at position 18".
 *
 * El `^\s*` del regex de línea es a propósito: así un `https://...` dentro de un string no se
 * confunde con un comentario.
 */
function leerJsonc(rel) {
  const crudo = fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const limpio = crudo.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try {
    return JSON.parse(limpio);
  } catch (e) {
    console.log(`⛔ ${rel} no parsea como JSON: ${e.message}`);
    process.exit(1);
  }
}

/** Normaliza el destino: TS 7 exige `./` adelante, TS 5 lo escribe sin él. */
const norm = (v) => String(Array.isArray(v) ? v[0] : v).replace(/^\.\//, '');

const pathsBase = (leerJsonc(BASE).compilerOptions || {}).paths || {};
const pathsTs7 = (leerJsonc(TS7).compilerOptions || {}).paths || {};

const clavesBase = Object.keys(pathsBase).sort();
const clavesTs7 = Object.keys(pathsTs7).sort();

console.log('[NX.7] Deriva de `paths` · tsconfig.base.json ↔ tsconfig.ts7.json\n');
console.log(`  alias en ${BASE}: ${clavesBase.length}`);
console.log(`  alias en ${TS7} : ${clavesTs7.length}\n`);

const faltan = clavesBase.filter((k) => !clavesTs7.includes(k));
const sobran = clavesTs7.filter((k) => !clavesBase.includes(k));
const distintos = clavesBase
  .filter((k) => clavesTs7.includes(k))
  .filter((k) => norm(pathsBase[k]) !== norm(pathsTs7[k]))
  .map((k) => ({ k, base: norm(pathsBase[k]), ts7: norm(pathsTs7[k]) }));

if (!faltan.length && !sobran.length && !distintos.length) {
  console.log(`✅ Los ${clavesBase.length} alias coinciden en ambos archivos, clave y destino.`);
  console.log('   `npm run typecheck:fast` resuelve los mismos módulos que el build.');
  process.exit(0);
}

if (faltan.length) {
  console.log(`⛔ FALTAN en ${TS7} (están en ${BASE}):\n`);
  for (const k of faltan) console.log(`     "${k}": ["./${norm(pathsBase[k])}"],`);
  console.log('\n  Sin esto, tsgo no resuelve el import y sale TS2307 "Cannot find module" —');
  console.log('  que se lee como un error del código y no lo es.\n');
}

if (sobran.length) {
  console.log(`⛔ SOBRAN en ${TS7} (no existen en ${BASE}):\n`);
  for (const k of sobran) console.log(`     "${k}"  → ${norm(pathsTs7[k])}`);
  console.log('\n  Un alias de más apunta a una ruta que probablemente ya no existe. Es el caso');
  console.log('  de `@megadulces/shared-auth`, que sobrevivió a la lib que lo justificaba.\n');
}

if (distintos.length) {
  console.log('⛔ MISMO alias, DESTINO distinto:\n');
  for (const d of distintos) {
    console.log(`     "${d.k}"`);
    console.log(`        ${BASE} → ${d.base}`);
    console.log(`        ${TS7}  → ${d.ts7}`);
  }
  console.log('\n  El typecheck estaría comprobando un archivo distinto del que compila el build.\n');
}

console.log(`  Los dos mapas tienen que decir lo mismo. No se puede deduplicar con \`extends\`:`);
console.log('  TS 7 removió `baseUrl` y exige `paths` relativos (TS5102 / TS5090, verificado).');
process.exit(1);
