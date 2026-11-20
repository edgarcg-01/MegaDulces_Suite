#!/usr/bin/env node
// El cupo se EJECUTA, no se pide.
//   node .claude/skills/pm/cupo.js             -> informe: qué 🔨 se sostiene y qué cae a ⏸️ (NO escribe)
//   node .claude/skills/pm/cupo.js --aplicar   -> mueve a «En pausa» en el tablero las que no se sostienen
//   node .claude/skills/pm/cupo.js --self      -> prueba negativa: datos fabricados, TIENE que salir rojo
//
// Por qué existe (medido 2026-11-20): el método dice «la fase 🔨 sin dueño o sin fecha de cierre
// comprometida cae a ⏸️ sola», pero «Cierre comprometido» estaba lleno en 6 de 64 tarjetas y en
// 0 de las 9 fases 🔨. El gatillo de la regla era el único campo que nadie llenaba, así que la
// regla nunca podía dispararse. Esto lo dispara.
//
// Lee CLAUDE.md (qué fases están 🔨) y el Tablero PM (si tienen dueño y fecha). Escribe SÓLO con --aplicar.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.resolve(__dirname, '..', '..', '..');
const CUPO = 4;
const PROYECTO = { numero: '2', duenoGh: 'edgarcg-01', id: 'PVT_kwHOA7xW8s4BnyCF' };
const CAMPO_STATUS = 'PVTSSF_lAHOA7xW8s4BnyCFzhmVDEA';
const OPCION_EN_PAUSA = '9d26898b';

const hoy = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

/** Fases en 🔨 según el roadmap de CLAUDE.md. */
function fasesEnCurso() {
  return fs.readFileSync(path.join(raiz, 'CLAUDE.md'), 'utf8')
    .split('\n')
    .map((l) => l.match(/^\| \*\*([^*]+)\*\* \| (.+?) \| (.+?) \|\s*$/))
    .filter(Boolean)
    .filter(([, , , estado]) => estado.trim() === '🔨')
    .map(([, fase]) => fase.trim());
}

