#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * COMPUERTA: un marcador de conflicto NO se commitea.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Porque ya pasó y rompió `main`. Commit real del 2026-09-26:
 *
 *     fix([RA-PRO.60-62]): resolver marcador de conflicto en compras.service que rompia el build
 *
 * O sea: un archivo con `<<<<<<<` adentro entró al repo, nadie lo vio hasta que el build murió,
 * y hubo que gastar un commit en deshacerlo. Es el defecto más barato de atrapar que existe en
 * este repo —es texto literal, no hay heurística ni umbral— y hasta hoy NADA lo miraba:
 * `pre-commit` sólo corre gitleaks, y las 6 compuertas de `pre-push` revisan otras cosas.
 *
 * ⭐ Y duele el doble acá: medido el 2026-10-02 hay **11 sesiones** sobre el MISMO árbol de
 * trabajo. Un marcador commiteado no rompe el build de quien lo escribió: rompe el de las otras
 * diez, que ni tocaron ese archivo y van a buscar la causa donde no está.
 *
 * ── Qué cuenta como hallazgo, y por qué así ─────────────────────────────────────────────────
 *
 * Exige los TRES marcadores —apertura, separador y cierre— en el mismo archivo. No alcanza con
 * uno suelto, a propósito: `=======` solo aparece de verdad en subrayados de Markdown y en arte
 * ASCII, y `<<<<<<<` aparece en documentación que EXPLICA un conflicto (este repo tiene varias,
 * incluida la memoria del proyecto y este mismo archivo). Pedir los tres vuelve el veredicto
 * inequívoco: con los tres, es un conflicto sin resolver; con menos, es prosa.
 *
 * ⚠️ Los marcadores se arman por concatenación más abajo justamente para que este archivo no se
 *    denuncie a sí mismo. Escribirlos literales acá haría que la compuerta se marcara en cada
 *    corrida, y una compuerta que siempre sale roja se desactiva a la semana.
 *
 * Uso:
 *     node scripts/check-conflict-markers.js                 # barre el repo
 *     node scripts/check-conflict-markers.js a.ts b.ts       # sólo esos archivos
 *     node scripts/check-conflict-markers.js --self-test     # prueba negativa
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs', 'database', 'scripts', 'ops', 'docs'];
const SALTAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp', '_imported', 'graphify-out']);
const EXT = ['.ts', '.js', '.mjs', '.json', '.html', '.css', '.scss', '.sql', '.sh', '.yml', '.yaml', '.md'];

// Armados por partes: ver la advertencia de la cabecera.
const ABRE = '<'.repeat(7);
const SEPARA = '='.repeat(7);
const CIERRA = '>'.repeat(7);

/**
 * Un conflicto sin resolver, no una línea que hable de uno.
 * `git` escribe la apertura y el cierre SIEMPRE con una ref detrás (`<<<<<<< HEAD`), y el
 * separador siempre solo en su línea. Pedir esa forma descarta la prosa que los menciona.
 */
function marcadores(texto) {
  const lineas = texto.split('\n');
  const vistos = { abre: [], separa: [], cierra: [] };
  lineas.forEach((l, i) => {
    if (l.startsWith(ABRE) && l.length > 8) vistos.abre.push(i + 1);
    else if (l === SEPARA || l === SEPARA + '\r') vistos.separa.push(i + 1);
    else if (l.startsWith(CIERRA) && l.length > 8) vistos.cierra.push(i + 1);
  });
  const completo = vistos.abre.length && vistos.separa.length && vistos.cierra.length;
  return completo ? vistos : null;
}

function recorrer(dir, out) {
  let entradas;
  try {
    entradas = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entradas) {
    if (SALTAR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, out);
    else if (EXT.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

// ── Prueba negativa. Va primero y es su propio modo: una compuerta sin ella es una intención. ──
if (process.argv.includes('--self-test')) {
  const CASOS = [
    {
      que: 'conflicto completo → lo marca',
      texto: ['const a = 1;', ABRE + ' HEAD', 'const b = 2;', SEPARA, 'const b = 3;', CIERRA + ' origin/main', ''].join('\n'),
      espera: true,
    },
    {
      que: 'prosa que MENCIONA un marcador → NO lo marca',
      texto: ['Si ves ' + ABRE + ' en un archivo, es un conflicto sin resolver.', ''].join('\n'),
      espera: false,
    },
    {
      que: 'subrayado Markdown (separador suelto) → NO lo marca',
      texto: ['Titulo', SEPARA, '', 'cuerpo', ''].join('\n'),
      espera: false,
    },
    {
      que: 'apertura y cierre SIN separador → NO lo marca (no es un conflicto de git)',
      texto: [ABRE + ' algo', 'x', CIERRA + ' otro', ''].join('\n'),
      espera: false,
    },
  ];
  let ok = 0;
  for (const c of CASOS) {
    const dio = marcadores(c.texto) !== null;
    const bien = dio === c.espera;
    if (bien) ok++;
    console.log(`  ${bien ? '✓' : '✗'} ${c.que}${bien ? '' : `  (esperaba ${c.espera}, dio ${dio})`}`);
  }
  console.log(`\n${ok === CASOS.length ? '✅' : '❌'} prueba negativa: ${ok}/${CASOS.length}`);
  process.exit(ok === CASOS.length ? 0 : 1);
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const archivos = args.length
  ? args.map((a) => path.resolve(ROOT, a)).filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  : DIRS.flatMap((d) => recorrer(path.join(ROOT, d), []));

const hallazgos = [];
for (const f of archivos) {
  let texto;
  try {
    texto = fs.readFileSync(f, 'utf8');
  } catch {
    continue; // binario o ilegible: no se puede medir, y no se inventa un veredicto
  }
  const m = marcadores(texto);
  if (m) hallazgos.push({ f, m });
}

if (!hallazgos.length) {
  console.log(`✅ ${archivos.length} archivo(s): ningun marcador de conflicto sin resolver.`);
  process.exit(0);
}

console.error('\n❌ MARCADOR DE CONFLICTO SIN RESOLVER — esto rompe el build de TODAS las sesiones:\n');
for (const h of hallazgos) {
  console.error(`   ${path.relative(ROOT, h.f)}`);
  console.error(`      apertura en linea(s) ${h.m.abre.join(', ')} · cierre en ${h.m.cierra.join(', ')}`);
}
console.error('\n   Abri el archivo y resolve el bloque: quedate con un lado, con el otro, o con');
console.error('   los dos — pero sacale las tres lineas de marcador.');
console.error('   ⚠️ Resolve por BLOQUE. `git checkout --ours/--theirs` toma el archivo ENTERO y');
console.error('      tira lo que el otro lado cambio en zonas que no estaban en conflicto.\n');
process.exit(1);
