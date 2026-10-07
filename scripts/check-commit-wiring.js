'use strict';
/**
 * CANDADO — lo que un COMMIT referencia tiene que existir EN ESE COMMIT.
 *
 * ── EL INCIDENTE QUE LO PAGA ─────────────────────────────────────────────────────────────
 * 2026-09-30. Prod congelada **3 horas** (08:25 → 11:25) con el auto-deploy fallando cinco
 * veces seguidas. `apps/api/src/app.module.ts` y `apps/view/src/app/app.routes.ts` estaban
 * commiteados apuntando a archivos que **no estaban commiteados** — vivían sin trackear en el
 * árbol de trabajo que comparten ~10 sesiones:
 *
 *     TS2724: '@megadulces/commercial' has no exported member 'CommercialStandardCostModule'
 *     TS2307: Cannot find module './modules/compras/pages/compras-costo-estandar.component'
 *
 * ⭐ **Por qué nadie lo vio venir, y es la clave de este candado:** compilar en el árbol de
 * trabajo compila el commit **más lo sucio de todas las sesiones**, y ahí esos archivos SÍ
 * existen. Docker compila el commit pelado. Un build local verde **no dice nada** sobre un
 * commit. Por eso este candado no mira el disco: mira el árbol de git.
 *
 * Y volvió a pasar el mismo día: cuatro horas después del arreglo, otra sesión commiteó
 * `app.routes.ts` para agregar su propia ruta, se llevó la versión del árbol de trabajo —que
 * seguía teniendo el cableado vivo— y revirtió el arreglo sin enterarse. No es descuido de
 * nadie: es que `git commit -- <archivo>` toma lo que hay en el disco, no lo que vos editaste.
 *
 * ── QUÉ COMPRUEBA ────────────────────────────────────────────────────────────────────────
 *  1. **Imports relativos**: todo `from './x'` y `import('./x')` en un archivo del commit
 *     resuelve a un archivo que también está en el commit.
 *  2. **Símbolos de los barriles del workspace**: `import { X } from '@megadulces/<lib>'` exige
 *     que `X` aparezca exportado en la cadena `export * from './lib/...'` de ese barril, con
 *     los archivos tal como están EN EL COMMIT. Es el caso que rompió `app.module.ts`, y un
 *     chequeo por archivos no lo agarra: el barril existía, le faltaba la línea.
 *
 * ⛔ No intenta ser un type-checker. Busca UNA clase de error —referenciar lo que no viajó en
 * el commit— y es la que costó 3 horas de prod.
 *
 * ── USO ──────────────────────────────────────────────────────────────────────────────────
 *   node scripts/check-commit-wiring.js                # HEAD
 *   node scripts/check-commit-wiring.js --ref origin/main
 *   node scripts/check-commit-wiring.js --staged       # lo que estás por commitear
 *   node scripts/check-commit-wiring.js --self-test    # la prueba negativa
 *
 * Salidas: 0 = todo lo referenciado viaja · 1 = falta algo · 2 = NO MEDIDO.
 */
const path = require('path');
const { execSync } = require('child_process');

/** Dónde vive el barril de cada alias del workspace. Si aparece un alias nuevo, va acá. */
const BARRILES = {
  '@megadulces/commercial': 'libs/commercial/src/index.ts',
  '@megadulces/contracts': 'libs/contracts/src/index.ts',
  '@megadulces/finance': 'libs/finance/src/index.ts',
  '@megadulces/trade': 'libs/trade/src/index.ts',
  '@megadulces/platform-core': 'libs/platform-core/src/index.ts',
  '@megadulces/logistics': 'libs/logistics/src/index.ts',
  '@megadulces/reconciliation': 'libs/reconciliation/src/index.ts',
  '@megadulces/service-desk': 'libs/service-desk/src/index.ts',
};

/** Extensiones que TypeScript prueba cuando un import no las trae. */
const EXTS = ['.ts', '.tsx', '.d.ts', '/index.ts', '.js', '/index.js'];

/** `from '...'` y `import('...')`, que es como se piden las rutas perezosas de Angular. */
const RE_IMPORT = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
/** Los nombres de un `import { A, B as C } from '...'`. */
const RE_NAMED = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
/** `export * from './x'` dentro de un barril. */
const RE_STAR = /export\s+\*\s+from\s*['"](\.[^'"]+)['"]/g;
/**
 * Declaraciones exportadas por nombre.
 *
 * ⚠️ Los modificadores van TODOS, y en cualquier orden. La primera versión no admitía `async`
 * entre `export` y `function`, y por eso daba 16 falsos positivos contra `af6a88d0`: el barril
 * sí exportaba `login-core`, y ahí dice `export async function autenticarYFirmar(`. Un candado
 * con falsos positivos se apaga, y entonces no sirve el día que tiene razón.
 */
