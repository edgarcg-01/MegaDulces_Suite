/* eslint-disable no-console */
/**
 * `[AUD-DAT.23]` — **Ningun comentario SQL lleva acentos graves.**
 *
 * ── DE DONDE SALE ESTA COMPUERTA ──────────────────────────────────────────────────────────
 * El 2026-10-02, por septima vez en el proyecto, un acento grave dentro de un comentario
 * rompio el build. Esta vez con una diferencia que vale: **se commiteo, llego a origin/main y
 * freno el despliegue**. El job de build del PR murio, `ci-green` no se sello, y `auto-deploy`
 * se nego a desplegar. El costo dejo de ser "90 s de build" para ser la tuberia parada.
 *
 * El culpable, en un knex.raw de un servicio de NestJS:
 *
 *      -- [RA-DYN.U3] El piso de la orden...        <- con la etiqueta entre acentos graves
 *
 * El literal se cierra ahi y TypeScript lee el resto como codigo:
 *      TS2304: Cannot find name 'RA'.  ·  TS2304: Cannot find name 'DYN'.
 *      TS2349: This expression is not callable.     (a 212 lineas de distancia)
 *
 * ── POR QUE NO ALCANZABA LA COMPUERTA QUE YA EXISTIA ─────────────────────────────────────
 * `npm run check:templates` recorre **solo `*.component.ts`** (su `walk()` filtra por ese
 * sufijo). Escaneo 368 componentes y dio verde: el archivo roto es un **servicio**, queda
 * fuera de su alcance por construccion.
 *
 * ⭐ Una compuerta que pasa en verde sobre un archivo que NO inspecciona se lee igual que una
 * que lo aprobo. La pregunta "¿ya hay una compuerta y no la estoy corriendo?" tiene una
 * segunda mitad: **¿y alcanza a este archivo?**
 *
 * ── POR QUE ESTA REGLA ES SEGURA (no da falsos positivos) ────────────────────────────────
 * Un comentario SQL (`--`) con un acento grave **nunca** es legitimo en este repo: o esta
 * dentro de un template literal y lo rompe, o esta en SQL suelto donde el acento grave no
 * significa nada (Postgres usa comillas dobles para identificar, no acentos graves).
 *
 * Medido el 2026-10-02 sobre el repo entero: 0 ocurrencias con el arreglo puesto, y la
 * version rota que el CI compilo da exactamente 1. Ver la prueba negativa abajo.
 *
 *   node scripts/check-sql-backticks.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['apps', 'libs', 'database', 'scripts', 'ops'];
const SALTAR = new Set(['node_modules', 'dist', '.git', '.nx', 'coverage', 'tmp', '_imported']);
const EXT = ['.ts', '.js'];

/** Un comentario SQL de linea con un acento grave sin escapar. */
const SOSPECHOSA = (linea) => {
  const t = linea.trimStart();
  if (!t.startsWith('--')) return false;
  // Se ignoran los que YA estan escapados: dentro de un literal, \` es inofensivo.
  return /[^\\]`/.test(t) || t.startsWith('--`');
};

function recorrer(dir, out) {
  let entradas;
  try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entradas) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SALTAR.has(e.name)) continue;
      recorrer(full, out);
    } else if (EXT.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const archivos = args.length
  ? args.map((f) => path.resolve(ROOT, f))
  : DIRS.flatMap((d) => recorrer(path.join(ROOT, d), []));

const hallazgos = [];
for (const f of archivos) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!txt.includes('--')) continue;
  txt.split(/\r?\n/).forEach((linea, i) => {
    if (SOSPECHOSA(linea)) {
      hallazgos.push({ f: path.relative(ROOT, f), n: i + 1, t: linea.trim().slice(0, 110) });
    }
  });
}

// ── PRUEBA NEGATIVA: la regla tiene que marcar el caso real y dejar pasar el escapado ──────
// Sin esto seria una intencion: nacio en verde sobre un repo que yo acababa de limpiar.
const NEG = [
  { linea: '        -- `[RA-DYN.U3]` El piso de la orden.', esperado: true, que: 'el caso REAL del 2026-10-02' },
  { linea: '        -- \\`MATERIALIZED\\` NO ES ADORNO', esperado: false, que: 'un acento grave YA escapado' },
  { linea: '        -- la "caja" no aplica aca', esperado: false, que: 'comillas dobles, la forma correcta' },
  { linea: '        const x = `select 1`;', esperado: false, que: 'un literal normal, que no es comentario' },
];
let negOk = 0;
for (const c of NEG) {
  const r = SOSPECHOSA(c.linea);
  if (r === c.esperado) { negOk++; } else {
    console.log(`  ✖ negativa fallida (${c.que}): esperaba ${c.esperado} y dio ${r}`);
  }
}

console.log(`\n[AUD-DAT.23] Acentos graves en comentarios SQL — ${archivos.length} archivo(s)\n`);
console.log(`  ${negOk === NEG.length ? '✔' : '✖'} las ${NEG.length} pruebas negativas (marca el caso real, deja pasar el escapado)`);

if (hallazgos.length === 0) {
  console.log('  ✔ ningun comentario SQL lleva acentos graves sin escapar\n');
  process.exit(negOk === NEG.length ? 0 : 1);
}

console.log(`  ✖ ${hallazgos.length} comentario(s) SQL con acento grave — rompen el template literal que los contiene:\n`);
for (const h of hallazgos) console.log(`      ${h.f}:${h.n}\n        ${h.t}`);
console.log('\n  Arreglo: el identificador va PELADO o entre comillas dobles. -- [TICKET] algo\n');
process.exit(1);
