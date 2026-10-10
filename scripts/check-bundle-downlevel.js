#!/usr/bin/env node
/**
 * check-bundle-downlevel.js — candado del spread de iterables en el bundle de la api.
 *
 * ── El defecto que vigila ───────────────────────────────────────────────────
 * Cuando SWC compila con `jsc.loose = true`, `[...iterable]` NO se emite con el
 * helper que itera: se emite como `[].concat(iterable)`, que asume array-like.
 * El resultado en runtime es **un array con el Set/MapIterator adentro**, no sus
 * elementos. `.length === 1`, así que burla cualquier guard `if (xs.length)`; un
 * `Set` serializa a `{}` para pg, y un `[MapIterator]` rompe `.filter/.sort`.
 *
 * Ya costó SIETE incidentes de producción documentados en `GOTCHAS.md` — entre
 * ellos un `22P02` que tumbaba el sell-out entero, `/compras/costo-neto` vacío,
 * la conciliación de bancos en `$0`, un `500` en el XLSX de `/compras/pedido` y
 * una violación de RLS por un `insert ... default values`. Todos con **build
 * verde, typecheck verde y cero errores en consola**: el bundle compila
 * perfecto y miente en runtime.
 *
 * ── Por qué hace falta un candado y no alcanza la regla ─────────────────────
 * La defensa de hoy es (a) el plugin que fuerza `loose:false` y (b) la regla
 * «NUNCA spread de iterable en código de la api», que el barrido de 2026-08-18
 * aplicó a mano en 53 sitios de 35 archivos. Las dos son correctas y las dos son
 * frágiles por el mismo motivo: **dependen de que alguien se acuerde**. El
 * plugin vive en la config de UN bundler, así que cambiarlo de herramienta lo
 * puede dejar atrás sin que nada avise; y la regla la tiene que recordar cada
 * persona que escriba un `[...]` nuevo.
 *
 * Este candado mira el ARTEFACTO, que es lo único que no se olvida: si el
 * bundle emitido trae el patrón roto, falla. No le importa qué bundler lo
 * produjo ni cómo quedó configurado.
 *
 * ── Lo que NO cubre, declarado ──────────────────────────────────────────────
 * Sólo ve el patrón que el downlevel EN MODO LOOSE produce. Un `[...]` emitido
 * con el helper correcto (`_to_consumable_array`) itera bien y acá pasa — como
 * debe. Y no ve el código de `node_modules`, que el loader excluye.
 *
 * ── Prueba negativa ────────────────────────────────────────────────────────
 * `--self-test` compila el mismo fuente con SWC en los dos modos y exige que el
 * candado diga ROTO con `loose:true` y SANO con `loose:false`. Si alguna vez el
 * detector deja de detectar, el self-test se pone rojo antes que el bundle.
 *
 * Uso:
 *   node scripts/check-bundle-downlevel.js [bundle.js]   (default: dist/apps/api/main.js)
 *   node scripts/check-bundle-downlevel.js --self-test
 */
const fs = require('fs');
const path = require('path');

/**
 * El patrón roto. `[].concat(` seguido de algo que SÓLO puede ser un iterable:
 * un `new Set(...)` o un `.values()/.keys()/.entries()`. Un `[].concat(array)`
 * normal es correcto y no se marca.
 */