const RE_EXPORTA = /export\s+(?:(?:declare|abstract|async|default)\s+)*(?:class|interface|enum|type|const|let|var|function\s*\*?)\s+([A-Za-z0-9_$]+)/g;
/**
 * `export { A, B as C }` y `export type { A } from '...'`.
 *
 * ⚠️ El `type` no es opcional de adorno: sin admitirlo, `export type { Freshness } from
 * '@megadulces/contracts'` no se veía y el candado acusaba a `store.service.ts` de importar algo
 * que sí existe. Segundo falso positivo de la misma familia — la sintaxis de export tiene más
 * formas de las que uno recuerda al escribir la expresión.
 */
const RE_EXPORT_LLAVE = /export\s+(?:type\s+)?\{([^}]*)\}/g;

/**
 * Quita comentarios **respetando los strings**. Un comentario no cablea nada, pero un `/*` dentro
 * de una cadena sí es código.
 *
 * ⛔ La primera versión era `src.replace(/\/\*[\s\S]*?\*\//g, '')`. Medido contra
 * `af6a88d0:app.routes.ts`: **1,945 líneas → 915**. Se comió más de la mitad del archivo porque
 * había 8 aperturas `/*` y 3 cierres antes de la línea que importaba, todas dentro de cadenas. El
 * candado no daba un falso positivo: **sub-reportaba en silencio**, que es peor — se perdía la
 * ruta de `tienda-retiros`, una de las cuatro referencias rotas que tenía que encontrar.
 *
 * Los literales de expresión regular no necesitan trato aparte: una regex no puede empezar con
 * `*` (`/*` sería sintaxis inválida), así que fuera de una cadena `/*` siempre abre comentario.
 */
