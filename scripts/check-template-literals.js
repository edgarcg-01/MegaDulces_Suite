#!/usr/bin/env node
/**
 * Parse de SINTAXIS de los componentes Angular — el guardia contra el backtick suelto.
 *
 * El bug: un backtick dentro de un comentario del `template:` o `styles:` (`<!-- `foo` -->`,
 * `/* `--token` *​/`) **cierra el template literal**. TypeScript sigue leyendo lo que viene como
 * código y el error sale desplazado, normalmente como `NG1002` o una cascada de `TS1005` a
 * cientos de líneas de distancia. Ya rompió el build de este repo varias veces, y es
 * especialmente fácil de cometer justo cuando uno documenta una clase o un token en el comentario.
 *
 * Por qué existe este script y no basta con `tsc`: `tsc` lo atrapa, sí — pero tarda minutos,
 * necesita `node_modules` completo, y en un monorepo con el árbol a medio instalar no corre.
 * Esto sólo parsea (sin resolver tipos ni templates), no necesita dependencias más que el propio
 * TypeScript, y termina en menos de un segundo.
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
function revisarComponente(sf, rel, errores) {
  const esLiteral = (n) => n && (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n));

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
        }
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
}

let malos = 0;
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
  revisarComponente(sf, rel, errores);

  // La pista accionable: el backtick dentro de un comentario. Se reporta SIEMPRE que el archivo
  // tenga un problema, porque es la causa en prácticamente todos los casos.
  if (errores.length) {
    const re = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!m[0].includes('`')) continue;
      const linea = text.slice(0, m.index).split('\n').length;
      errores.push(`  ↳ línea ${linea}: backtick dentro de un comentario — ${m[0].slice(0, 70).replace(/\s+/g, ' ')}…`);
    }
    malos++;
    console.error(`\n${rel}`);
    for (const e of errores) console.error(e);
  }
}

if (malos > 0) {
  console.error(`\n❌ ${malos} componente(s) con el template literal roto.`);
  console.error('   Causa casi siempre: un backtick dentro de un comentario de template/styles.');
  console.error('   Ojo — con un número PAR de backticks el archivo parsea igual y el build revienta después.\n');
  process.exit(1);
}
console.log(`✅ ${files.length} componente(s): template/styles son literales enteros, sin backticks sueltos.`);
