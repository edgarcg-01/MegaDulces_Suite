#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CSU.12]` — **El generador del índice navegable (`INDICE-AUTO`) de los documentos grandes.**
 *
 *   node scripts/docs-indices.js                  reescribe los bloques de los 7 documentos
 *   node scripts/docs-indices.js --check          exit 1 si alguno está rancio (no escribe)
 *   node scripts/docs-indices.js --probar-negativo   la compuerta se ve en rojo una vez
 *
 * ── Por qué existe, medido el 2026-10-21 ────────────────────────────────────────────────────
 *
 * `package.json` declaraba `docs:indices` y `check:docs-indices` apuntando a ESTE archivo, y el
 * archivo no existía: los dos comandos fallaban, y `CLAUDE.md` le decía a cada sesión que los
 * corriera. Sin generador, cada quien desplazaba las filas a mano —o no—, y git FUSIONA el bloque
 * línea por línea: dos ramas que lo tocaron dejan las dos versiones intercaladas. En `main`, el
 * mismo día, el log quedó con **0 de 452** filas apuntando a su encabezado y el tracker **0 de
 * 141**, dos veces seguidas. Un índice que miente manda a leer el tramo equivocado de un archivo
 * que no cabe en contexto — que es justo para lo que existe.
 *
 * ── Las reglas: las que tenían los índices buenos, no inventadas ────────────────────────────
 *
 * Reproduce IDÉNTICO el índice de los 7 documentos en `ceaa4d6d2` (el último bueno medido), salvo
 * dos cosas que estaban mal ahí y este generador corrige: el encabezado de GOTCHAS (decía 260 KB y
 * medía 263) y una entrada del log (`[CB.52]`) que alguien agregó sin fila. Lo que se aprendió:
 *   · una fila por encabezado de nivel ≤ `niveles` (ERP_KEPLER: 3; el resto: 2), en orden;
 *   · un encabezado dentro de una cerca de código CUENTA (así eran: GOTCHAS y el log tienen uno);
 *   · `Hasta` = la línea antes del siguiente encabezado de esos niveles, tenga fila o no;
 *   · KB = caracteres del tramo / 1024 redondeado, mínimo 1; título cortado a 110, `|` escapado;
 *   · el bloque mide 11 + filas líneas, y las cifras de la cabecera son las del cuerpo sin el bloque;
 *   · `omitir`: encabezados que nunca tuvieron fila (el kanban del tracker, la plantilla del log).
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DOCS = [
  { archivo: 'docs/ERP_KEPLER.md', niveles: 3, omitir: [] },
  { archivo: 'docs/GOTCHAS.md', niveles: 2, omitir: [] },
  { archivo: 'docs/UNIDADES_DE_MEDIDA.md', niveles: 2, omitir: [] },
  { archivo: 'docs/VERDAD_ABSOLUTA.md', niveles: 2, omitir: [] },
  { archivo: 'docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md', niveles: 2,
    omitir: ['## 👀 EN REVISIÓN', '## ✅ HECHO', '## 📋 BACKLOG — Fases G, H, I'] },
  { archivo: 'docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md', niveles: 2,
    omitir: ['# Resumen de ADRs movido de CLAUDE.md (2026-10-14)'] },
  { archivo: 'docs/IMPLEMENTACION/03_LOG_REVISIONES.md', niveles: 2, omitir: ['## Plantilla de entrada'] },
];

const INICIO = '<!-- INDICE-AUTO:INICIO -->';
const FIN = '<!-- INDICE-AUTO:FIN -->';
const corto = (t) => t.slice(0, 110).replace(/\|/g, '\\|');

