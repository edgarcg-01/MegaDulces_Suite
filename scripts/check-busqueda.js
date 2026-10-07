#!/usr/bin/env node
/**
 * `[KBD.2]` COMPUERTA — un buscador no se escribe con `.toLowerCase().includes()`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * QUÉ FALLA, MEDIDO
 *
 * `campo.toLowerCase().includes(termino)` se rompe de cuatro formas en un catálogo de dulcería:
 *
 *   1. ACENTOS        — `pina` no encuentra `PIÑA`.
 *   2. VARIAS PALABRAS— `coca 600` no encuentra `COCA COLA 600 ML` (pide la cadena contigua).
 *   3. ORDEN          — `600 coca` no encuentra nada aunque las dos palabras estén.
 *   4. UN SOLO CAMPO  — corre sobre el nombre O sobre el SKU, nunca sobre los dos a la vez.
 *
 * Lo que cuesta, medido en el servidor sobre `/compras/costo-estandar`: el `LIKE` ingenuo
 * devolvía **18 filas donde hay 1,425** buscando «pina».
 *
 * El reemplazo existe y hay que usarlo, no reescribirlo:
 *   · lista COMPLETA en memoria → `coincideBusqueda` / `filtrarPorBusqueda` de `@megadulces/ui-web`
 *   · lista que vive en el servidor → mandar el texto y usar `applySmartSearch` allá
 *
 * ⚠️ Y la trampa que esta compuerta NO puede ver: filtrar en el cliente una lista **paginada**
 * mira sólo las filas que llegaron. Tokenizar eso no lo arregla — lo correcto es que el texto
 * viaje al servidor. Se declara acá porque el arreglo mecánico (cambiar `includes` por
 * `coincide`) **deja el bug estructural intacto** y se ve igual de verde.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * ⛔ LO QUE ESTA COMPUERTA **NO** MIRA, Y POR QUÉ — el lado del SERVIDOR
 *
 * El backend tiene `LIKE`/`ILIKE` en **118 lugares** (medido 2026-10-01) y **no todos están
 * mal**: `applySmartSearch` usa `LIKE` por dentro, el prefijo (`sku LIKE 'ABC%'`) es legítimo, y
 * `::text LIKE` sobre dígitos es el camino numérico correcto. Separar "búsqueda de texto armada
 * a mano" de esos tres casos exige verlos uno por uno.
 *
 * **Una compuerta que marcara los 118 enseñaría a ignorarla en la primera corrida** — ya pasó
 * esta misma semana con `check:teclado`, que en su primer criterio marcó 7 falsos positivos de 8.
 * Así que el lado servidor queda DECLARADO como no cubierto, con su número, en vez de cubierto
 * con un criterio que no se puede defender. Cobertura hoy: **15 archivos usan `applySmartSearch`**.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const APPS = ['apps/view/src', 'apps/vendor/src', 'apps/portal/src'];
const DEUDA_FILE = path.join(__dirname, 'check-busqueda.deuda.json');
const DEUDA = new Set(
  fs.existsSync(DEUDA_FILE) ? JSON.parse(fs.readFileSync(DEUDA_FILE, 'utf8')) : [],
);

/**
 * ⛔ El aguijón es la AGUJA VARIABLE, no `includes` a secas.
 *
 * Medido antes de elegirlo: de 66 usos, **6 llevan un literal** (`...includes('volumen')`, que
 * chequea un nombre de paso, no busca nada) y **60 llevan una variable** — ésos sí son el término
 * que tecleó una persona. Marcar los 6 sería ruido puro.
 */
