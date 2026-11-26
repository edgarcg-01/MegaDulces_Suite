#!/usr/bin/env node
/**
 * Compuerta: un archivo VERSIONADO que importa una ruta relativa que NO ESTÁ VERSIONADA
 * compila en todas las laptops y revienta en el CI.
 *
 * ── Lo que costó, medido el 2026-11-26 ────────────────────────────────────────────────────────
 *
 * El checkout es compartido por ~8 sesiones y casi siempre tiene trabajo sin versionar encima.
 * `tsc`, `nx` y el editor resuelven contra el DISCO, así que un `import './pieza'` donde `pieza`
 * existe sólo como archivo sin versionar **compila en todas las sesiones**. El CI construye
 * desde el COMMIT, donde esa pieza no está, y falla con `Could not resolve` + `TS2307` + `NG1010`.
 *
 * El tracker ya lo tenía escrito en `[UB.RF.20]`: *«Dos `main` rotas antes de llegar, las dos por
 * incluir trabajo de `[UB.RF.15]` que vive sin versionar en el checkout compartido»*. El
 * 2026-11-26 fue la **tercera**, al empujar 74 commits: `ubicaciones-captura.component.ts`
 * importaba `./ubicaciones-captura-rack.component`, que nunca se commiteó.
 *
 * ⭐ Lo caro no es el error, es **dónde** se descubría: en `Imágenes (GHCR)`, el paso más lento y
 * más tarde del carril, después del push y del pre-push. Esta compuerta lo mueve al pre-push.
 *
 * ── Por qué resuelve contra GIT y no contra el disco ──────────────────────────────────────────
 *
 * Es LA decisión de diseño. Si mirara el disco, el archivo sin versionar haría pasar la compuerta
 * en verde — que es exactamente cómo se escapó. El universo es `git ls-files`: lo que está
 * versionado o preparado, o sea lo que el CI va a ver.
 *
 * Alcance medido el 2026-11-26: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`. Los `.js` entran porque los
 * guiones de `ops/prod/ensayo-*` se empaquetan con esbuild FUERA de Nx y resuelven a `libs/` por
 * ruta relativa: ah� una pieza sin versionar funciona en la laptop y el CI ni se entera, porque Nx
 * no los compila. Comprobado: `origin/main` queda en CERO con esa extensi�n (11 imports m�s).
 *
 * ⚠️ Lo que NO afirma: no resuelve alias de `tsconfig` (`@megadulces/*`) ni paquetes de
 * `node_modules` — sólo rutas relativas (`./` y `../`), que son las que el árbol compartido
 * rompe. Tampoco mira `templateUrl`/`styleUrls`.
 *
 * ── Prueba negativa ───────────────────────────────────────────────────────────────────────────
 *
 * `node scripts/check-import-colgado.js --self-test` arma los casos en memoria (los que deben
 * marcar y los que no, incluido el selector CSS que un regex ingenuo confunde con un import).
 * Un gate sin prueba negativa es una intención.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** SOLO `import … from './x'` / `export … from './x'`. Un `querySelector('.fp-row')` NO es esto. */
const RE = /^[^\S\n]*(?:import|export)\b[^\n;]*?\sfrom\s*['"](\.[^'"]*)['"]/gm;
/** Y el `import './efecto';` suelto, sin `from`. */
const RE_SUELTO = /^[^\S\n]*import\s*['"](\.[^'"]*)['"]/gm;

const EXT = ['', '.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.js'];

/** Normaliza `a/b/../c` → `a/c` sin tocar el disco. */
function resolver(dir, rel) {
  const pila = [];
  for (const x of (dir ? dir + '/' + rel : rel).split('/')) {
    if (x === '.' || x === '') continue;
    else if (x === '..') pila.pop();
    else pila.push(x);
  }
  return pila.join('/');
}

/** Las rutas relativas que `src` importa. */
function importados(src) {
  const out = [];
  for (const re of [RE, RE_SUELTO]) { re.lastIndex = 0; for (const m of src.matchAll(re)) out.push(m[1]); }
  return out;
}

/** Los imports de `archivo` que no caen en ningún archivo de `universo`. */
function colgados(archivo, src, universo) {
  const dir = archivo.split('/').slice(0, -1).join('/');
  return importados(src).filter((rel) => {
    const base = resolver(dir, rel);
    return !EXT.some((e) => universo.has(base + e));
  });
}

