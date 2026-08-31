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

let malos = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics || [];
  if (!diags.length) continue;
  malos++;
  console.error(`\n${path.relative(ROOT, file).split(path.sep).join('/')}`);
  for (const d of diags.slice(0, 5)) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start);
    console.error(`  ${line + 1}:${character + 1}  ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  // La pista concreta: el primer backtick que aparece DESPUÉS de abrirse template/styles y que
  // no es el que los cierra suele ser el culpable, y casi siempre está en un comentario.
  const sospechosos = [];
  const re = /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].includes('`')) {
      const linea = text.slice(0, m.index).split('\n').length;
      sospechosos.push(`  ↳ línea ${linea}: hay un backtick dentro de un comentario — ${m[0].slice(0, 60).replace(/\s+/g, ' ')}…`);
    }
  }
  if (sospechosos.length) {
    console.error('  Sospechosos (backtick dentro de un comentario, que cierra el template literal):');
    for (const s of sospechosos.slice(0, 5)) console.error(s);
  }
}

if (malos > 0) {
  console.error(`\n❌ ${malos} componente(s) no parsean. Si el error no tiene sentido donde apunta, mirá los sospechosos: un backtick en un comentario cierra el template y desplaza todo lo que sigue.\n`);
  process.exit(1);
}
console.log(`✅ ${files.length} componente(s) parsean — sin backticks sueltos en template/styles.`);
