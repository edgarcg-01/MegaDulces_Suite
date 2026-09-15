#!/usr/bin/env node
/**
 * Parse de SINTAXIS de los componentes Angular — el guardia contra el comentario que se cierra solo.
 *
 * Tres chequeos, UNA sola familia de bug: **puntuación adentro de un comentario que TERMINA el
 * comentario**. Lo que sigue se lee como código, el error sale desplazado o no sale, y en dos de
 * los tres casos el build queda VERDE mientras algo se rompe.
 *
 *   1. backtick dentro de un comentario de `template:`/`styles:`  → cierra el template literal
 *   2. la secuencia de cierre de comentario CSS adentro de un     → cierra el comentario CSS
 *      comentario CSS  (escribir `--warn-*` con la barra pegada)
 *   3. el cierre de comentario HTML huérfano en un `template:`     → el resto se RENDERIZA como texto
 *

 * El bug: un backtick dentro de un comentario del `template:` o `styles:` (`<!-- `foo` -->`,
 * `/* `--token` *​/`) **cierra el template literal**. TypeScript sigue leyendo lo que viene como
 * código y el error sale desplazado, normalmente como `NG1002` o una cascada de `TS1005` a
 * cientos de líneas de distancia. Ya rompió el build de este repo varias veces, y es
 * especialmente fácil de cometer justo cuando uno documenta una clase o un token en el comentario.
 *
 * Por qué existe este script y no basta con `tsc`: `tsc` atrapa el caso 1, sí — pero tarda minutos,
 * necesita `node_modules` completo, y en un monorepo con el árbol a medio instalar no corre.
 * Esto sólo parsea (sin resolver tipos ni templates) y termina en menos de un segundo.
 *
 * ⚠️ Y los casos 2 y 3 **`tsc` no los ve, y el build tampoco los frena**. El 2 sale del build como
 * *warning* y nada más: medido el 2026-09-14 en `tienda-verificador.component.ts`, ese warning
 * significaba que la regla `.vf-cambio` NO EXISTÍA en el bundle —Angular le pegó el atributo de
 * scope a cada palabra del comentario y el selector dejó de matchear— y la caja de aviso "precio
 * cambiado" del verificador de mostrador se renderizaba sin estilo EN PRODUCCIÓN. Un warning que
 * nadie lee es un defecto que nadie ve.
 *
 * NO reemplaza a `tsc` ni al build: no valida tipos, ni bindings, ni el template de Angular.
 *
 * Uso:
 *   node scripts/check-template-literals.js              # todos los .component.ts
 *   node scripts/check-template-literals.js <archivo...> # sólo esos
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
// El MISMO parser de CSS que usa el build de Angular para compilar los `styles:` inline. Se usa
// esbuild a propósito y no postcss: postcss es tolerante y se traga el comentario mal cerrado sin
// chistar, y además un veredicto distinto al del build sería un gate que discute con la verdad.
//
// ⚠️ Es una dependencia TRANSITIVA (la traen `@angular/build`, `@angular-devkit/build-angular` y
// `jest-preset-angular`), y se deja así A PROPÓSITO: fijarla como dependencia directa la haría
// divergir de la versión que el build usa de verdad, que es el único motivo para haberla elegido.
// El precio es que un cambio de hoisting puede dejarla sin resolver — y por eso esto NO es un
// `try/catch` que sigue de largo: un parser ausente tiene que ser ROJO, nunca un verde más
// barato. Una compuerta que se saltea sola se lee igual que una que no encontró nada (ADR-056).
let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('\n❌ No se pudo cargar `esbuild`, que es lo que parsea los `styles:` acá.');
  console.error('   Viene de `@angular/build` (transitiva, a propósito: tiene que ser la MISMA que usa el build).');
  console.error('   Corré `npm ci`. Si el árbol está sano y sigue faltando, cambió el hoisting —');
  console.error('   resolvela desde `@angular/build`, NO la agregues como dependencia directa ni');
  console.error('   saltees el chequeo: sin parser, este gate no puede decir nada sobre el CSS.\n');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs'];

/** Recorre buscando componentes Angular, saltando lo que no es fuente. */
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', '.nx', 'coverage'].includes(e.name)) continue;
      walk(full, out);
    } else if (e.name.endsWith('.component.ts')) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(ROOT, f))
  : DIRS.flatMap((d) => walk(path.join(ROOT, d), []));

