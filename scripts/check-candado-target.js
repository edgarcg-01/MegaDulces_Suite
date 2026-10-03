#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[VIS.1]` COMPUERTA · ningún candado puede preferir la prod VIEJA.
 *
 * Qué prohíbe, y por qué existe. Medido el 2026-10-03 sobre `database/tests/`:
 *
 *   const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
 *                           ^^^^^^^^^^^^ la prod VIEJA, primero
 *
 * **11 archivos tenían esa línea.** `FLEET_DB_URL` apunta a la Railway que dejó de ser
 * producción el 2026-09-22 y que hoy ni acepta conexiones (`ECONNRESET`), así que esos once
 * instrumentos de verdad estaban **ciegos** — y su rojo no se distinguía del rojo de un
 * defecto real.
 *
 * ⛔ Lo que NO alcanza para atraparlo: `classify()`. Las dos variables clasifican como `prod`
 * porque las dos SON prod; lo que cambia es cuál está viva. La única defensa es el ORDEN.
 *
 * No prohíbe usar `FLEET_DB_URL`: prohíbe preferirla. Como último recurso está bien, y el
 * resolvedor compartido lo dice en voz alta cuando cae ahí.
 *
 *   node scripts/check-candado-target.js            # revisa el repo
 *   node scripts/check-candado-target.js --self     # prueba negativa + control positivo
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DIR = path.join(RAIZ, 'database', 'tests');

/**
 * Marca `FLEET_DB_URL || ...DATABASE_URL_NEW` y no al revés.
 * El `[^;\n]*` evita cruzar de una sentencia a la siguiente: sin eso, dos líneas
 * independientes —una que lee FLEET y otra que lee DATABASE_URL_NEW— se leían como una sola
 * expresión y el detector marcaba archivos sanos.
 */
const MALO = /FLEET_DB_URL[^;\n]*\|\|[^;\n]*DATABASE_URL_NEW/;

function revisar(texto) {
  const malas = [];
  texto.split('\n').forEach((linea, i) => {
    if (linea.trim().startsWith('*') || linea.trim().startsWith('//')) return; // comentarios no
    if (MALO.test(linea)) malas.push({ n: i + 1, linea: linea.trim().slice(0, 100) });
  });
  return malas;
}

if (process.argv.includes('--self')) {
  console.log('\n[VIS.1] pruebas del propio detector\n');
  let ok = 0; let bad = 0;
  const t = (label, cond) => { if (cond) { ok++; console.log(`  ✔ ${label}`); } else { bad++; console.log(`  ✖ ${label}`); } };

  // NEGATIVA: la forma prohibida tiene que marcarse.
  t('marca el caso real (FLEET primero)',
    revisar('const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;').length === 1);
  // CONTROL POSITIVO: el orden bueno NO se marca. Sin esto, un detector que marca todo
  // también pasaría la prueba negativa y seria un no-op al reves.
  t('deja pasar el orden correcto',
    revisar('const URL = process.env.DATABASE_URL_NEW || process.env.FLEET_DB_URL;').length === 0);
  t('deja pasar usar FLEET sola (último recurso legítimo)',
    revisar('const u = process.env.FLEET_DB_URL;').length === 0);
  t('no cruza de una sentencia a la otra',
    revisar('const a = process.env.FLEET_DB_URL;\nconst b = process.env.DATABASE_URL_NEW;').length === 0);
  t('ignora la forma prohibida dentro de un comentario',
    revisar(' * const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;').length === 0);

  console.log(`\n=== ${ok} ✓ · ${bad} ✗ ===\n`);
  process.exit(bad ? 1 : 0);
}

const archivos = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(DIR, f))
  : [];
let total = 0;
const partes = [];
for (const f of archivos) {
  const malas = revisar(fs.readFileSync(f, 'utf8'));
  if (malas.length) {
    total += malas.length;
    partes.push(`  ${path.relative(RAIZ, f)}`);
    for (const m of malas) partes.push(`    ${m.n}: ${m.linea}`);
  }
}
/**
 * Segundo bloque, **informativo y NO bloqueante**: cuántos candados escriben sin mirar contra
 * qué base lo hacen.
 *
 * ⚠️ Se declara en vez de bloquear por una razón medida: son **63 de 127** escritores, casi
 * todos ajenos a quien toque este archivo hoy. Una compuerta que nace roja en 63 archivos no
 * se arregla: se evade con `--no-verify`, y a la semana nadie la mira. Lo que sí hace falta es
 * que el número **esté a la vista y no crezca en silencio**.
 *
 * ⛔ Es una COTA, no una cifra exacta: el detector es textual y puede contar un `.update(` que
 * no sea de knex o un `DELETE FROM` dentro de una cadena que sólo se lee. Sirve para la
 * tendencia, no para acusar a un archivo concreto sin abrirlo.
 */
function cotaEscritoresSinGuarda() {
  const ESCRIBE = /\.(insert|update|del)\(|INSERT INTO|UPDATE "|DELETE FROM/;
  const GUARDA = /assertSafeTarget|assertTarget|assertProdTarget/;
  let escriben = 0; let sinGuarda = 0;
  for (const f of archivos) {
    const txt = fs.readFileSync(f, 'utf8');
    if (!ESCRIBE.test(txt)) continue;
    escriben++;
    if (!GUARDA.test(txt)) sinGuarda++;
  }
  return { escriben, sinGuarda };
}

console.log(`\n[VIS.1] destino de los candados — ${archivos.length} archivo(s)\n`);
const cota = cotaEscritoresSinGuarda();
console.log(`  ⓘ cota (no bloquea): ${cota.sinGuarda} de ${cota.escriben} candados que escriben`);
console.log('    no declaran contra qué base lo hacen. Medido 2026-10-03: 63 de 127.\n');
if (total) {
  console.log(`  ✖ ${total} candado(s) prefieren la prod VIEJA sobre la viva:\n`);
  console.log(partes.join('\n'));
  console.log('\n  Arreglo: resolveReadTarget() de libs/platform-core/.../target-guard.js,');
  console.log('  o al menos invertir el orden — DATABASE_URL_NEW primero.\n');
  process.exit(1);
}
console.log('  ✔ ninguno prefiere la prod vieja\n');
