#!/usr/bin/env node
// Tablero del PM: cuenta, no recuerda.
//   node .claude/skills/pm/tablero.js            -> fases del roadmap por estado + cupo
//   node .claude/skills/pm/tablero.js CGA VAC    -> además, items del tracker por estado de esas fases
// Sólo lee archivos del repo. No toca la base ni la red.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const raiz = path.resolve(__dirname, '..', '..', '..');
const leer = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
const CUPO = 4;
const ESTADOS = ['🟢', '🚀', '🧪', '🔨', '🟡', '🔴', '⏸️', '⬜'];

// 1. Roadmap de CLAUDE.md: filas "| **XX** | tema | estado |"
const filas = leer('CLAUDE.md')
  .split('\n')
  .map((l) => l.match(/^\| \*\*([^*]+)\*\* \| (.+?) \| (.+?) \|\s*$/))
  .filter(Boolean)
  .map(([, fase, tema, estado]) => ({ fase, tema, estado: estado.trim() }));

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
const enCurso = (porEstado['🔨'] || []).length;
console.log(
  enCurso > CUPO
    ? `\n⛔ CUPO EXCEDIDO: ${enCurso} fases 🔨 contra un tope de ${CUPO}. No se abre nada nuevo; hay que cerrar o pasar a ⏸️ ${enCurso - CUPO}.`
    : `\nCupo: ${enCurso}/${CUPO} 🔨 — ${CUPO - enCurso} libre(s).`,
);

// 2. Tracker: items "- [ ] **[PREFIJO.N]** <estado>" de las fases pedidas
const prefijos = process.argv.slice(2);
if (prefijos.length) {
  const tracker = leer('docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md').split('\n');
  const SIMB = ['✅', '🚀', '🧪', '🔨', '⬜', '⚠️', '❌', '🔧'];
  for (const p of prefijos) {
    const re = new RegExp(`^\\s*- \\[[ x]\\] \\*\\*\\[${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.\\-]`);
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
      const pat = '\\[' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[].-]';
      commits = execFileSync('git', ['log', '--since=60.days', '--oneline', '-E', `--grep=${pat}`], { cwd: raiz, encoding: 'utf8' })
        .split('\n').filter(Boolean).length;
    } catch { /* sin git: se declara, no se dibuja 0 */ }
    console.log(`\nTracker [${p}.*]: ${items.length} items${items.length ? ' — ' + resumen : ''} · commits 60 días: ${commits}`);
    if (!items.length && commits > 0) console.log(`  ⚠️ Hay commits de [${p}] sin items en el tracker: el trabajo no está registrado.`);
    if (!items.length && !commits) console.log('  NO ENCONTRADO: revisá el prefijo.');
  }
}
