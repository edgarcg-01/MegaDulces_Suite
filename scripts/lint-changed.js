#!/usr/bin/env node
'use strict';
/**
 * Lint de lo que el cambio ESCRIBIÓ — ratchet por línea.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El paso `npx nx affected -t lint` selecciona PROYECTOS, y el lint de un
 * proyecto barre TODOS sus archivos. O sea que tocar dos archivos de `apps/view`
 * manda eslint sobre los ~1,400 problemas del proyecto entero. El comentario del
 * propio `ci.yml` prometía lo contrario — *«Blast radius acotado: NO revienta por
 * deuda de lint pre-existente en código ajeno al PR/push»* — y la implementación
 * no lo cumplía.
 *
 * Medido el 2026-09-23 sobre la corrida 35876934497 (PR #146): **294 errores y
 * 5,483 warnings** repartidos en 11 proyectos, de los cuales SÓLO 2 caían en un
 * archivo que ese PR tocaba, y ninguno en una línea que ese PR hubiera escrito.
 * Consecuencia medible: 24 de las 26 corridas desde que el workflow se reactivó
 * (22-sep) salieron rojas, y **el mismo diff dio rojo como PR y verde como merge**
 * según qué proyectos calculó `affected`. Una compuerta que se pone verde por
 * azar enseña a ignorar el tablero — el modo de falla que ADR-056 persigue.
 *
 * ── Qué hace ─────────────────────────────────────────────────────────────────
 * Corre el `eslint.config.js` RAÍZ sobre los archivos del diff y falla SÓLO por
 * errores que caen en líneas que el diff agregó o modificó. Los errores viejos de
 * esos mismos archivos se imprimen DECLARADOS, sin romper: tocar un archivo con
 * deuda no te obliga a pagarla toda, pero tampoco la esconde.
 *
 * No inventa el mecanismo: lo copia de `scripts/lint-boundary-gate.js` (TS.0 /
 * ADR-052), que ya lo tenía bien resuelto; el primitivo del diff ahora vive
 * compartido en `scripts/lib/changed-lines.js` y lo usan los dos.
 *
 * ⚠️ Parity verificada antes de escribir esto: el repo tiene UN SOLO
 * `eslint.config.js` en la raíz, sin configs por proyecto, así que lintar
 * archivos sueltos aplica exactamente las mismas reglas que el lint del
 * proyecto. Se comprobó contra la salida real de CI para
 * `apps/view/src/app/core/guards/landing-guards.spec.ts`: mismos dos errores en
 * 120:31 y 123:14, mismos tres warnings.
 *
 * ⚠️ Lo que este gate NO cubre, dicho en voz alta: un cambio puede romper el lint
 * de un archivo que NO tocó (por ejemplo al borrar un símbolo que otro usaba).
 * Eso lo ve el `nx affected -t lint` que quedó como medición no bloqueante, y el
 * aislamiento entre dominios lo cubre `@nx/enforce-module-boundaries`, que marca
 * en el archivo que importa mal — o sea, en el que el diff tocó.
 *
 * Uso:  node scripts/lint-changed.js      (o: npm run lint:changed)
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveBase, resolveHead, changedFiles, changedLinesByFile } = require('./lib/changed-lines');

/** Lo que eslint sabe mirar acá. `.mjs`/`.cjs` incluidos: hay herramental de raíz en ese formato. */
const LINTABLE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
/** Generado o fuera del alcance del config raíz. */
const EXCLUIDO = /(^|\/)(dist|node_modules|coverage|\.angular)\//;

const base = resolveBase();
const head = resolveHead();
// En CI base/head son commits y alcanza con el diff commiteado. En local, quien
// corre esto todavía no commiteó: sin mirar el árbol de trabajo, el gate contesta
// "OK" sin haber mirado nada — el verde que no midió, que es peor que un rojo.
const enCI = !!(process.env.CI || process.env.NX_BASE);
const opts = { workingTree: !enCI };

const todos = changedFiles(base, head, opts);
if (todos === null) {
  // ⚠️ NO es "no cambió nada": es "no pude medir". ADR-056 — se declara, no se
  // dibuja como verde. Fail-closed, porque el gate no puede opinar a ciegas.
  console.error('[lint-changed] ❌ no pude calcular el diff — el gate NO corrió.');
  process.exit(1);
}

const targets = todos.filter((f) => LINTABLE.test(f) && !EXCLUIDO.test(f));
if (targets.length === 0) {
  console.log(`[lint-changed] sin archivos lintables en el diff (${base.slice(0, 9)}..${opts.workingTree ? "árbol de trabajo" : head.slice(0, 9)}) — OK.`);
  process.exit(0);
}

const res = spawnSync(
  'npx',
  ['eslint', '--no-error-on-unmatched-pattern', '--no-warn-ignored', '-f', 'json', ...targets],
  { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
);
if (res.error || !res.stdout || !res.stdout.trim()) {
  // Fail-closed, igual que el boundary gate: sin reporte no hay veredicto.
  console.error('[lint-changed] ❌ eslint no produjo reporte JSON:', res.error?.message || res.stderr || '(vacio)');
  process.exit(1);
}
let report;
try { report = JSON.parse(res.stdout); } catch (e) {
  console.error('[lint-changed] ❌ no pude parsear la salida de eslint:', e.message);
  process.exit(1);
}

const nuevasPorArchivo = changedLinesByFile(targets, base, head, opts);
const repo = process.cwd();
let nuevos = 0;
let heredados = 0;

for (const file of report) {
  const rel = path.relative(repo, file.filePath).split(path.sep).join('/');
  const nuevas = nuevasPorArchivo.get(rel) || new Set();
  // Sólo ERRORES cortan. Los warnings se cuentan aparte: hay 5,483 en el repo y
  // volverlos bloqueantes de golpe es la misma trampa, con otro nombre.
  const errores = (file.messages || []).filter((m) => m.severity === 2 && m.line);
  const enLineaNueva = errores.filter((m) => nuevas.has(m.line));
  const viejos = errores.length - enLineaNueva.length;

  if (enLineaNueva.length) {
    console.error(`\n${rel}`);
    for (const m of enLineaNueva) {
      console.error(`  ${m.line}:${m.column}  error  ${m.message}  ${m.ruleId}`);
      nuevos++;
    }
  }
  if (viejos > 0) {
    heredados += viejos;
    console.log(`[lint-changed] · ${rel}: ${viejos} error(es) YA EXISTENTES en líneas que este cambio no tocó (declarados, no bloquean).`);
  }
}

if (nuevos > 0) {
  console.error(`\n[lint-changed] ❌ ${nuevos} error(es) de lint en líneas NUEVAS de ${targets.length} archivo(s) del diff.`);
  process.exit(1);
}
console.log(
  `[lint-changed] ✅ ${targets.length} archivo(s) del diff sin errores de lint en líneas nuevas` +
  (heredados ? ` (${heredados} heredado(s), declarados arriba).` : '.'),
);
process.exit(0);