const ROTO = /\[\]\.concat\(\s*(new Set\(|[A-Za-z_$][\w.$]*\.(values|keys|entries)\(\s*\))/g;

/** ¿El offset cae dentro de un comentario? El bundle trae los comentarios del fuente,
 *  y tres de ellos DOCUMENTAN este bug citando el patrón. Marcarlos sería un falso
 *  positivo permanente — y un candado que grita siempre enseña a ignorarlo. */
function enComentario(src, idx) {
  const desde = Math.max(0, idx - 4000);
  const antes = src.slice(desde, idx);
  const nl = antes.lastIndexOf('\n');
  if (antes.slice(nl + 1).includes('//')) return true;
  const ab = antes.lastIndexOf('/*');
  return ab !== -1 && antes.lastIndexOf('*/') < ab;
}

/** Devuelve los ofensores REALES (código, no comentario) de un texto. */
function ofensores(src) {
  const out = [];
  ROTO.lastIndex = 0;
  let m;
  while ((m = ROTO.exec(src))) {
    if (enComentario(src, m.index)) continue;
    const a = Math.max(0, m.index - 90);
    out.push({
      idx: m.index,
      linea: src.slice(0, m.index).split('\n').length,
      ctx: src.slice(a, Math.min(src.length, m.index + 90)).replace(/\s+/g, ' '),
    });
  }
  return out;
}

// ── self-test: la prueba negativa ──────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  let swc;
  try {
    swc = require('@swc/core');
  } catch {
    console.log('NO MEDIDO: falta @swc/core para el self-test (no es una falla del candado).');
    process.exit(0);
  }
  const SRC = `export function f(m){ return [...new Set([1,2])].concat([...m.values()]); }`;
  const base = { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } };
  const compilar = (loose) => swc.transformSync(SRC, { jsc: { ...base, loose }, filename: 'x.ts' }).code;

  const conLoose = ofensores(compilar(true)).length;
  const sinLoose = ofensores(compilar(false)).length;
  // Y el falso positivo que ya existe en el bundle: el patrón DENTRO de un comentario.
  const enComent = ofensores(`// ejemplo: [].concat(new Set(x)) rompe\nconst a = 1;`).length;

  const casos = [
    ['loose:true  -> detecta el patrón roto', conLoose > 0],
    ['loose:false -> NO marca el helper correcto', sinLoose === 0],
    ['un comentario que cita el patrón NO cuenta', enComent === 0],
  ];
  let fallas = 0;
  for (const [nombre, ok] of casos) {
    console.log(`  ${ok ? 'OK ' : 'FALLA'}  ${nombre}`);
    if (!ok) fallas++;
  }
  console.log(fallas === 0 ? '\nself-test: 3/3' : `\nself-test: ${3 - fallas}/3 — el detector no detecta`);
  process.exit(fallas === 0 ? 0 : 1);
}

// ── modo normal ────────────────────────────────────────────────────────────
const bundle = process.argv[2] || path.join('dist', 'apps', 'api', 'main.js');

if (!fs.existsSync(bundle)) {
  // ⛔ Sin bundle NO se dibuja un verde: «no se pudo medir» es una respuesta (ADR-056).
  //    Sale 0 porque el job que construye `affected` legítimamente puede no incluir la api.
  console.log(`NO MEDIDO: no existe ${bundle} (la api no se construyó en esta corrida).`);
  process.exit(0);
}

const src = fs.readFileSync(bundle, 'utf8');
const hits = ofensores(src);
const mb = (src.length / 1048576).toFixed(1);

if (hits.length === 0) {
  console.log(`OK  ${bundle} (${mb} MB): 0 spreads de iterable downleveleados en modo loose.`);
  process.exit(0);
}

console.error(`\n⛔ ${bundle} (${mb} MB): ${hits.length} spread(s) de iterable emitidos como [].concat(.`);
console.error('   En runtime el array queda con el Set/MapIterator ADENTRO. Compila verde y miente.\n');
for (const h of hits.slice(0, 12)) console.error(`   línea ~${h.linea}:  …${h.ctx}…`);
if (hits.length > 12) console.error(`   … y ${hits.length - 12} más.`);
console.error('\n   Arreglo: que el bundler emita con `jsc.loose = false`.');
console.error('   En el fuente, `[...x]` -> `Array.from(x)`, que es inmune al downlevel.');
console.error('   Contexto: docs/GOTCHAS.md (spread de iterables en el bundle de la api).\n');
process.exit(1);
