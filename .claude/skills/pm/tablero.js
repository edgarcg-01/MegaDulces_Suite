#!/usr/bin/env node
// Tablero del PM: cuenta, no recuerda.
//   node .claude/skills/pm/tablero.js            -> fases del roadmap por estado + FLUJO (entran vs salen de 🔨)
//   node .claude/skills/pm/tablero.js CGA VAC    -> además, items del tracker por estado de esas fases
//   node .claude/skills/pm/tablero.js --self     -> prueba negativa del flujo: tablas fabricadas, tiene que salir rojo si mide mal
// Sólo lee archivos del repo. No toca la base ni la red.
//
// ⛔ NO HAY TOPE DE FASES 🔨 (Edgar, 2026-11-27). El tope de 4 existió del 2026-10-14 al 2026-11-27
// y se saltó ocho veces sin cerrar una sola fase: medido ese día, en 90 días entraron 12 fases a 🔨
// y salieron CERO. Un límite que no limita sólo produce el renglón «abierta por encima del cupo».
// Lo que se publica en su lugar es el FLUJO, que es el cuello de verdad: no cuántas hay abiertas,
// sino que se abren más de las que se cierran. El flujo informa; no bloquea a nadie.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.resolve(__dirname, '..', '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const ESTADOS = ['🟢', '🚀', '🧪', '🔨', '🟡', '🔴', '⏸️', '⬜'];
const FILA = /^\| \*\*([^*]+)\*\* \| (.+?) \| (.+?) \|\s*$/;

/** La tabla del roadmap de un texto de CLAUDE.md, como Map(fase -> estado). */
function tabla(texto) {
  const m = new Map();
  for (const l of texto.split('\n')) {
    const x = l.match(FILA);
    if (x) m.set(x[1].trim(), x[3].trim());
  }
  return m;
}

/**
 * El flujo entre dos fotos de la tabla (de acá cuelga --self).
 * ⭐ Una fase 🔨 que DESAPARECE de la tabla también salió: el 2026-11-06 se retiraron 23 fases
 * entregadas de una vez, y no contarlas inflaría el saldo. Medido ese día: de esas 23, 0 estaban 🔨.
 */
function flujo(antes, ahora) {
  const entraron = [], salieron = [], nuevas = [], retiradas = [];
  for (const [fase, est] of ahora) {
    const prev = antes.get(fase);
    if (prev === undefined) { if (est === '🔨') nuevas.push(fase); continue; }
    if (prev !== '🔨' && est === '🔨') entraron.push(`${fase} (${prev}→🔨)`);
    if (prev === '🔨' && est !== '🔨') salieron.push(`${fase} (🔨→${est})`);
  }
  for (const [fase, prev] of antes) if (prev === '🔨' && !ahora.has(fase)) retiradas.push(`${fase} (retirada)`);
  const abren = [...entraron, ...nuevas.map((f) => `${f} (nueva)`)];
  const cierran = [...salieron, ...retiradas];
  return { abren, cierran, saldo: abren.length - cierran.length };
}

