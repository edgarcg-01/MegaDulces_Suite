#!/usr/bin/env node
// Auditoría del tablero PM contra sus propias reglas. SÓLO LEE (GitHub + CLAUDE.md), no cambia nada.
//   node .claude/skills/pm/auditar-tablero.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const raiz = path.resolve(__dirname, '..', '..', '..');
const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 << 20 });
const OWNER = 'edgarcg-01', REPO = 'edgarcg-01/MegaDulces_PM', TOPE = 4;
const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const dias = (iso) => iso ? Math.round((new Date(hoy) - new Date(iso)) / 864e5) : null;
const campo = (i, re) => Object.entries(i).find(([k]) => re.test(k))?.[1];

const items = JSON.parse(gh(['project', 'item-list', '2', '--owner', OWNER, '--limit', '400', '--format', 'json'])).items;
const issues = JSON.parse(gh(['issue', 'list', '-R', REPO, '--state', 'all', '--limit', '400', '--json', 'number,title,state,assignees,labels']));
const porNum = Object.fromEntries(issues.map((x) => [x.number, x]));
const vistas = JSON.parse(gh(['api', 'graphql', '-f', `query={ user(login:"${OWNER}"){ projectV2(number:2){ views(first:30){ nodes { name layout } } } } }`])).data.user.projectV2.views.nodes;
const roadmap = Object.fromEntries(fs.readFileSync(path.join(raiz, 'CLAUDE.md'), 'utf8').split('\n')
  .map((l) => l.match(/^\| \*\*([^*]+)\*\* \| .+? \| (.+?) \|\s*$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const EQUIV = { '🔨': ['En curso'], '🟡': ['En curso'], '🧪': ['Probado'], '🚀': ['En producción'], '🟢': ['Cerrado'], '⏸️': ['En pausa'], '⬜': ['Por hacer'], '🔴': ['Por hacer'] };
const prioEsperada = (d, e) => {
  const D = /^Alto/.test(d || '') ? 'A' : /^Medio/.test(d || '') ? 'M' : /^Bajo/.test(d || '') ? 'B' : null;
  const E = (e || '').slice(0, 2).trim();
  if (!D || !E) return null;
  if (D === 'A') return ['S', 'M'].includes(E) ? 1 : 2;
  if (D === 'M') return E === 'S' ? 2 : E === 'XL' ? 4 : 3;
  return E === 'S' ? 3 : 4;
};

const H = {};
const anota = (regla, txt) => (H[regla] ||= []).push(txt);
const vivas = items.filter((i) => !['Cerrado'].includes(i.status));
const fasesEnCurso = items.filter((i) => i.status === 'En curso' && (i.labels || []).includes('fase'));

for (const i of items) {
  const n = i.content.number, t = i.content.title, cod = (t.match(/^\[([^\]]+)\]/) || [])[1] || '?';
  const id = `#${n} [${cod}]`;
  const iss = porNum[n] || {};
  const labels = i.labels || [];
  const dueno = campo(i, /^due/i), rev = campo(i, /revisi/i), prio = campo(i, /^prioridad$/i);
  const dinero = campo(i, /dinero/i), esf = campo(i, /esfuerzo/i), semana = campo(i, /^semana$/i);
  if (labels.includes('sub-tarea') || labels.includes('auto-error')) anota('Sub-tarea o error automático metido como tarjeta', id);
  if (!labels.length) anota('Sin etiqueta de tipo', id);
  if (!i.status) anota('Sin Status', id);
  if (i.status === 'Cerrado' && iss.state === 'OPEN') anota('Status Cerrado pero la issue sigue ABIERTA', id);
  if (i.status !== 'Cerrado' && iss.state === 'CLOSED') anota('Issue CERRADA pero el Status no es Cerrado', `${id} (${i.status})`);
  if (i.status === 'En curso') {
    if (!dueno) anota('En curso SIN dueño', id);
    if (!semana) anota('En curso sin Semana', id);
    if (!rev) anota('En curso sin Última revisión', id);
    else if (dias(rev) > 14) anota('En curso sin revisión hace > 14 días', `${id} (${rev})`);
    if (!campo(i, /m[ée]trica/i) && labels.includes('fase')) anota('Fase en curso sin Métrica (hoy → meta)', id);
  }
  if (i.status !== 'Cerrado' && i.status !== 'En pausa') {
    if (!prio) anota('Activa sin Prioridad', `${id} (${i.status})`);
    if (!dinero || !esf) anota('Activa sin Dinero en juego o sin Esfuerzo', `${id} (${i.status})`);
    const esperada = prioEsperada(dinero, esf);
    const actual = prio ? Number(String(prio)[0]) : null;
    if (esperada && actual != null && actual !== 0 && actual !== esperada) anota('Prioridad que NO sale de la tabla dinero × esfuerzo', `${id}: dice ${actual}, la tabla da ${esperada} (${(dinero || '').split(' ')[0]} × ${(esf || '').split(' ')[0]})`);
  }
  if (dueno && /^[A-Za-z0-9-]+$/.test(dueno) && iss.assignees && !iss.assignees.some((a) => a.login === dueno) && dueno !== 'Edgar' && i.status !== 'Cerrado')
    anota('Dueño en el campo pero NO asignado en GitHub', `${id} → ${dueno}`);
  if (dueno === 'Edgar' && iss.assignees && !iss.assignees.some((a) => a.login === 'edgarcg-01') && i.status !== 'Cerrado') anota('Dueño en el campo pero NO asignado en GitHub', `${id} → Edgar`);
  if (roadmap[cod] && i.status && !(EQUIV[roadmap[cod]] || []).includes(i.status) && labels.includes('fase'))
    anota('El roadmap de CLAUDE.md dice otra cosa que el tablero', `${id}: roadmap ${roadmap[cod]} · tablero ${i.status}`);
}
// La regla dinero × esfuerzo a nivel tablero: ¿se trabaja lo de prioridad baja antes que lo de alta?
const prioNum = (i) => { const p = campo(i, /^prioridad$/i); return p ? Number(String(p)[0]) : null; };
const altasSinTrabajar = vivas.filter((i) => [0, 1].includes(prioNum(i)) && i.status !== 'En curso' && i.status !== 'En pausa');
const bajasEnCurso = items.filter((i) => i.status === 'En curso' && prioNum(i) === 4);
if (altasSinTrabajar.length && bajasEnCurso.length) anota('Se trabaja prioridad 4 mientras prioridad 0–1 espera', `en curso P4: ${bajasEnCurso.map((i) => '#' + i.content.number).join(', ')} · esperando P0–1: ${altasSinTrabajar.map((i) => '#' + i.content.number).join(', ')}`);
const codigos = {};
for (const i of items) { const c = (i.content.title.match(/^\[([^\]]+)\]/) || [])[1]; if (c) (codigos[c] ||= []).push('#' + i.content.number); }
for (const [c, ns] of Object.entries(codigos)) if (ns.length > 1) anota('Código repetido en dos tarjetas', `[${c}] ${ns.join(', ')}`);
const nombresVista = vistas.map((v) => v.name);
for (const quiero of ['Tablero', 'Por dueño', 'Urgente', 'Esta semana']) if (!nombresVista.some((n) => n.toLowerCase().includes(quiero.toLowerCase().split(' ')[0])))
  anota('Vista recomendada que no existe', quiero);

console.log(`Auditoría del tablero · ${hoy} · ${items.length} tarjetas · ${fasesEnCurso.length} fases en curso (tope ${TOPE}) · vistas: ${nombresVista.join(', ') || 'ninguna'}`);
if (fasesEnCurso.length > TOPE) console.log(`  ⛔ Tope rebasado: ${fasesEnCurso.length} fases en curso: ${fasesEnCurso.map((i) => i.content.title.match(/^\[[^\]]+\]/)[0]).join(' ')}`);
for (const [regla, l] of Object.entries(H)) {
  console.log(`\n■ ${regla} (${l.length})`);
  for (const x of l.slice(0, 14)) console.log('   ' + x);
  if (l.length > 14) console.log(`   … y ${l.length - 14} más`);
}
