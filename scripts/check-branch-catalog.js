#!/usr/bin/env node
/**
 * Compuerta: la lista de SUCURSALES no se escribe a mano en ningún lado.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Esta familia falla **en silencio y hacia abajo**: un proceso que recorre menos sucursales de
 * las que hay no da error, no baja el latido y no puede reportar faltantes — una rama que no
 * mira no puede faltarle nada. El tablero sale verde mientras la sucursal queda invisible.
 *
 * Lo que ya costó, medido:
 *   · 2026-09-23 · `reconcile-ods-window.js` tenía `'00,01,02,03,04,05,06'` (SIETE) cuando el
 *     negocio ya tenía nueve. Es el ÚNICO proceso que propaga DELETEs al ODS, y el único
 *     contenedor que no declara `ODS_LIVE_BRANCHES`, así que caía a ese default: Morelia Madero
 *     (07) y Morelia Abastos (08) NUNCA se reconciliaron. En la 08, `kdpord` publicaba 4,603
 *     filas contra 1,669 reales — 2,934 borradas en el origen que el ODS seguía sirviendo.
 *     El reporte decía "filas ausentes: 0".
 *   · Antes · Morelia Abastos quedó fuera de `mv_sales_blended` por el mismo motivo: una lista
 *     de sucursales repetida a mano. $1.64M de venta invisibles. Fix: `v_branch_erp_cutover`.
 *
 * ── Qué exige ───────────────────────────────────────────────────────────────────────────────
 * Que la lista salga de `database/importers/lib/kepler-branches.js` (el catálogo canónico) y no
 * de una cadena literal. Una sucursal nueva se agrega AHÍ y llega sola a todos lados.
 *
 * `ODS_LIVE_BRANCHES` sigue siendo válido como ESCAPE de entorno para correr un subconjunto a
 * mano; lo que no se permite es que el valor por DEFECTO sea una lista escrita a mano.
 *
 * ── Prueba negativa ─────────────────────────────────────────────────────────────────────────
 *   node scripts/check-branch-catalog.js --probar-negativo
 * Inyecta una lista literal en memoria y verifica que la compuerta se ponga ROJA. Sin esto, una
 * compuerta es una intención: podría estar buscando algo que ya no existe y salir verde siempre.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const CATALOGO = path.join('database', 'importers', 'lib', 'kepler-branches.js');
const DIRS = ['database', 'services', 'libs', 'apps', 'ops'];
const EXT = new Set(['.js', '.ts', '.mjs', '.cjs', '.yml', '.yaml']);

/**
 * Una lista de sucursales escrita a mano: tres o más códigos de dos dígitos separados por coma,
 * entre comillas. Pide TRES para no confundirse con un par legítimo como `'00,01'` de una prueba.
 */