function sinComentarios(src) {
  let out = '';
  let i = 0;
  let cita = null;                                 // ' " ` cuando estamos dentro de una cadena
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (cita) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }   // escape: el siguiente va tal cual
      if (c === cita) cita = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { cita = c; out += c; i++; continue; }
    if (c === '/' && d === '*') {
      const fin = src.indexOf('*/', i + 2);
      const salto = fin === -1 ? src.length : fin + 2;
      for (let k = i; k < salto; k++) if (src[k] === '\n') out += '\n';  // conserva los renglones
      i = salto;
      continue;
    }
    if (c === '/' && d === '/') {
      const fin = src.indexOf('\n', i);
      i = fin === -1 ? src.length : fin;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Lector del árbol de git: NUNCA del disco. Ahí está la gracia. */
function lector(ref) {
  const cache = new Map();
  const archivos = new Set(
    execSync(`git ls-tree -r --name-only ${ref}`, { encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\n').map((l) => l.trim()).filter(Boolean),
  );
  const leer = (p) => {
    if (cache.has(p)) return cache.get(p);
    let s = null;
    if (archivos.has(p)) {
      try {
        s = execSync(`git show ${ref}:${p}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
      } catch { s = null; }
    }
    cache.set(p, s);
    return s;
  };
  return { archivos, leer };
}

/** Resuelve un import relativo a la ruta del repo, probando las extensiones de TS. */
function resolver(desde, rel, archivos) {
  const base = path.posix.join(path.posix.dirname(desde), rel);
  if (archivos.has(base)) return base;
  for (const e of EXTS) if (archivos.has(base + e)) return base + e;
  return null;
}

/**
 * Todo lo que un barril exporta, siguiendo sus `export *` **en cadena**.
 *
 * ⛔ La primera versión seguía UN nivel y daba 16 falsos positivos contra `af6a88d0`
 * (`autenticarYFirmar`, `Freshness`, `laneAt`…): `platform-core` reexporta a través de barriles
 * anidados, así que el nombre aparecía dos saltos más abajo. Una compuerta que grita en falso se
 * aprende a ignorar, y entonces no sirve el día que tiene razón — que era justo este archivo.
 */
function exportaDelBarril(barril, { archivos, leer }) {
  const nombres = new Set();
  const src = leer(barril);
  if (src == null) return { nombres, existe: false };

  const recoger = (texto) => {
    for (const m of texto.matchAll(RE_EXPORTA)) nombres.add(m[1]);
    for (const m of texto.matchAll(RE_EXPORT_LLAVE)) {
      for (const parte of m[1].split(',')) {
        const t = parte.trim();
        if (!t) continue;
        const como = t.split(/\s+as\s+/);
        nombres.add((como[1] || como[0]).trim());
      }
    }
  };

  const vistos = new Set();
  const pendientes = [barril];
  while (pendientes.length) {
    const actual = pendientes.pop();
    if (vistos.has(actual)) continue;             // los barriles se citan en círculo; sin esto cuelga
    vistos.add(actual);
    const s = leer(actual);
    if (s == null) continue;
    const limpio = sinComentarios(s);
    recoger(limpio);
    for (const m of limpio.matchAll(RE_STAR)) {
      const destino = resolver(actual, m[1], archivos);
      if (destino) pendientes.push(destino);      // un destino ausente lo reporta el chequeo (1)
    }
  }
  return { nombres, existe: true };
}

/**
 * El núcleo, separable para el self-test.
 * @returns {{tipo:string, archivo:string, ref:string, detalle:string}[]}
 */
function analizar(ref, { archivos, leer }) {
  const fallas = [];
  const fuentes = [...archivos].filter(
    (f) => /\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f) && !f.startsWith('_imported/'),
  );
  const cacheBarril = new Map();

  for (const f of fuentes) {
    const bruto = leer(f);
    if (bruto == null) continue;
    const src = sinComentarios(bruto);

    // (1) Imports relativos → el destino tiene que viajar en el mismo commit.
    for (const m of src.matchAll(RE_IMPORT)) {
      const esp = m[1];
      if (!esp.startsWith('.')) continue;
      if (/\.(css|scss|html|json|svg|png|jpe?g)$/.test(esp)) continue;
      if (!resolver(f, esp, archivos)) {
        fallas.push({ tipo: 'archivo', archivo: f, ref: esp, detalle: 'no existe en el commit' });
      }
    }

    // (2) Símbolos pedidos a un barril del workspace.
    for (const m of src.matchAll(RE_NAMED)) {
      const barril = BARRILES[m[2]];
      if (!barril) continue;
      if (!cacheBarril.has(barril)) cacheBarril.set(barril, exportaDelBarril(barril, { archivos, leer }));
      const { nombres, existe } = cacheBarril.get(barril);
      if (!existe) continue;
      for (const parte of m[1].split(',')) {
        const t = parte.trim();
        if (!t) continue;
        const nom = t.split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
        if (!nom || nombres.has(nom)) continue;
        fallas.push({
          tipo: 'simbolo', archivo: f, ref: `${nom} de '${m[2]}'`,
          detalle: `el barril ${barril} no lo exporta en este commit`,
        });
      }
    }
  }
  return fallas;
}

// ── La prueba negativa. Un gate sin ella es una intención. ────────────────────────────────
if (process.argv.includes('--self-test')) {
  let fallas = 0;
  const ck = (l, c) => { if (c) console.log(`  ✔ ${l}`); else { fallas++; console.log(`  ✖ ${l}`); } };
  const falso = (mapa) => ({
    archivos: new Set(Object.keys(mapa)),
    leer: (p) => (p in mapa ? mapa[p] : null),
  });
  console.log('\n=== self-test de check-commit-wiring ===\n');

  // 1. ⭐ El incidente: una ruta perezosa a un componente que no viajó.
  const r1 = analizar('X', falso({
    'apps/view/src/app/app.routes.ts':
      "const r = [{ loadComponent: () => import('./modules/compras/pages/x.component') }];",
  }));
  ck('un import() a un archivo que no está en el commit sale ROJO',
    r1.length === 1 && r1[0].tipo === 'archivo');

  // 2. ⭐ El otro incidente: el barril existe pero le falta la línea del export.
  const r2 = analizar('X', falso({
    'apps/api/src/app.module.ts': "import { CommercialStandardCostModule } from '@megadulces/commercial';",
    'libs/commercial/src/index.ts': "export * from './lib/otro/otro.module';",
    'libs/commercial/src/lib/otro/otro.module.ts': 'export class OtroModule {}',
  }));
  ck('un símbolo que el barril NO exporta sale ROJO',
    r2.length === 1 && r2[0].tipo === 'simbolo');

  // 3. Con la línea del barril puesta, verde. (Si esto no pasara, el candado sería inútil:
  //    gritaría siempre y se aprendería a ignorarlo.)
  ck('con el export puesto, VERDE',
    analizar('X', falso({
      'apps/api/src/app.module.ts': "import { CommercialStandardCostModule } from '@megadulces/commercial';",
      'libs/commercial/src/index.ts': "export * from './lib/sc/sc.module';",
      'libs/commercial/src/lib/sc/sc.module.ts': 'export class CommercialStandardCostModule {}',
    })).length === 0);

  // 4. ⭐ Lo que DESCABLEAR significa: comentado no cablea. Era el estado de main entre las
  //    11:25 y este commit, y tenía que salir verde o el candado habría dado rojo todo el día.
  ck('un import COMENTADO no se cuenta',
    analizar('X', falso({
      'apps/api/src/app.module.ts': "// import { NoExiste } from '@megadulces/commercial';\n/* import('./x') */",
      'libs/commercial/src/index.ts': '',
    })).length === 0);

  // 5. Un paquete de node_modules no es asunto de este candado.
  ck('un import de paquete externo se ignora',
    analizar('X', falso({ 'a.ts': "import { Injectable } from '@nestjs/common';" })).length === 0);

  // 6. Resolución por índice de carpeta, que es como se importan varios módulos acá.
  ck('resuelve ./carpeta como ./carpeta/index.ts',
    analizar('X', falso({ 'a.ts': "import { B } from './b';", 'b/index.ts': 'export const B = 1;' })).length === 0);

  // 7. ⭐ REGRESIÓN. Un `/*` dentro de una CADENA no abre comentario. La primera versión de
  //    `sinComentarios` usaba un replace y se comía el resto del archivo: medido contra
  //    `af6a88d0:app.routes.ts`, 1,945 líneas → 915, y se perdía una de las 4 referencias rotas.
  //    Sub-reportar en silencio es peor que un falso positivo: el candado sale verde y miente.
  ck('un /* dentro de una cadena NO se come el resto del archivo',
    analizar('X', falso({
      'a.ts': "const glob = '/*.json';\nconst otro = '*/';\nimport('./falta');",
    })).length === 1);

  ck('un comentario de bloque de verdad sí se ignora',
    analizar('X', falso({ 'a.ts': "/* import('./falta'); */\nexport const A = 1;" })).length === 0);

  console.log(fallas ? `\n  ${fallas} falla(s)\n` : '\n  self-test OK\n');
  process.exit(fallas ? 1 : 0);
}

(() => {
  const i = process.argv.indexOf('--ref');
  const staged = process.argv.includes('--staged');
  let ref = i >= 0 ? process.argv[i + 1] : 'HEAD';

  if (staged) {
    // Lo que se está por commitear, sin tocar el índice compartido: se escribe un árbol y se
    // lee de ahí. Es la forma de preguntar "¿qué va a viajar?" antes de que viaje.
    try {
      ref = execSync('git write-tree', { encoding: 'utf8' }).trim();
    } catch (e) {
      console.error(`⛔ NO MEDIDO: no se pudo escribir el árbol del índice (${e.message.split('\n')[0]}).`);
      process.exit(2);
    }
  }

  let lec;
  try {
    lec = lector(ref);
  } catch (e) {
    console.error(`⛔ NO MEDIDO: no se pudo leer el árbol "${ref}" (${e.message.split('\n')[0]}).`);
    process.exit(2);
  }

  const fallas = analizar(ref, lec);
  if (!fallas.length) {
    console.log(`✓ ${lec.archivos.size} archivos en "${staged ? 'índice' : ref}" · todo lo referenciado viaja en el commit.`);
    process.exit(0);
  }

  const porArchivo = new Map();
  for (const f of fallas) {
    if (!porArchivo.has(f.archivo)) porArchivo.set(f.archivo, []);
    porArchivo.get(f.archivo).push(f);
  }
  console.error(`\n⛔ ${fallas.length} referencia(s) a algo que NO viaja en el commit:\n`);
  for (const [arch, lista] of porArchivo) {
    console.error(`   ${arch}`);
    for (const x of lista) console.error(`      ✗ ${x.ref} — ${x.detalle}`);
  }
  console.error('\n   Esto compila en tu árbol de trabajo (donde los archivos SÍ existen) y revienta');
  console.error('   en el build de prod, que compila el commit pelado. Ya costó 3 horas de prod');
  console.error('   congelada el 2026-09-30.');
  console.error('\n   Arreglo: commiteá los archivos que faltan EN ESTE MISMO commit. Si todavía no');
  console.error('   están listos, sacá el cableado del commit — no al revés.\n');
  process.exit(1);
})();