function medirFlujo(dias) {
  let revs;
  try {
    revs = execFileSync('git', ['log', `--since=${dias}.days`, '--format=%h', '--', 'CLAUDE.md'],
      { cwd: raiz, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { return null; }
  if (!revs.length) return null;
  const base = revs[revs.length - 1];
  try {
    const antes = tabla(execFileSync('git', ['show', `${base}:CLAUDE.md`],
      { cwd: raiz, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
    if (!antes.size) return null;
    return { base, ...flujo(antes, tabla(leer('CLAUDE.md'))) };
  } catch { return null; }
}

// ─────────────────────────── prueba negativa ───────────────────────────
function self() {
  const T = (o) => new Map(Object.entries(o));
  const casos = [
    ['abrir una nueva cuenta como apertura',
      T({ A: '⬜' }), T({ A: '⬜', B: '🔨' }), 1, 0],
    ['pasar de 🧪 a 🔨 cuenta como apertura',
      T({ A: '🧪' }), T({ A: '🔨' }), 1, 0],
    ['pasar de 🔨 a ⏸️ cuenta como cierre',
      T({ A: '🔨' }), T({ A: '⏸️' }), 0, 1],
    ['pasar de 🔨 a ✅/🚀 cuenta como cierre',
      T({ A: '🔨' }), T({ A: '🚀' }), 0, 1],
    ['⭐ una 🔨 RETIRADA de la tabla cuenta como cierre',
      T({ A: '🔨' }), T({}), 0, 1],
    ['⭐ una NO-🔨 retirada NO cuenta (el caso de las 23 entregadas)',
      T({ A: '🚀' }), T({}), 0, 0],
    ['sin cambios, saldo 0',
      T({ A: '🔨', B: '⏸️' }), T({ A: '🔨', B: '⏸️' }), 0, 0],
  ];
  let fallas = 0;
  for (const [nombre, antes, ahora, espAbren, espCierran] of casos) {
    const r = flujo(antes, ahora);
    const ok = r.abren.length === espAbren && r.cierran.length === espCierran;
    if (!ok) { fallas++; console.log(`  ❌ ${nombre} — dio abren=${r.abren.length} cierran=${r.cierran.length}, esperaba ${espAbren}/${espCierran}`); }
    else console.log(`  ✔ ${nombre}`);
  }
  console.log(fallas ? `\n⛔ ${fallas} control(es) en rojo: el flujo mide mal.` : `\n✅ Los ${casos.length} controles pasan.`);
  process.exit(fallas ? 1 : 0);
}
if (process.argv.includes('--self')) self();

// ─────────────────────────── 1. Roadmap ───────────────────────────
const filas = [...tabla(leer('CLAUDE.md'))].map(([fase, estado]) => ({ fase, estado }));
if (filas.length === 0) {
  console.error('NO MEDIDO: no encontré la tabla de roadmap en CLAUDE.md (¿cambió el formato?)');
  process.exit(2);
}

const porEstado = {};
for (const f of filas) (porEstado[f.estado] ||= []).push(f.fase);

console.log(`Roadmap (CLAUDE.md): ${filas.length} fases`);
for (const e of ESTADOS.concat(Object.keys(porEstado).filter((k) => !ESTADOS.includes(k)))) {
  if (porEstado[e]) console.log(`  ${e}  ${String(porEstado[e].length).padStart(2)}  ${porEstado[e].join(' · ')}`);
}
console.log(`\nEn curso: ${(porEstado['🔨'] || []).length} fases 🔨 (sin tope — Edgar, 2026-11-27).`);

// ─────────────────────────── 2. El flujo, que es el cuello ───────────────────────────
console.log('\nFLUJO — se abre más de lo que se cierra, o no:');
for (const dias of [30, 90]) {
  const f = medirFlujo(dias);
  if (!f) { console.log(`  ${String(dias).padStart(2)} días: NO MEDIDO (sin historia de CLAUDE.md en la ventana)`); continue; }
  const signo = f.saldo > 0 ? '+' : '';
  console.log(`  ${String(dias).padStart(2)} días (base ${f.base}): abren ${f.abren.length} · cierran ${f.cierran.length} · saldo ${signo}${f.saldo}`);
  if (f.abren.length) console.log(`        abren:   ${f.abren.join(' · ')}`);
  if (f.cierran.length) console.log(`        cierran: ${f.cierran.join(' · ')}`);
  if (f.saldo > 0) console.log(`     ⚠️ El tablero CRECIÓ ${f.saldo} en ${dias} días: entra más trabajo del que sale.`);
}
console.log('\n⭐ 🧪 no es cerrar. Cierra ✅ (prod), ⏸️ (declarada en pausa) o ❌.');

// ─────────────────────────── 3. Tracker ───────────────────────────
const prefijos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (prefijos.length) {
  const tracker = leer('docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md').split('\n');
  const SIMB = ['✅', '🚀', '🧪', '🔨', '⬜', '⚠️', '❌', '🔧'];
  for (const p of prefijos) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s*- \\[[ x]\\] \\*\\*\\[' + esc + '[.\\-]');
    const items = tracker.filter((l) => re.test(l));
    const cuenta = {};
    for (const l of items) {
      const tras = l.replace(/^.*?\*\*\[[^\]]+\]\*\*\s*/, '');
      const s = SIMB.find((x) => tras.startsWith(x)) || 'sin estado';
      cuenta[s] = (cuenta[s] || 0) + 1;
    }
    const resumen = Object.entries(cuenta).map(([s, n]) => `${s} ${n}`).join(' · ');
    let commits = 'NO MEDIDO';
    try {
      // El código termina en . - o ]: si no, "[G" contaría los commits de [GX] y de [GP].
      const pat = '\\[' + esc + '[].-]';
      commits = execFileSync('git', ['log', '--since=60.days', '--oneline', '-E', '--grep=' + pat], { cwd: raiz, encoding: 'utf8' })
        .split('\n').filter(Boolean).length;
    } catch { /* sin git: se declara, no se dibuja 0 */ }
    console.log(`\nTracker [${p}.*]: ${items.length} items${items.length ? ' — ' + resumen : ''} · commits 60 días: ${commits}`);
    if (!items.length && commits > 0) console.log(`  ⚠️ Hay commits de [${p}] sin items en el tracker: el trabajo no está registrado.`);
    if (!items.length && !commits) console.log('  NO ENCONTRADO: revisá el prefijo.');
  }
}