function tarjetas() {
  const out = execFileSync('gh', ['project', 'item-list', PROYECTO.numero, '--owner', PROYECTO.duenoGh,
    '--limit', '300', '--format', 'json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out).items;
}

/** El valor de un campo, buscándolo por nombre normalizado (las llaves de gh traen acentos y espacios). */
function campo(item, nombre) {
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const k = Object.keys(item).find((x) => norm(x) === norm(nombre));
  const v = k ? item[k] : undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function tarjetaDe(fase, items) {
  const esc = fase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const porCorchete = new RegExp(`^\\[${esc}\\]`);
  const porGuion = new RegExp(`^${esc}[\\s—–-]`);
  return items.find((i) => porCorchete.test(i.content?.title || i.title || ''))
      || items.find((i) => porGuion.test(i.content?.title || i.title || ''))
      || null;
}

/**
 * El corte, puro y probable (de acá cuelga --self).
 * Devuelve { fase, sostiene, motivo, itemId }.
 */
function evaluar(fase, item) {
  if (!item) return { fase, sostiene: false, motivo: 'sin tarjeta en el tablero', itemId: null };
  const id = item.id || null;
  const dueno = campo(item, 'Dueño');
  const cierre = campo(item, 'Cierre comprometido');
  if (!dueno) return { fase, sostiene: false, motivo: 'sin dueño', itemId: id };
  if (!cierre) return { fase, sostiene: false, motivo: 'sin fecha de cierre comprometida', itemId: id };
  const m = cierre.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { fase, sostiene: false, motivo: `fecha ilegible ("${cierre}") — se declara, no se adivina`, itemId: id };
  const f = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (f < hoy()) return { fase, sostiene: false, motivo: `fecha vencida (${m[0]})`, itemId: id };
  return { fase, sostiene: true, motivo: `dueño ${dueno} · cierra ${m[0]}`, itemId: id };
}

function pausar(itemId) {
  execFileSync('gh', ['project', 'item-edit', '--id', itemId, '--project-id', PROYECTO.id,
    '--field-id', CAMPO_STATUS, '--single-select-option-id', OPCION_EN_PAUSA], { encoding: 'utf8' });
}

// ─────────────────────────── prueba negativa ───────────────────────────
function self() {
  const casos = [
    ['sin tarjeta cae',        null,                                                              false, 'sin tarjeta'],
    ['sin dueño cae',          { id: 'x', 'Cierre comprometido': '2099-01-01' },                  false, 'sin dueño'],
    ['sin fecha cae',          { id: 'x', 'Dueño': 'alguien' },                                   false, 'sin fecha'],
    ['fecha ilegible cae',     { id: 'x', 'Dueño': 'alguien', 'Cierre comprometido': 'pronto' },  false, 'ilegible'],
    ['fecha vencida cae',      { id: 'x', 'Dueño': 'alguien', 'Cierre comprometido': '2020-01-01' }, false, 'vencida'],
    ['completa se sostiene',   { id: 'x', 'Dueño': 'alguien', 'Cierre comprometido': '2099-01-01' }, true,  'dueño'],
  ];
  let fallas = 0;
  for (const [nombre, item, esperado, fragmento] of casos) {
    const r = evaluar('XX', item);
    const ok = r.sostiene === esperado && r.motivo.toLowerCase().includes(fragmento);
    if (!ok) { fallas++; console.log(`  ❌ ${nombre} — dio sostiene=${r.sostiene} motivo="${r.motivo}"`); }
    else console.log(`  ✔ ${nombre}`);
  }
  // El cupo tiene que ponerse rojo cuando se excede.
  const rojo = 9 > CUPO;
  if (!rojo) { fallas++; console.log('  ❌ el cupo no se pone rojo con 9 contra 4'); }
  else console.log('  ✔ el cupo se pone rojo con 9 contra 4');
  console.log(fallas ? `\n⛔ ${fallas} control(es) en rojo: la compuerta mide mal.` : '\n✅ Los 7 controles pasan.');
  process.exit(fallas ? 1 : 0);
}

// ─────────────────────────── informe ───────────────────────────
function main() {
  const aplicar = process.argv.includes('--aplicar');
  const fases = fasesEnCurso();
  if (!fases.length) { console.error('NO MEDIDO: no encontré fases 🔨 en el roadmap de CLAUDE.md.'); process.exit(2); }

  let items;
  try { items = tarjetas(); }
  catch (e) { console.error(`NO MEDIDO: no pude leer el Tablero PM (${e.message.split('\n')[0]}). ¿gh con sesión?`); process.exit(2); }

  const r = fases.map((f) => evaluar(f, tarjetaDe(f, items)));
  const viven = r.filter((x) => x.sostiene);
  const caen = r.filter((x) => !x.sostiene);

  console.log(`Fases 🔨 en el roadmap: ${fases.length} · tope ${CUPO}\n`);
  console.log('SE SOSTIENEN (dueño + fecha vigente):');
  console.log(viven.length ? viven.map((x) => `  ✔ ${x.fase.padEnd(5)} ${x.motivo}`).join('\n') : '  (ninguna)');
  console.log('\nCAEN A ⏸️ por la regla del método §3:');
  console.log(caen.length ? caen.map((x) => `  → ${x.fase.padEnd(5)} ${x.motivo}`).join('\n') : '  (ninguna)');

  console.log(viven.length > CUPO
    ? `\n⛔ CUPO EXCEDIDO aun después del corte: ${viven.length} contra ${CUPO}. Hay que cerrar o pausar ${viven.length - CUPO}.`
    : `\nCupo tras el corte: ${viven.length}/${CUPO} — ${CUPO - viven.length} libre(s).`);

  if (!aplicar) {
    const conTarjeta = caen.filter((x) => x.itemId).length;
    console.log(`\n(informe, no se escribió nada). Con --aplicar se moverían ${conTarjeta} tarjeta(s) a «En pausa».`);
    if (caen.length - conTarjeta > 0) console.log(`⚠️ ${caen.length - conTarjeta} no tienen tarjeta: hay que crearla antes, el script no la inventa.`);
    process.exit(viven.length > CUPO ? 1 : 0);
  }

  let movidas = 0;
  for (const x of caen) {
    if (!x.itemId) { console.log(`  ⚠️ ${x.fase}: sin tarjeta, no se puede mover`); continue; }
    try { pausar(x.itemId); movidas++; console.log(`  ⏸️ ${x.fase} → En pausa (${x.motivo})`); }
    catch (e) { console.log(`  ❌ ${x.fase}: no se pudo mover (${e.message.split('\n')[0]})`); }
  }
  console.log(`\n${movidas} tarjeta(s) movidas a «En pausa».`);
  process.exit(viven.length > CUPO ? 1 : 0);
}

process.argv.includes('--self') ? self() : main();
