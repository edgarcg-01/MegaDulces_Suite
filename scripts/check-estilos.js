#!/usr/bin/env node
/**
 * [DS.3] — Las cuatro reglas de CSS que `DESIGN.md` marca BINDING y nadie medía.
 *
 * ── Por qué NO es stylelint ──────────────────────────────────────────────────────────────────
 * La auditoría del 2026-10-02 propuso stylelint. Al ir a instalarlo, la medición lo descartó:
 *
 *     font-size en archivos .css        608          hex crudo en .css   69
 *     font-size dentro de `styles:`   5,023 (89%)    hex en .ts       1,304 (95%)
 *     componentes con styles: inline    337          .component.css      28
 *
 * **El CSS de este repo no vive en archivos CSS.** Vive dentro de template literals en el
 * decorador `@Component`, que no es styled-components ni lit — así que ni `postcss-lit` lo toma
 * limpio. Stylelint de fábrica vería ~1 de cada 10 defectos, y cobraría una dependencia nueva
 * (más su sintaxis custom) por esa décima parte. Con la decisión de PrimeNG abierta, crecer la
 * superficie de dependencia por un 11% de cobertura es el peor de los dos negocios.
 *
 * Lo que sí hay: `check-template-literals.js` **ya extrae esos bloques** con el compilador de
 * TypeScript + esbuild, el mismo parser del build. Esta compuerta reusa ese camino y llega al
 * 100% del CSS. Cero dependencias nuevas.
 *
 * ── Las cuatro reglas, y por qué estas cuatro ────────────────────────────────────────────────
 *   1. `font-size` con literal en vez de `var(--fs-*)`  → la escala está declarada ESTRICTA en
 *      `tokens.css` y es la regla binding **con peor cumplimiento del sistema**: 120 tamaños
 *      distintos en `apps/view`, y los 9 más usados están TODOS fuera de la escala. ⭐ No falta
 *      un peldaño: ninguno de los 9 está a más de 0.5px de un token que ya existe.
 *   2. **hex crudo** en una declaración de color → pre-vuelo 2 y 12b. Un `#dcfce7` se ve bien en
 *      claro y **roto en oscuro**, y el build no dice nada.
 *   3. **breakpoint en `px`** → §R los pide en `rem` o revientan con el zoom al 200%.
 *   4. `outline: none` **sin un `:focus-visible` hermano** → pre-vuelo 6 dice "jamás
 *      `outline:none` a secas". Sin anillo no hay teclado, y D.7 es media sección del doc.
 *
 * ── Cómo frena (ratchet, no muro) ────────────────────────────────────────────────────────────
 * Cada regla arranca con la deuda de hoy congelada. **Frena cuando CRECE**, no por existir: con
 * 2,591 literales de `font-size` vivos, una compuerta absoluta estaría roja para siempre y en la
 * primera corrida enseñaría a ignorarla — que es exactamente cómo se perdió `check-keyboard-nav`
 * el día que marcó 7 falsos de 8. La deuda baja cuando alguien la baja; el tope se actualiza en
 * el mismo commit, y bajarlo es la única forma de moverlo.
 *
 * Uso: `node scripts/check-estilos.js` · prueba negativa: `--self-test` · detalle: `--lista`
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs'];

/**
 * Topes medidos por ESTA compuerta el 2026-10-03, sobre `apps/` + `libs/`.
 * ⚠️ No son los números de la tabla de cumplimiento de `DESIGN.md`: aquélla medía con otro
 * `grep` y otro universo. **Una medición con otro método es otra medición** — manda la de acá,
 * porque es la única que se puede volver a correr.
 */
const TOPE = {
  fontSize:   3161,  // font-size con literal (debería ser var(--fs-*))
  hex:        1449,  // hex crudo en declaración de color
  breakpoint:  205,  // @media (min|max-width: Npx)
  outline:      27,  // outline:none sin :focus-visible hermano en el mismo bloque
};

/** La escala real, leída de tokens.css — no copiada a mano, que es como se desincronizan. */
function escalaReal() {
  const src = fs.readFileSync(path.join(ROOT, 'libs/design-tokens/tokens.css'), 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/--fs-([a-z0-9]+):\s*([0-9.]+)rem/g)) {
    out.set('--fs-' + m[1], parseFloat(m[2]) * 16);
  }
  return out;
}

/** Archivos donde un hex crudo es legítimo: son los que DEFINEN la paleta. */
const HEX_EXENTO = /libs[/\\]design-tokens[/\\]tokens\.css$|operations-preset\.ts$/;

/** Blanco y negro puros: `DESIGN.md` 12b los permite si son correctos en los dos temas. */
const HEX_NEUTRO = /^#(fff|ffffff|000|000000)$/i;

