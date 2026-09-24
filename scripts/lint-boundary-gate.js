#!/usr/bin/env node
/**
 * TS.0 — Gate de tipado del boundary (ADR-052 / FASE_TS_CONTRATOS_TIPADOS).
 *
 * Frena que el codigo NUEVO agregue `any` o returns sin tipar en el boundary
 * REST — pero SOLO en las lineas que el PR/push realmente escribio. Es
 * ratchet a nivel LINEA, no archivo: tocar un service legacy no te obliga a
 * tipar toda su deuda vieja; solo lo que agregas o modificas debe venir limpio.
 *
 * Como: (1) lista los .controller.ts/.service.ts cambiados; (2) saca del diff
 * (unified=0) las lineas nuevas por archivo; (3) corre eslint (config standalone
 * `eslint.gate.config.js`, las 2 reglas como error) en JSON; (4) falla solo si
 * una violacion cae en una linea nueva.
 *
 * Base/head: NX_BASE/NX_HEAD (los pone nrwl/nx-set-shas en CI); en local cae a
 * `git merge-base origin/main HEAD`.
 *
 * Uso:  node scripts/lint-boundary-gate.js       (o: npm run lint:boundary)
 */
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
// El calculo del diff (base/head, archivos, lineas nuevas) salio de ACA y ahora
// vive compartido: `scripts/lint-changed.js` usa el mismo, en vez de copiarlo.
const { resolveBase, resolveHead, changedFiles, changedLinesByFile } = require('./lib/changed-lines');

const base = resolveBase();
const head = resolveHead();

// 1) archivos de boundary cambiados
const isBoundary = (f) => /^(libs|apps)\//.test(f) && /\.(controller|service)\.ts$/.test(f);
// En CI base/head son commits y alcanza con el diff commiteado. En LOCAL quien corre
// esto todavia no commiteo: sin mirar el arbol de trabajo el gate contesta "sin archivos
// de boundary cambiados - OK" SIN HABER MIRADO NADA. Es el mismo criterio -y el mismo
// helper- que `lint-changed.js`; aca faltaba, asi que daba verde justo cuando un dev lo
// corria antes de subir. Medido el 2026-09-24 sobre un arbol con 7 violaciones reales.
const enCI = !!(process.env.CI || process.env.NX_BASE);
const opts = { workingTree: !enCI };

const todos = changedFiles(base, head, opts);
if (todos === null) {
  // NO es "no hay nada que revisar": es "no pude medir". Fail-CLOSED (ADR-056). Antes
  // esto era `process.exit(0)` con un warning, y un gate que no puede medir diciendo OK
  // se lee igual que "no hay violaciones".
  console.error('[boundary-gate] no pude calcular el diff - el gate NO corrio.');
  process.exit(1);
}
const targets = todos.filter(isBoundary);
if (targets.length === 0) {
  console.log(`[boundary-gate] sin archivos de boundary en el diff (${base.slice(0, 9)}..${opts.workingTree ? 'arbol de trabajo' : head.slice(0, 9)}) - OK.`);
  process.exit(0);
}

// 2) lineas AGREGADAS/MODIFICADAS (lado nuevo) por archivo
const changedByFile = changedLinesByFile(targets, base, head, opts);

// 3) eslint en JSON con las 2 reglas del gate como error
const res = spawnSync(
  'npx',
  ['eslint', '--no-error-on-unmatched-pattern', '-f', 'json', '--config', 'eslint.gate.config.js', ...targets],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);
if (res.error || !res.stdout || !res.stdout.trim()) {
  // Fail-closed: si eslint no produjo reporte, no podemos verificar → bloquear.
  console.error('[boundary-gate] eslint no produjo reporte JSON:', res.error?.message || res.stderr || '(vacio)');
  process.exit(1);
}
let report;
try { report = JSON.parse(res.stdout); } catch (e) {
  console.error('[boundary-gate] no pude parsear la salida de eslint:', e.message);
  process.exit(1);
}

// 4) filtrar a violaciones en lineas NUEVAS
const repo = process.cwd();
let offenders = 0;
for (const file of report) {
  const rel = path.relative(repo, file.filePath).split(path.sep).join('/');
  const changed = changedByFile.get(rel) || new Set();
  const fresh = (file.messages || []).filter((m) => m.line && changed.has(m.line));
  if (fresh.length) {
    console.error('\n' + rel);
    for (const m of fresh) {
      console.error(`  ${m.line}:${m.column}  ${m.message}  ${m.ruleId}`);
      offenders++;
    }
  }
}

if (offenders > 0) {
  console.error(`\n[boundary-gate] ❌ ${offenders} violacion(es) de tipado en lineas NUEVAS del boundary.`);
  console.error('Tipalo con el contrato de libs/contracts (ADR-052). No se permite `any` nuevo aca.\n');
  process.exit(1);
}
console.log('[boundary-gate] ✅ ' + targets.length + ' archivo(s) de boundary; sin any/returns sin tipar en lineas nuevas.');
process.exit(0);
