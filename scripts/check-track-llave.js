#!/usr/bin/env node
/**
 * Compuerta: un `@for` no puede usar como llave el ELEMENTO de un arreglo de relleno.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El esqueleto de carga se escribe así en todo el repo:
 *
 *     readonly skel = Array.from({ length: 8 });
 *     @for (i of skel; track i) { <div class="skel-row"></div> }
 *
 * `Array.from({ length: 8 })` sin mapeador da OCHO `undefined`: las ocho filas tienen la misma
 * llave. Angular lo avisa en la consola con NG0955 («the collection has duplicated keys») cada
 * vez que el esqueleto aparece, y con llaves repetidas deja de saber qué fila es cuál. Build
 * verde, typecheck verde, ninguna compuerta lo veía: salió al abrir Cortes en un navegador real
 * (CSU.13, 2026-10-21) y el mismo renglón estaba copiado en 27 @for de 15 archivos más.
 *
 * El arreglo correcto es `track $index`: el esqueleto no tiene identidad, su posición sí.
 * (`Array.from({ length: 8 }, (_, i) => i)` también sirve, y no se marca.)
 *
 * Lo mismo pasa con `new Array(8)` (huecos que el `@for` lee como `undefined`) y con
 * `new Array(8).fill(0)` (ocho ceros). Un arreglo literal con valores distintos
 * (`[0, 1, 2]`) no se marca: sus llaves no se repiten.
 *
 * ── Alcance ─────────────────────────────────────────────────────────────────────────────────
 * Los campos se leen del `.ts` del componente; la plantilla puede estar en ese `.ts`
 * (`template:`) o en el `.html` hermano. Tolerancia CERO: el barrido de CSU.15 dejó el repo en
 * cero y no hay deuda que congelar.
 *
 * ── Prueba negativa ─────────────────────────────────────────────────────────────────────────
 * `node scripts/check-track-llave.js --self-test` corre los casos de abajo: lo que debe marcar
 * y lo que NO. Un gate sin prueba negativa es una intención.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAICES = ['apps', 'libs'];
const IGNORAR = /(node_modules|dist|\.angular|\.nx|coverage)/;

/** Un campo cuyo valor es un arreglo de relleno: todas sus posiciones valen lo mismo. */
const RELLENO = new RegExp(
  '(?:readonly\\s+|private\\s+|protected\\s+|public\\s+)*([A-Za-z_$][\\w$]*)\\s*=\\s*(?:signal\\()?\\s*' +
    '(?:Array\\.from\\(\\{\\s*length:\\s*\\d+\\s*\\}\\)|(?:new\\s+)?Array\\(\\d+\\)(?:\\.fill\\([^)]*\\))?)' +
    '\\s*\\)?\\s*;',
  'g',
);

function camposDeRelleno(ts) {
  return new Set([...ts.matchAll(RELLENO)].map((m) => m[1]));
}

/** Devuelve [{ idx, campo, variable }] por cada `@for (v of campo; track v)` en la plantilla. */
function llavesRepetidas(plantilla, campos) {
  const out = [];
  for (const c of campos) {
    const re = new RegExp(
      `@for\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s+of\\s+(?:this\\.)?${c.replace(/\$/g, '\\$')}(?:\\(\\))?\\s*;\\s*track\\s+\\1\\s*\\)`,
      'g',
    );
    let m;
    while ((m = re.exec(plantilla))) out.push({ idx: m.index, campo: c, variable: m[1] });
  }
  return out;
}

if (process.argv.includes('--self-test')) {
  const casos = [
    ['skel = Array.from({ length: 8 });', '@for (i of skel; track i) { x }', 1],
    ['readonly skelRows = Array.from({ length: 6 });', '@for (r of skelRows; track r) {}', 1],
    ['skel = new Array(5).fill(0);', '@for (i of skel; track i) {}', 1],
    ['skel = Array(4);', '@for (i of skel; track i) {}', 1],
    ['skel = signal(Array.from({ length: 3 }));', '@for (i of skel(); track i) {}', 1],
    ['skel = Array.from({ length: 8 });', '@for (i of skel; track $index) { x }', 0],
    ['skel = Array.from({ length: 8 }, (_, i) => i);', '@for (i of skel; track i) {}', 0],
    ['skelRows = [0, 1, 2, 3];', '@for (i of skelRows; track i) {}', 0],
    ['skel = Array.from({ length: 8 });', '@for (i of skeleton; track i) {}', 0],
  ];
  let ok = true;
  for (const [ts, tpl, esperado] of casos) {
    const n = llavesRepetidas(tpl, camposDeRelleno(ts)).length;
    const bien = n === esperado;
    ok = ok && bien;
    console.log(`  ${bien ? '✔' : '✖'} ${esperado ? 'marca   ' : 'NO marca'}  ${ts}  ·  ${tpl}`);
  }
  console.log(ok ? '\n  ✔ la regla ve el rojo y no inventa' : '\n  ✖ CONTROL fallido');
  process.exit(ok ? 0 : 1);
}

function* archivos(dir) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (IGNORAR.test(p)) continue;
    if (e.isDirectory()) yield* archivos(p);
    else if (/\.ts$/.test(e.name) && !/\.(spec|d)\.ts$/.test(e.name)) yield p;
  }
}

const linea = (src, idx) => src.slice(0, idx).split('\n').length;
const hallazgos = [];
for (const raiz of RAICES) {
  for (const f of archivos(raiz)) {
    const ts = fs.readFileSync(f, 'utf8');
    if (!ts.includes('Array')) continue;
    const campos = camposDeRelleno(ts);
    if (!campos.size) continue;
    const html = f.replace(/\.ts$/, '.html');
    const fuentes = [[f, ts]];
    if (fs.existsSync(html)) fuentes.push([html, fs.readFileSync(html, 'utf8')]);
    for (const [archivo, src] of fuentes) {
      for (const h of llavesRepetidas(src, campos)) {
        hallazgos.push(`${archivo.replace(/\\/g, '/')}:${linea(src, h.idx)}  @for (${h.variable} of ${h.campo}; track ${h.variable})`);
      }
    }
  }
}

if (hallazgos.length) {
  console.error(`\n[X] ${hallazgos.length} @for con la llave repetida (NG0955 en consola; sin error de build):\n`);
  for (const h of hallazgos) console.error('   ' + h);
  console.error('\n   El campo es un arreglo de relleno: todos sus elementos valen lo mismo.');
  console.error('   -> usar track $index (el esqueleto no tiene identidad; su posición sí).\n');
  process.exit(1);
}
console.log('OK track: ningún @for usa como llave el elemento de un arreglo de relleno.');