/** Genera el texto completo del documento con su bloque recalculado (LF). */
function generar(texto, cfg) {
  const lines = texto.split('\n');
  // ⚠️ Un bloque roto por una fusión puede traer líneas intercaladas: se toma del PRIMER inicio al
  // PRIMER fin posterior y se descarta entero. Lo que importa es el cuerpo.
  const ini = lines.findIndex((l) => l.includes(INICIO));
  const fin = lines.findIndex((l, i) => i > ini && l.includes(FIN));
  const cuerpo = ini === 0 && fin > 0 ? lines.slice(fin + 1) : lines;
  const re = new RegExp(`^#{1,${cfg.niveles}} `);
  const omitir = new Set(cfg.omitir);
  const encs = cuerpo.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  const conFila = encs.filter((i) => !omitir.has(cuerpo[i]));
  const desplaz = 11 + conFila.length;
  const filas = conFila.map((i) => {
    const sig = encs.find((j) => j > i);
    const hasta = sig === undefined ? cuerpo.length - 1 : sig - 1;
    const kb = Math.max(1, Math.round(cuerpo.slice(i, hasta + 1).join('\n').length / 1024));
    return `| ${i + 1 + desplaz} | ${hasta + 1 + desplaz} | ${kb} | ${corto(cuerpo[i].replace(/^#+ /, ''))} |`;
  });
  const sin = cuerpo.join('\n');
  const bloque = [
    INICIO,
    '',
    `> **Índice navegable** — ${Math.round(sin.length / 1024)} KB, ${sin.split('\n').length - 1} líneas, ${filas.length} secciones.`,
    '> ⛔ **No intentes leer este archivo entero: no cabe en una ventana de contexto.**',
    `> Buscá tu tema acá y leé sólo ese tramo: \`sed -n 'DESDE,HASTAp' ${cfg.archivo}\`.`,
    '> Lo genera `npm run docs:indices` — no lo edites a mano.',
    '',
    '| Desde | Hasta | KB | Sección |',
    '|---:|---:|---:|---|',
    ...filas,
    '',
    FIN,
  ];
  return [...bloque, ...cuerpo].join('\n');
}

const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
module.exports = { generar, DOCS };

// Sólo como comando: requerirlo desde otro script NO debe reescribir documentos.
if (require.main === module) principal();

function principal() {
if (process.argv.includes('--probar-negativo')) {
  // Un documento con su índice al día tiene que dar "igual"; con una fila corrida, "distinto".
  const doc = ['# Uno', 'a', '## Dos', 'b', '### tres (no cuenta)', '## Cuatro', 'c'].join('\n');
  const cfg = { archivo: 'x.md', niveles: 2, omitir: [] };
  const bueno = generar(doc, cfg);
  let fallas = 0;
  if (generar(bueno, cfg) !== bueno) { console.error('  ✗ regenerar un índice al día lo cambió'); fallas++; }
  const roto = bueno.replace(/^\| (\d+) \|/m, (_, n) => `| ${Number(n) + 1} |`);
  if (generar(roto, cfg) === roto) { console.error('  ✗ NO detectó una fila corrida'); fallas++; }
  const intercalado = bueno.replace('| Desde |', `${bueno.split('\n')[2]}\n| Desde |`); // cabecera duplicada, como dejó la fusión
  if (generar(intercalado, cfg) !== bueno) { console.error('  ✗ un bloque intercalado no se reparó'); fallas++; }
  const filas = bueno.split('\n').filter((l) => /^\| \d/.test(l)).length;
  if (filas !== 3) { console.error(`  ✗ esperaba 3 filas (# Uno, ## Dos, ## Cuatro) y hay ${filas}`); fallas++; }
  if (fallas) process.exit(1);
  console.log('✓ prueba negativa: un índice al día no cambia, una fila corrida y un bloque intercalado se detectan y se reparan.');
  process.exit(0);
}

const CHECK = process.argv.includes('--check');
let rancios = 0;
for (const cfg of DOCS) {
  const crudo = leer(cfg.archivo);
  const crlf = crudo.includes('\r\n');
  const actual = crlf ? crudo.split('\r\n').join('\n') : crudo;
  const nuevo = generar(actual, cfg);
  if (nuevo === actual) { console.log(`·  ${cfg.archivo} — al día`); continue; }
  rancios++;
  if (CHECK) console.log(`⛔ ${cfg.archivo} — índice RANCIO: corré \`npm run docs:indices\``);
  else {
    fs.writeFileSync(path.join(RAIZ, cfg.archivo), crlf ? nuevo.split('\n').join('\r\n') : nuevo);
    console.log(`✓ ${cfg.archivo} — regenerado`);
  }
}
if (CHECK && rancios) { console.log(`\n⛔ ${rancios} índice(s) rancio(s).`); process.exit(1); }
}