/**
 * El chequeo ESTRUCTURAL, que es el que de verdad sirve.
 *
 * Parsear no alcanza: si los backticks sueltos son un número **par**, el literal se cierra y
 * se vuelve a abrir, y el archivo **parsea perfecto**. El daño sale recién como error semántico
 * (`TS2339 Property 'ep' does not exist`, `TS2304 Cannot find name 'tag'`) — que este script,
 * sin resolver tipos, no puede ver. Pasó exactamente así con
 * `/* ...`.ep-tag`... `<p-tag>`... *​/`: cuatro backticks, parseo limpio, build roto.
 *
 * Lo que sí es invariante: en un componente sano, `template:` y cada elemento de `styles:` son
 * **un template literal entero** (`NoSubstitutionTemplateLiteral`). Si un backtick suelto lo
 * partió, el nodo deja de ser un literal y pasa a ser una expresión (acceso a propiedad, resta,
 * comparación…). Eso se detecta sin tipos y no tiene falsos negativos por paridad.
 */
function revisarComponente(sf, rel, errores, stats) {
  const esLiteral = (n) => n && (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n));
  // Sólo el caso 1 justifica listar los comentarios con backtick. Si lo que falló fue el CSS,
  // esa lista es ruido que manda a buscar donde no está — el pecado original de este bug.
  let sospechaBacktick = false;

  /** Línea del .ts donde arranca el contenido del literal (después del backtick de apertura). */
  const lineaBase = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  /**
   * CASO 2 — el `styles:` se parsea con esbuild, que es lo que hace el build de verdad.
   *
   * Cualquier warning cuenta como falla. Esa es toda la gracia: el build los imprime y sigue,
   * y un warning de CSS no es cosmético — significa que el parser perdió el hilo y lo que sigue
   * quedó pegado al selector anterior o se descartó. La regla desaparece del bundle sin avisar.
   */
  const revisarCss = (lit) => {
    stats.css++;
    let res;
    try {
      res = esbuild.transformSync(lit.text, { loader: 'css' });
    } catch (err) {
      for (const e of (err.errors || []).slice(0, 3)) {
        errores.push(`  ${lineaBase(lit) + ((e.location && e.location.line) || 1) - 1}: CSS no parsea — ${e.text}` +
          (e.location && e.location.lineText ? `\n      ↳ ${e.location.lineText.trim().slice(0, 100)}` : ''));
      }
      return;
    }
    for (const w of res.warnings.slice(0, 3)) {
      errores.push(`  ${lineaBase(lit) + ((w.location && w.location.line) || 1) - 1}: CSS inválido — ${w.text}` +
        (w.location && w.location.lineText ? `\n      ↳ ${w.location.lineText.trim().slice(0, 100)}` : ''));
    }
  };

  /**
   * CASO 3 — cierre de comentario HTML huérfano dentro del `template:`.
   *
   * Un comentario HTML termina en el PRIMER cierre; si el autor escribió otro más adelante
   * creyendo que seguía adentro, todo lo que quedó en medio **se renderiza como texto en la
   * página** y el cierre sobrante también. Angular no se queja: es texto válido.
   *
   * Se recorre el literal alternando apertura/cierre. Un cierre que aparece sin apertura viva
   * por delante es el huérfano. No es heurística: es desbalance, no tiene falso positivo.
   */
  const ABRE = '<!--';
  const CIERRA = '--' + '>';
  const revisarHtml = (lit) => {
    stats.html++;
    const s = lit.text;
    let i = 0;
    while (i < s.length) {
      const abre = s.indexOf(ABRE, i);
      const cierra = s.indexOf(CIERRA, i);
      if (cierra === -1) break;
      if (abre !== -1 && abre < cierra) {
        const fin = s.indexOf(CIERRA, abre + ABRE.length);
        if (fin === -1) break;          // comentario sin cerrar: lo reporta el compilador
        i = fin + CIERRA.length;
        continue;
      }
      const linea = lineaBase(lit) + s.slice(0, cierra).split('\n').length - 1;
      errores.push(`  ${linea}: cierre de comentario HTML huérfano — el comentario ya había terminado antes, así que lo de en medio SE RENDERIZA como texto.` +
        `\n      ↳ …${s.slice(Math.max(0, cierra - 60), cierra + CIERRA.length).replace(/\s+/g, ' ')}`);
      i = cierra + CIERRA.length;
    }
  };

  /** Sólo el objeto del decorador. `styles: { fontSize: 8 }` de una config de jsPDF no es esto. */
  const revisarObjetoDecorador = (obj) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
      const nombre = prop.name.text;
      if (nombre !== 'template' && nombre !== 'styles') continue;
      const objetivos = ts.isArrayLiteralExpression(prop.initializer)
        ? prop.initializer.elements
        : [prop.initializer];
      for (const t of objetivos) {
        // Una constante importada o una ruta son legítimas.
        if (ts.isStringLiteral(t) || ts.isIdentifier(t) || ts.isPropertyAccessExpression(t)) continue;
        if (!esLiteral(t)) {
          const { line } = sf.getLineAndCharacterOfPosition(t.getStart(sf));
          errores.push(`  ${line + 1}: '${nombre}' dejó de ser un template literal entero (es ${ts.SyntaxKind[t.kind]}) — hay un backtick suelto adentro que lo partió.`);
          sospechaBacktick = true;
          continue;
        }
        // Un literal con `${}` no se puede parsear como CSS/HTML: el texto que ve el compilador
        // depende de lo que devuelva la expresión. NO se revisa — y se CUENTA, para que salga
        // como "no medido" en el resumen en vez de desaparecer en silencio (ADR-056). Hoy son 0.
        if (ts.isTemplateExpression(t)) { stats.saltados++; continue; }
        if (nombre === 'styles') revisarCss(t); else revisarHtml(t);
      }
    }
  };

  const visitar = (node) => {
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const fn = node.expression.expression;
      const nombre = ts.isIdentifier(fn) ? fn.text : null;
      if (nombre === 'Component' || nombre === 'Directive') {
        const arg = node.expression.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) revisarObjetoDecorador(arg);
      }
    }
    ts.forEachChild(node, visitar);
  };
  visitar(sf);
  return sospechaBacktick;
}