const RE_BUSQUEDA_INGENUA = /\.toLowerCase\(\)\s*\.includes\(\s*[A-Za-z_$]/;

function analizar(src) {
  // Sin acentos ni eñes en el archivo igual aplica: el DATO los tiene aunque el código no.
  if (!RE_BUSQUEDA_INGENUA.test(src)) return null;
  return {
    motivo:
      'filtra con .toLowerCase().includes(termino): se rompe con acentos (pina != PIÑA), con ' +
      'varias palabras, con el orden, y mira un campo por vez. Usar coincideBusqueda/' +
      'filtrarPorBusqueda de @megadulces/ui-web — o mandar el texto al servidor si la lista ' +
      'esta paginada.',
  };
}

// ── Prueba negativa ────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const casos = [
    ['buscador con variable', 'p.nombre.toLowerCase().includes(term)', true],
    ['con optional chaining y fallback', "(p.nombre || '').toLowerCase().includes(q)", true],
    ['con espacios de por medio', 'p.nombre.toLowerCase() .includes( termino )', true],
    // ⛔ Los 6 reales que NO hay que marcar: la aguja es un literal, no lo que tecleó nadie.
    ['literal: no es una búsqueda', "s.step.toLowerCase().includes('volumen')", false],
    ['literal con comillas dobles', 's.source.toLowerCase().includes("volume")', false],
    // Ya migrado: usa el motor compartido.
    ['ya usa el motor', 'return coincideBusqueda(q, f.sku, f.nombre);', false],
    ['includes sobre un arreglo, sin toLowerCase', 'roles.includes(rol)', false],
    ['un archivo sin buscador', 'const x = 1;', false],
  ];
  let fallos = 0;
  for (const [nombre, src, debeFallar] of casos) {
    const fallo = analizar(src) !== null;
    if (fallo !== debeFallar) {
      console.error(`  ❌ self-test "${nombre}": esperaba ${debeFallar ? 'ROJO' : 'verde'} y dio ${fallo ? 'ROJO' : 'verde'}`);
      fallos++;
    } else {
      console.log(`  ✅ self-test "${nombre}": ${debeFallar ? 'rojo' : 'verde'}, como debe`);
    }
  }
  if (fallos) {
    console.error(`\n❌ La compuerta no detecta ${fallos} caso(s) que debería.\n`);
    process.exit(1);
  }
  console.log(`\n✅ ${casos.length} casos: la compuerta se pone roja exactamente donde debe.\n`);
  process.exit(0);
}

function recorrer(dir, salida) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return salida; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') recorrer(p, salida); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) salida.push(p);
  }
  return salida;
}

const archivos = [];
for (const a of APPS) recorrer(path.join(RAIZ, a), archivos);

const malos = [];
const cohorte = [];
for (const f of archivos) {
  const r = analizar(fs.readFileSync(f, 'utf8'));
  if (!r) continue;
  const rel = path.relative(RAIZ, f).replace(/\\/g, '/');
  (DEUDA.has(rel) ? cohorte : malos).push({ rel, ...r });
}

if (malos.length) {
  console.error('');
  for (const m of malos) {
    console.error(`❌ ${m.rel}`);
    console.error(`   ${m.motivo}`);
  }
  console.error(`\n${malos.length} buscador(es) NUEVOS sin tokenizar.\n`);
  process.exit(1);
}

const podables = [...DEUDA].filter((d) => !cohorte.some((c) => c.rel === d));
if (podables.length) {
  console.log(`\n✅ ${podables.length} archivo(s) de la deuda ya NO la necesitan:`);
  for (const s of podables.slice(0, 10)) console.log(`   · ${s}`);
  console.log('   Sacalos de scripts/check-busqueda.deuda.json.\n');
}

const deudaTxt = cohorte.length
  ? `\n⚠️  ${cohorte.length} archivo(s) en DEUDA: buscan con .includes() — sin acentos, sin varias palabras.\n` +
    `   ⛔ El lado SERVIDOR no está cubierto por esta compuerta: 118 LIKE/ILIKE sin criterio\n` +
    `      defendible para separar los legítimos. Cobertura medida: 15 archivos con applySmartSearch.\n` +
    `   Tracker: [KBD.2].`
  : '';

console.log(
  `✅ ${archivos.length} archivo(s) · ningún buscador NUEVO con .includes().${deudaTxt}`,
);