if (process.argv.includes('--self-test')) {
  const universo = new Set(['a/pieza.ts', 'a/carpeta/index.ts', 'a/dato.json', 'a/v/comp.component.ts']);
  const casos = [
    ['a/x.ts', "import { P } from './pieza';", 0, 'pieza versionada'],
    ['a/x.ts', "import { P } from './fantasma';", 1, 'LA DE VERDAD: pieza sin versionar'],
    ['a/x.ts', "import { C } from './carpeta';", 0, 'carpeta con index.ts'],
    ['a/x.ts', "import d from './dato.json';", 0, 'json versionado'],
    ['a/v/x.ts', "import { C } from '../pieza';", 0, 'sube un nivel y existe'],
    ['a/v/x.ts', "import { C } from '../nada';", 1, 'sube un nivel y NO existe'],
    ['a/x.ts', "export { P } from './pieza';", 0, 're-export que existe'],
    ['a/x.ts', "export { P } from './fantasma';", 1, 're-export colgado'],
    ['a/x.ts', "import './efecto';", 1, 'import suelto colgado'],
    ['a/x.ts', "const e = document.querySelector('.fp-row');", 0, 'SELECTOR CSS, no es un import'],
    ['a/x.ts', "// se movio desde './viejo'\nimport { P } from './pieza';", 0, 'ruta citada en un comentario'],
    ['a/x.ts', "import { P } from '@megadulces/contracts';", 0, 'alias: fuera de alcance, no se marca'],
    ['a/x.ts', "import { P } from 'rxjs';", 0, 'paquete: fuera de alcance'],
  ];
  let malos = 0;
  for (const [f, src, esperado, que] of casos) {
    const dio = colgados(f, src, universo).length;
    if (dio !== esperado) { malos++; console.log(`   ✗ ${que}: esperaba ${esperado}, dio ${dio}`); }
  }
  if (malos) { console.log(`\n[X] self-test: ${malos} caso(s) mal.`); process.exit(1); }
  console.log(`OK self-test: ${casos.length} casos (4 que marcan, 9 que no — incluidos el selector CSS y el comentario).`);
  process.exit(0);
}

const g = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/**
 * P El universo y el CONTENIDO salen del �NDICE, no del disco.
 *
 * Medido el 2026-11-26, el mismo d�a que esta compuerta naci�: leyendo el disco marcaba 8
 * archivos que estaban modificados S�LO en el �rbol de trabajo (` M`, sin preparar) de otras
 * sesiones, y como `gate-push.js` culpa por NOMBRE de archivo, cualquier push amplio cargaba
 * con suciedad que no llevaba adentro: fren� nueve refrescos de PR seguidos.
 *
 * Y el l�mite del �ndice no afloja nada: el defecto que tir� `main` ese d�a entr� por un
 * COMMIT, no por el disco. Lo que se empuja es el �ndice; lo que alguien tiene a medias en su
 * editor no es asunto de esta compuerta.
 */
const versionados = g(['ls-files']).split('\n').filter(Boolean);
const universo = new Set(versionados);
const hallazgos = [];

// Un solo proceso para todo el �ndice: `git grep --cached` en vez de 4,400 lecturas.
let lineas = [];
try {
  lineas = g(['grep', '--cached', '-n', '-E', "^[[:space:]]*(import|export)[^;]*['\"]\\.", '--',
    '*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs']).split('\n').filter(Boolean);
} catch (e) { if (e.status !== 1) throw e; } // 1 = sin coincidencias

for (const l of lineas) {
  const m = l.match(/^([^:]+):\d+:(.*)$/);
  if (!m) continue;
  const [, f, txt] = m;
  if (/node_modules/.test(f)) continue;
  for (const rel of colgados(f, txt, universo)) hallazgos.push([f, rel]);
}

if (hallazgos.length) {
  console.log('\n[X] Archivos VERSIONADOS que importan algo que NO está versionado:\n');
  for (const [f, rel] of hallazgos) console.log(`   ${f}\n        -> ${rel}`);
  console.log('\n   Esto COMPILA en tu máquina (tsc resuelve contra el disco) y revienta en el CI,');
  console.log('   que construye desde el commit. Dos salidas, las dos legítimas:');
  console.log('     1. versioná la pieza que falta, o');
  console.log('     2. sacá la referencia — publicar la mitad de un trabajo es lo que rompe main.');
  console.log('   ⛔ Lo que NO es salida: --no-verify. Ya tiró main tres veces (ver [UB.RF.20]).\n');
  process.exit(1);
}
console.log(`OK imports: ${universo.size} archivos versionados, ninguna ruta relativa colgada.`);
