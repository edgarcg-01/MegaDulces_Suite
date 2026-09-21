#!/usr/bin/env node
/**
 * check-bundle-externals.js — candado del `node_modules` podado de la imagen.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * El stage `prod-deps` del Dockerfile ya no instala desde el `package.json` de
 * la RAÍZ (116 deps, con todo el stack de Angular/PrimeNG/Capacitor adentro)
 * sino desde el manifiesto PODADO que emite el propio build de la api
 * (`generatePackageJson: true` en `apps/api/webpack.config.js`) — 64 deps.
 *
 * Ese manifiesto lo deriva webpack de los `externals` que VE en el grafo de
 * imports. O sea que hay un modo de falla real: un paquete que se requiere de
 * forma DINÁMICA (`require(variable)`) no aparece en el grafo, no entra al
 * manifiesto, no se instala, y la imagen revienta con `MODULE_NOT_FOUND` recién
 * en el arranque de prod. Es exactamente el tipo de error que un build verde
 * deja pasar.
 *
 * Este script cierra ese hueco con un árbitro INDEPENDIENTE del manifiesto:
 * lee los `require("...")` que quedaron LITERALES en el bundle emitido y exige
 * que cada uno resuelva contra el `node_modules` podado de verdad. Si el
 * recorte se pasa de listo, el build FALLA acá, no en prod.
 *
 *   ⚠️ Lo que este candado NO cubre: un `require(unaVariable)` tampoco queda
 *   literal en el bundle, así que tampoco lo ve. Cubre el error de PODA
 *   (webpack lo vio pero npm no lo instaló), no el de análisis estático. Para
 *   ese otro caso el testigo es el arranque real del contenedor.
 *
 * ── Prueba negativa ─────────────────────────────────────────────────────────
 * Borrar a mano un paquete del árbol podado y volver a correrlo: tiene que
 * salir 1 nombrándolo. Medido al escribirlo.
 *
 * Uso: node scripts/check-bundle-externals.js <bundle.js> <node_modules_dir>
 */
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const [, , bundlePath, modulesDir] = process.argv;

if (!bundlePath || !modulesDir) {
  console.error('Uso: check-bundle-externals.js <bundle.js> <node_modules_dir>');
  process.exit(2);
}

if (!fs.existsSync(bundlePath)) {
  console.error(`[externals] No existe el bundle: ${bundlePath}`);
  process.exit(2);
}

const src = fs.readFileSync(bundlePath, 'utf8');
const builtins = new Set(builtinModules);
const paquetes = new Set();

// webpack emite los externals de target:node como `require("nombre")` literal.
for (const m of src.matchAll(/require\("([^"]+)"\)/g)) {
  const pedido = m[1];
  if (pedido.startsWith('.') || pedido.startsWith('/') || pedido.startsWith('node:')) continue;
  // `@scope/pkg/sub` → `@scope/pkg`;  `pkg/sub` → `pkg`
  const nombre = pedido.startsWith('@')
    ? pedido.split('/').slice(0, 2).join('/')
    : pedido.split('/')[0];
  if (builtins.has(nombre)) continue;
  paquetes.add(nombre);
}

if (paquetes.size === 0) {
  // Un bundle sin un solo external es sospechoso: o cambió el emit de webpack o
  // apuntamos al archivo equivocado. Callarse acá dejaría el candado en no-op.
  console.error('[externals] 0 externals encontrados en el bundle — el candado quedaría vacío.');
  process.exit(2);
}

const raiz = path.resolve(modulesDir, '..');
const faltan = [];
for (const nombre of [...paquetes].sort()) {
  try {
    require.resolve(nombre, { paths: [raiz] });
  } catch {
    // `require.resolve` falla también cuando el paquete existe pero no tiene
    // entrypoint resoluble (p.ej. sólo exporta subpaths). Eso NO es un faltante.
    if (!fs.existsSync(path.join(modulesDir, nombre, 'package.json'))) {
      faltan.push(nombre);
    }
  }
}

if (faltan.length > 0) {
  console.error(
    `[externals] ⛔ El bundle requiere ${faltan.length} paquete(s) que NO están en el node_modules podado:`
  );
  for (const n of faltan) console.error(`  - ${n}`);
  console.error(
    '[externals] Causa probable: `generatePackageJson` no los vio (require dinámico) o el lock podado quedó viejo.'
  );
  process.exit(1);
}

console.log(`[externals] ✔ ${paquetes.size} externals del bundle resuelven contra el node_modules podado.`);