let malos = 0;
const stats = { css: 0, html: 0, saltados: 0 };
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  // setParentNodes = true: `getStart(sf)` lo necesita para ubicar la línea.
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const errores = [];

  for (const d of (sf.parseDiagnostics || []).slice(0, 5)) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
    errores.push(`  ${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  const parseRoto = (sf.parseDiagnostics || []).length > 0;
  const sospechaBacktick = revisarComponente(sf, rel, errores, stats) || parseRoto;

  // La pista accionable del caso 1: el backtick dentro de un comentario. Se lista sólo cuando el
  // síntoma es del caso 1 — ante un CSS mal cerrado, esta lista mandaría a buscar donde no está.
  if (errores.length && sospechaBacktick) {
    const re = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].includes('`')) continue;
      const linea = text.slice(0, m.index).split('\n').length;
      errores.push(`  ↳ línea ${linea}: backtick dentro de un comentario — ${m[0].slice(0, 70).replace(/\s+/g, ' ')}…`);
    }
  }

  if (errores.length) {
    malos++;
    console.error(`\n${rel}`);
    for (const e of errores) console.error(e);
  }
}

const noMedido = stats.saltados
  ? `\n   ⚠️ ${stats.saltados} bloque(s) con \`\${}\` NO MEDIDOS: su contenido depende de una expresión, así que no se puede parsear acá. Revisalos a mano.`
  : '';

if (malos > 0) {
  console.error(`\n❌ ${malos} componente(s) con un comentario que se cierra antes de tiempo.`);
  console.error('   Las tres formas, misma causa — puntuación adentro de un comentario que lo termina:');
  console.error('     · backtick en un comentario de template/styles → parte el template literal.');
  console.error('       Ojo: con un número PAR el archivo parsea igual y el build revienta después.');
  console.error('     · cierre de comentario CSS adentro de un comentario CSS (p. ej. `--warn-*` con la');
  console.error('       barra pegada) → lo que sigue se pega al selector y la regla DESAPARECE del bundle.');
  console.error('       El build sólo lo dice como warning: en verde, y con el estilo roto en producción.');
  console.error('     · cierre de comentario HTML huérfano en un template → el resto se RENDERIZA como texto.');
  console.error(noMedido + '\n');
  process.exit(1);
}
console.log(`✅ ${files.length} componente(s) · ${stats.html} template + ${stats.css} bloques de estilo: literales enteros, CSS que parsea, comentarios bien cerrados.${noMedido}`);