const LISTA_A_MANO = /['"]\s*\d{2}\s*(?:,\s*\d{2}\s*){2,}['"]/;

/** Rutas que pueden tener la lista literal, con el motivo. Nada entra acá sin una razón escrita. */
const PERMITIDO = [
  // El catálogo canónico ES la lista. Es el único lugar donde los códigos se escriben.
  { re: /^database[\\/]importers[\\/]lib[\\/]kepler-branches\.js$/, por: 'es el catálogo canónico' },
  // El stack viejo de `.249`, que se está retirando (Fase VL). No se toca; se declara.
  { re: /^ops[\\/]ingest[\\/]/, por: 'stack legado de .249, en retiro (VL.7)' },
  // Las pruebas NECESITAN listas literales: son el dato de entrada del caso. Una prueba que
  // derivara del catálogo dejaría de probar lo que pasa cuando llegan códigos raros.
  { re: /[\\/]tests?[\\/]|\.spec\.(ts|js)$|[\\/]test-[^\\/]+\.js$/, por: 'fixture de prueba' },
  // ⚠️ Wincaja tiene su PROPIO universo de sucursales (00/30/32, que son cajas, no las ramas
  // Kepler). Derivarlo de `kepler-branches` sería peor que la copia: mezclaría dos catálogos.
  { re: /[\\/]importers[\\/]wincaja[\\/]/, por: 'catálogo Wincaja, distinto de las ramas Kepler' },
];

/** ¿el match cae dentro de un comentario? Cubre `//`, `#`, y `/* … *\/` en la misma línea. */
function enComentario(linea, indice) {
  const antes = linea.slice(0, indice);
  if (/\/\/|#/.test(antes)) return true;            // comentario de línea abierto antes del match
  const abre = antes.lastIndexOf('/*');
  return abre !== -1 && antes.indexOf('*/', abre) === -1; // bloque abierto y no cerrado antes
}

function archivos(dir) {
  const salida = [];
  const pila = [dir];
  while (pila.length) {
    const d = pila.pop();
    let entradas;
    try { entradas = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) pila.push(p);
      else if (EXT.has(path.extname(e.name))) salida.push(p);
    }
  }
  return salida;
}

/** Devuelve los hallazgos: {archivo, linea, texto}. `leer` se inyecta para poder probar en negativo. */
function buscar(leer = (p) => fs.readFileSync(p, 'utf8')) {
  const hallazgos = [];
  for (const d of DIRS) {
    for (const abs of archivos(path.join(RAIZ, d))) {
      const rel = path.relative(RAIZ, abs);
      if (PERMITIDO.some((p) => p.re.test(rel))) continue;
      let texto;
      try { texto = leer(abs); } catch { continue; }
      texto.split(/\r?\n/).forEach((linea, i) => {
        // Un comentario que DOCUMENTA el bug viejo no es el bug. Se permite a propósito:
        // borrar la cita borraría la evidencia de por qué existe esta compuerta.
        if (/^\s*(\/\/|\*|#)/.test(linea)) return;
        const m = LISTA_A_MANO.exec(linea);
        if (m && !enComentario(linea, m.index)) {
          hallazgos.push({ archivo: rel, linea: i + 1, texto: linea.trim().slice(0, 110) });
        }
      });
    }
  }
  return hallazgos;
}

function main() {
  if (!fs.existsSync(path.join(RAIZ, CATALOGO))) {
    console.error(`✖ no existe el catálogo canónico ${CATALOGO} — la compuerta no puede juzgar nada.`);
    process.exit(2);
  }

  if (process.argv.includes('--probar-negativo')) {
    const falso = path.join(RAIZ, 'database', 'importers', 'kepler', 'reconcile-ods-window.js');
    const inyectado = buscar((p) => (p === falso
      ? "const X = (process.env.ODS_LIVE_BRANCHES || '00,01,02,03,04,05,06');"
      : fs.readFileSync(p, 'utf8')));
    if (!inyectado.length) {
      console.error('✖ PRUEBA NEGATIVA FALLÓ: se inyectó una lista a mano y la compuerta NO la vio.');
      process.exit(1);
    }
    console.log(`✔ prueba negativa OK — la compuerta se puso roja con la lista inyectada (${inyectado.length} hallazgo).`);
    return;
  }

  const hallazgos = buscar();
  if (hallazgos.length) {
    console.error('✖ Lista de sucursales escrita a mano. Derivala de ' + CATALOGO + ':\n');
    for (const h of hallazgos) console.error(`   ${h.archivo}:${h.linea}\n     ${h.texto}`);
    console.error('\n   Una sucursal nueva se agrega en el catálogo y llega sola a todos lados.');
    console.error('   `ODS_LIVE_BRANCHES` sigue valiendo como escape de entorno; lo que no vale');
    console.error('   es que el valor POR DEFECTO sea una lista a mano.');
    process.exit(1);
  }

  const { BRANCHES } = require(path.join(RAIZ, CATALOGO));
  console.log(`✔ ninguna lista de sucursales a mano · catálogo canónico: ${BRANCHES.length} ramas `
    + `(${BRANCHES.map((b) => b.code).join(',')})`);
}

main();
