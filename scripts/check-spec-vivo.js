#!/usr/bin/env node
/**
 * Compuerta: un archivo de prueba que NO CARGA reporta **0 tests**, no sus casos fallando.
 *
 * ── Lo que costó, medido el 2026-10-06 ────────────────────────────────────────────────────────
 *
 * 13 archivos de `libs/` empezaban con `import { describe, it, expect } from 'vitest'`. En esos
 * proyectos eso tira `TypeError: Cannot read properties of undefined (reading 'config')` **antes
 * de correr un solo caso**, así que vitest los cuenta como "1 failed file" con **cero** pruebas.
 *
 * El resumen decía cosas como `Test Files 10 failed | 32 passed · Tests 441 passed`: el número
 * grande sigue creciendo, nadie mira la línea de archivos, y **166 pruebas llevaban meses sin
 * correr una sola vez** — entre ellas el candado de `row-nav` (la guarda de teclado de todas las
 * tablas), el de `buscar-en-cliente` y los de cotizaciones y costo estándar.
 *
 * ⭐ Es ADR-056 en su forma más incómoda: *lo que no se midió no se puede leer como ✔*. Un cero
 * de pruebas se ve igual que "este archivo no aporta casos", que es justo lo contrario de lo que
 * pasaba.
 *
 * ── Qué vigila, y qué NO afirma ───────────────────────────────────────────────────────────────
 *
 * La regla es la MEDIDA, no una teoría: **en `libs/` el import rompe; en `apps/` no**. Lo
 * verificado es eso. Se probó y se descartó la explicación obvia —un `vitest` anidado en el
 * `node_modules` de cada lib— porque **ninguno de los ocho proyectos lo tiene**. La causa de
 * fondo queda SIN ESTABLECER a propósito: una compuerta puede congelar un hecho medido sin
 * inventarle un porqué.
 *
 * ── Prueba negativa ───────────────────────────────────────────────────────────────────────────
 *
 * `node scripts/check-spec-vivo.js --self-test` arma los dos casos en memoria (uno que debe
 * marcar, uno que no) y verifica el rojo. Un gate sin prueba negativa es una intención.
 */
const fs = require('node:fs');
const path = require('node:path');

const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;

/** Un import REAL de 'vitest', no una línea de comentario que lo mencione. */
const RE_IMPORT = /^\s*import\s[^\n]*\sfrom\s+['"]vitest['"]/m;

function* archivos(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (IGNORAR.test(p)) continue;
    if (e.isDirectory()) yield* archivos(p);
    else if (e.name.endsWith('.spec.ts')) yield p;
  }
}

function revisar(src) {
  return RE_IMPORT.test(src);
}

if (process.argv.includes('--self-test')) {
  const casos = [
    ['import { describe } from \'vitest\';\ndescribe("x", () => {});', true, 'import real'],
    ['import { vi, expect } from "vitest";', true, 'import real con comillas dobles'],
    ['// Sin `import ... from \'vitest\'`: la config usa globals.\nimport { f } from \'./f\';', false, 'solo lo menciona un comentario'],
    ['import { f } from \'./f\';\ndescribe("x", () => {});', false, 'spec sano'],
  ];
  let malos = 0;
  for (const [src, esperado, que] of casos) {
    const dio = revisar(src);
    if (dio !== esperado) { malos++; console.log(`   ✗ ${que}: esperaba ${esperado}, dio ${dio}`); }
  }
  if (malos) { console.log(`\n[X] self-test: ${malos} caso(s) mal.`); process.exit(1); }
  console.log('OK self-test: 4 casos (2 que marcan, 2 que no — incluido el comentario que lo cita).');
  process.exit(0);
}

const hallazgos = [];
for (const f of archivos('libs')) {
  if (revisar(fs.readFileSync(f, 'utf8'))) hallazgos.push(f.replace(/\\/g, '/'));
}

if (hallazgos.length) {
  console.log('\n[X] Specs de libs/ que NO VAN A CARGAR (y por eso reportan 0 tests, no fallas):\n');
  for (const f of hallazgos) console.log(`   ${f}`);
  console.log('\n   Quitá el import: la config de estos proyectos usa `globals: true`, así que');
  console.log('   describe/it/expect/vi/beforeEach ya están en el ámbito.');
  console.log('   ⚠️ Un archivo que no carga NO se ve rojo en el total de pruebas — se ve como');
  console.log('      si no aportara casos. Medido: 166 pruebas sin correr.\n');
  process.exit(1);
}
console.log('OK specs: ningún archivo de libs/ importa de "vitest" (cargarían en cero).');