function sinComentarios(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// ── Las cuatro reglas, sobre un bloque de CSS ya extraído ───────────────────────────────────
function analizar(css, rel, escala) {
  const limpio = sinComentarios(css);
  const h = { fontSize: [], hex: [], breakpoint: [], outline: [] };

  // 1 — font-size con literal
  for (const m of limpio.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
    const v = m[1].trim();
    if (/var\(\s*--fs-/.test(v)) continue;
    if (/^(inherit|initial|unset|revert|smaller|larger|medium|0)$/.test(v)) continue;
    if (/^1em$|^100%$/.test(v)) continue; // SVG/heredado: no elige tamaño, lo propaga
    const px = /^([0-9.]+)rem/.test(v) ? parseFloat(v) * 16
             : /^([0-9.]+)px/.test(v) ? parseFloat(v) : null;
    let cerca = null;
    if (px != null) {
      for (const [tok, tpx] of escala) {
        if (cerca == null || Math.abs(tpx - px) < Math.abs(cerca[1] - px)) cerca = [tok, tpx];
      }
    }
    h.fontSize.push({ rel, valor: v, px, cerca });
  }

  // 2 — hex crudo en una declaración de color
  if (!HEX_EXENTO.test(rel)) {
    for (const m of limpio.matchAll(
      /(^|[;{\s])(color|background|background-color|border-color|border|outline-color|fill|stroke|box-shadow|text-shadow)\s*:\s*([^;}]+)/gi)) {
      for (const hx of m[3].matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        if (HEX_NEUTRO.test(hx[0])) continue;
        h.hex.push({ rel, prop: m[2].toLowerCase(), hex: hx[0] });
      }
    }
  }

  // 3 — breakpoint en px
  for (const m of limpio.matchAll(/@media[^{]*\((?:min|max)-width\s*:\s*([0-9.]+)px/g)) {
    h.breakpoint.push({ rel, px: m[1] });
  }

  // 4 — outline:none sin :focus-visible hermano EN EL MISMO BLOQUE
  const apagados = [...limpio.matchAll(/outline\s*:\s*(none|0)\b/g)];
  if (apagados.length && !/:focus-visible/.test(limpio)) {
    for (const m of apagados) {
      // El selector del bloque, para que el mensaje diga QUÉ control se quedó sin anillo.
      const abre = limpio.lastIndexOf('{', m.index);
      const desde = Math.max(limpio.lastIndexOf('}', abre), limpio.lastIndexOf(';', abre)) + 1;
      const sel = limpio.slice(desde, abre).trim().replace(/\s+/g, ' ').slice(-60);
      h.outline.push({ rel, sel });
    }
  }

  return h;
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const E = new Map([['--fs-xs', 12], ['--fs-sm', 13], ['--fs-body', 14]]);
  const casos = [
    ['literal rem → rojo',          '.a{font-size:.8rem}',                     'fontSize', 1],
    ['token → limpio',              '.a{font-size:var(--fs-sm)}',              'fontSize', 0],
    ['inherit → exento',            '.a{font-size:inherit}',                   'fontSize', 0],
    ['1em de SVG → exento',         '.a{font-size:1em}',                       'fontSize', 0],
    ['literal px → rojo',           '.a{font-size:13px}',                      'fontSize', 1],
    ['hex en color → rojo',         '.a{color:#b42318}',                       'hex',      1],
    ['hex en background → rojo',    '.a{background:#dcfce7}',                  'hex',      1],
    ['blanco puro → exento (12b)',  '.a{color:#fff}',                          'hex',      0],
    ['token de color → limpio',     '.a{color:var(--bad-fg)}',                 'hex',      0],
    ['hex en comentario → exento',  '/* antes era color:#b42318 */ .a{color:var(--x)}', 'hex', 0],
    ['breakpoint px → rojo',        '@media (max-width:640px){.a{color:red}}', 'breakpoint', 1],
    ['breakpoint rem → limpio',     '@media (max-width:40rem){.a{color:red}}', 'breakpoint', 0],
    ['pointer coarse → exento',     '@media (pointer:coarse){.a{color:red}}',  'breakpoint', 0],
    ['outline:none solo → rojo',    '.a:focus{outline:none}',                  'outline',  1],
    ['outline:none + ring → limpio','.a:focus{outline:none}.a:focus-visible{outline:2px solid}', 'outline', 0],
  ];
  let fallos = 0;
  for (const [nombre, css, regla, esperado] of casos) {
    const n = analizar(css, 'x.css', E)[regla].length;
    if (n === esperado) console.log('  ✅ "' + nombre + '"');
    else { console.error('  ❌ "' + nombre + '": esperaba ' + esperado + ' en ' + regla + ', dio ' + n); fallos++; }
  }
  if (fallos) {
    console.error('\n❌ La compuerta no clasifica ' + fallos + ' caso(s) como debe. Arreglala antes de confiar en su verde.\n');
    process.exit(1);
  }
  console.log('\n✅ ' + casos.length + ' casos: las 4 reglas marcan y eximen exactamente donde deben.\n');
  process.exit(0);
}

// ── Barrido ────────────────────────────────────────────────────────────────────────────────
function walk(dir, out) {
  let e;
  try { e = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const x of e) {
    const full = path.join(dir, x.name);
    if (x.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.nx', 'coverage'].includes(x.name)) continue;
      walk(full, out);
    } else if (x.name.endsWith('.css') || x.name.endsWith('.ts')) {
      if (!x.name.endsWith('.spec.ts')) out.push(full);
    }
  }
  return out;
}

/** Saca los `styles:` de un @Component. Un literal con `${}` no se puede leer: se CUENTA. */
function bloquesDeComponente(src, noMedido) {
  const sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true);
  const out = [];
  const visitar = (node) => {
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const fn = node.expression.expression;
      if (ts.isIdentifier(fn) && fn.text === 'Component') {
        const arg = node.expression.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            if (prop.name.text !== 'styles') continue;
            const objetivos = ts.isArrayLiteralExpression(prop.initializer)
              ? prop.initializer.elements : [prop.initializer];
            for (const t of objetivos) {
              if (ts.isNoSubstitutionTemplateLiteral(t)) out.push(t.text);
              else if (ts.isTemplateExpression(t)) noMedido.push(1);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitar);
  };
  visitar(sf);
  return out;
}

const escala = escalaReal();
const archivos = DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
const total = { fontSize: [], hex: [], breakpoint: [], outline: [] };
const noMedido = [];

for (const abs of archivos) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  const bloques = abs.endsWith('.css') ? [src] : bloquesDeComponente(src, noMedido);
  for (const css of bloques) {
    const h = analizar(css, rel, escala);
    for (const k of Object.keys(total)) total[k].push(...h[k]);
  }
}

const ROTULO = {
  fontSize:   'font-size con literal en vez de var(--fs-*)',
  hex:        'hex crudo en una declaración de color',
  breakpoint: '@media con breakpoint en px (§R los pide en rem)',
  outline:    'outline:none sin un :focus-visible hermano',
};

const COMO = {
  fontSize:   'Usá el token de la escala. Ninguno de los literales top está a más de 0.5px de uno que ya existe.',
  hex:        'Usá el token semántico (--ok-soft-bg, --bad-border, --text-muted…). Un hex se ve bien en claro y roto en oscuro.',
  breakpoint: 'Pasalo a rem (640px = 40rem). En px, el breakpoint no acompaña el zoom al 200%.',
  outline:    'Si apagás el outline, el bloque TIENE que traer su :focus-visible con el anillo tokenizado. Sin anillo no hay teclado.',
};

let rojo = false;
for (const k of Object.keys(total)) {
  const n = total[k].length;
  if (n <= TOPE[k]) continue;
  rojo = true;
  console.error('\n❌ ' + ROTULO[k] + ': ' + TOPE[k] + ' declarados → ' + n + ' hoy (+' + (n - TOPE[k]) + ').\n');
  const porArchivo = new Map();
  for (const d of total[k]) porArchivo.set(d.rel, (porArchivo.get(d.rel) || 0) + 1);
  for (const [rel, c] of [...porArchivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.error('   ×' + String(c).padStart(4) + '  ' + rel);
  }
  if (k === 'fontSize') {
    const sug = new Map();
    for (const d of total[k]) if (d.cerca) sug.set(d.valor, d.cerca[0]);
    const top = [...sug.entries()].slice(0, 6).map(([v, t]) => v + ' → var(' + t + ')').join(' · ');
    if (top) console.error('\n   Equivalencias: ' + top);
  }
  console.error('\n   ' + COMO[k]);
  console.error('   Si de verdad BAJASTE la deuda, bajá el tope en scripts/check-estilos.js en el mismo commit.\n');
}

if (rojo) process.exit(1);

const nm = noMedido.length
  ? ' ⚠️ ' + noMedido.length + ' bloque(s) con ${} NO MEDIDOS (su CSS depende de una expresión).'
  : '';

console.log('✅ ' + archivos.length + ' archivo(s) · 4 reglas de CSS dentro de su tope:');
for (const k of Object.keys(total)) {
  console.log('   ' + String(total[k].length).padStart(5) + ' / ' + String(TOPE[k]).padEnd(5) + ' ' + ROTULO[k]);
}
console.log('   La deuda no frena por existir — frena si CRECE.' + nm);

if (process.argv.includes('--lista')) {
  for (const k of Object.keys(total)) {
    const porArchivo = new Map();
    for (const d of total[k]) porArchivo.set(d.rel, (porArchivo.get(d.rel) || 0) + 1);
    console.log('\n── ' + ROTULO[k] + ' (' + total[k].length + ') ──');
    if (k === 'outline') {
      // Acá el detalle sí cabe entero, y es el que dice qué control quedó sin anillo.
      for (const d of total[k]) console.log('   ' + d.rel + '\n      ↳ ' + (d.sel || '?'));
      continue;
    }
    for (const [rel, c] of [...porArchivo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log('   ×' + String(c).padStart(4) + '  ' + rel);
    }
  }
}
