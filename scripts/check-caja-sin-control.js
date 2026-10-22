#!/usr/bin/env node
/**
 * Compuerta `[CGS.49]`: **nadie vuelve a leer al Access de Control como fuente viva.**
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────────────────────
 *
 * Edgar jubiló a Control «de por vida» el 2026-10-22. Su histórico (30,268 arqueos, 2013 → ese
 * día) se quedó CONGELADO en `caja_general_ods` y se lee por `analytics.v_caja_arqueos`, que lo
 * compone con los arqueos de la Suite (`[CGS.41]`). Una pantalla nueva que lea
 * `analytics.v_caja_control_*` o `caja_general_ods.*` directo funcionaría —el dato sigue ahí— pero
 * mostraría una foto que ya no avanza, en verde, sin decirlo. Es el modo de falla de siempre: un
 * sistema apagado que sigue «respondiendo».
 *
 * ── Qué vigila ────────────────────────────────────────────────────────────────────────────────
 *
 * Los `.ts` de `libs/` y `apps/` (sin pruebas) que nombran esas fuentes. Los que hoy las leen A
 * PROPÓSITO, como histórico, están en `PERMITIDOS` con su motivo: es una lista cerrada, y agregar
 * un archivo ahí es una decisión que se escribe, no un descuido que pasa.
 *
 * ── Prueba negativa ───────────────────────────────────────────────────────────────────────────
 *
 * `node scripts/check-caja-sin-control.js --self-test` arma los casos en memoria (los que deben
 * marcar y los que no, incluido el comentario que sólo menciona la fuente) y verifica el rojo.
 */
const fs = require('node:fs');
const path = require('node:path');

const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;
/** Una lectura en código: la fuente entre comillas o en SQL, no en un comentario. */
const RE_FUENTE = /\b(?:analytics\.)?v_caja_control_(?:movimientos|cortes)\b|\bcaja_general_ods\.[a-z_]/;

/** Archivo → por qué puede leer el histórico de Control. */
const PERMITIDOS = {
  'libs/finance/src/lib/caja/caja-control.service.ts':
    'el Cuadre y el expediente de Control: muestran su histórico, rotulado como tal',
  'libs/finance/src/lib/caja/caja-verdad-diferencia.query.ts':
    'el árbitro: los paquetes de Control como pistas de los días anteriores a su jubilación',
  'libs/finance/src/lib/caja/caja-posicion.query.ts':
    'la posición: lectura de respaldo mientras la vista única ([CGS.41]) no esté aplicada',
  'libs/finance/src/lib/caja/cash-cut.service.ts':
    'Arqueos: el segundo testigo y el último conteo de Control de los cortes anteriores al 2026-10-22',
};

function sinComentarios(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function lee(src) {
  return RE_FUENTE.test(sinComentarios(src));
}

function* archivos(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (IGNORAR.test(p)) continue;
    if (e.isDirectory()) yield* archivos(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) yield p;
  }
}

if (process.argv.includes('--self-test')) {
  const casos = [
    ["await trx('analytics.v_caja_control_cortes').where('tiene_corte', true);", true, 'lectura por knex'],
    ['SELECT folio FROM caja_general_ods.arqueo_movimientos', true, 'lectura por SQL'],
    ["const r = await trx.raw(`SELECT * FROM v_caja_control_movimientos`);", true, 'vista sin esquema'],
    ['// Control quedó en analytics.v_caja_control_cortes: no se lee.\nconst x = 1;', false, 'sólo lo menciona un comentario'],
    ['/** Antes se leía caja_general_ods.arqueo_movimientos. */\nconst y = 2;', false, 'comentario de bloque'],
    ["await trx('analytics.v_caja_arqueos').orderBy('at', 'desc');", false, 'la vista única, que es la correcta'],
  ];
  let malos = 0;
  for (const [src, esperado, que] of casos) {
    const dio = lee(src);
    if (dio !== esperado) { malos++; console.log(`   ✗ ${que}: esperaba ${esperado}, dio ${dio}`); }
  }
  if (malos) { console.log(`\n[X] self-test: ${malos} caso(s) mal.`); process.exit(1); }
  console.log(`OK self-test: ${casos.length} casos (3 que marcan, 3 que no — incluidos los comentarios y la vista única).`);
  process.exit(0);
}

const hallazgos = [];
const vistos = new Set();
for (const raiz of ['libs', 'apps']) {
  for (const f of archivos(raiz)) {
    const rel = f.replace(/\\/g, '/');
    if (!lee(fs.readFileSync(f, 'utf8'))) continue;
    if (PERMITIDOS[rel]) { vistos.add(rel); continue; }
    hallazgos.push(rel);
  }
}

if (hallazgos.length) {
  console.log('\n[X] Leen al Access de Control, jubilado el 2026-10-22 ([CGS.49]):\n');
  for (const f of hallazgos) console.log(`   ${f}`);
  console.log('\n   Lee `analytics.v_caja_arqueos` (Control congelado + Suite). Si de verdad hace falta el');
  console.log('   histórico crudo, agrégalo a PERMITIDOS en scripts/check-caja-sin-control.js con su motivo.\n');
  process.exit(1);
}
const sobran = Object.keys(PERMITIDOS).filter((f) => !vistos.has(f));
if (sobran.length) {
  console.log('⚠️ PERMITIDOS que ya no leen a Control (sácalos de la lista, que no quede abierta):');
  for (const f of sobran) console.log(`   ${f}`);
}
console.log(`OK caja: ningún archivo nuevo lee a Control (${vistos.size} lectura(s) del histórico, permitidas con motivo).`);
