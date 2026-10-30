#!/usr/bin/env node
/**
 * `[BUNDLE.1]` ¿Qué paquete ocupa cada KB del JS inicial de `view`?
 *
 * Lee el `stats.json` que deja `nx build view --stats-json` (es el metafile de esbuild) y suma
 * `bytesInOutput` por origen: un paquete de npm o una carpeta de la app. Sólo cuenta los archivos
 * de SALIDA que el navegador baja al abrir la suite (los que el `index.html` carga), no los
 * chunks perezosos.
 *
 * Por qué existe: medido el 2026-10-30, `main.js` pesaba 1,534 KB (393 KB por la red) contra un
 * presupuesto de 1.75 MB, y el source map no se publica — sin este reporte no hay forma de saber
 * qué sacar del arranque.
 *
 *   node scripts/bundle-por-paquete.js <stats.json> [--top=40] [--md]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith('--'));
if (!archivo) {
  console.error('uso: node scripts/bundle-por-paquete.js <stats.json> [--top=40] [--md]');
  process.exit(2);
}
const top = Number((args.find((a) => a.startsWith('--top=')) || '--top=40').slice(6));
const md = args.includes('--md');

const meta = JSON.parse(fs.readFileSync(archivo, 'utf8'));
const salidas = meta.outputs || {};

// Lo inicial = `main-*` y `polyfills-*`, más lo que importan de forma estática.
// ⛔ No sirve `entryPoint`: con code splitting esbuild lo pone en CADA import dinámico (309 de
// 311 salidas en el primer `stats.json` real), y el reporte sumaba 16 MB de «inicial».
const iniciales = new Set();
const pendientes = Object.keys(salidas).filter((f) => /(^|\/)(main|polyfills)-[^/]+\.js$/.test(f));
while (pendientes.length) {
  const f = pendientes.pop();
  if (iniciales.has(f)) continue;
  iniciales.add(f);
  for (const imp of salidas[f].imports || []) {
    if (imp.kind === 'import-statement' && salidas[imp.path]) pendientes.push(imp.path);
  }
}

function origen(entrada) {
  const nm = entrada.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const p = entrada.slice(nm + 13).split('/');
    return 'npm ' + (p[0].startsWith('@') ? p[0] + '/' + p[1] : p[0]);
  }
  const app = entrada.match(/apps\/[^/]+\/src\/app\/(?:modules\/)?[^/]+(?:\/[^/.]+)?/);
  if (app) return app[0];
  const lib = entrada.match(/libs\/[^/]+/);
  return lib ? lib[0] : entrada;
}

const porOrigen = new Map();
let total = 0;
for (const f of iniciales) {
  for (const [entrada, info] of Object.entries(salidas[f].inputs || {})) {
    const b = info.bytesInOutput || 0;
    total += b;
    const k = origen(entrada);
    porOrigen.set(k, (porOrigen.get(k) || 0) + b);
  }
}

const kb = (b) => (b / 1024).toFixed(1);
const filas = [...porOrigen.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
const lineas = [];
lineas.push(md ? '## JS inicial de `view`, por origen' : 'JS inicial de view, por origen');
lineas.push('');
lineas.push(`Archivos iniciales: ${[...iniciales].map((f) => path.basename(f)).join(', ')} · total ${kb(total)} KB minificado (sin comprimir)`);
lineas.push('');
if (md) lineas.push('| KB | % | origen |', '|---:|---:|---|');
for (const [k, b] of filas) {
  const pct = ((b / total) * 100).toFixed(1);
  lineas.push(md ? `| ${kb(b)} | ${pct} | \`${k}\` |` : `${kb(b).padStart(8)} KB ${pct.padStart(5)}%  ${k}`);
}
console.log(lineas.join('\n'));
