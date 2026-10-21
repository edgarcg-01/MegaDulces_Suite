#!/usr/bin/env node
// [CAMBIOS.2] La bitácora de cambios del equipo — qué cambió cada persona, por día y por tarjeta.
//   node .claude/skills/pm/cambios-del-equipo.js          → publica CAMBIOS.md en el repo privado del tablero
//   node .claude/skills/pm/cambios-del-equipo.js --dry    → sólo imprime
// Se GENERA de los títulos de commit (origin/main): nadie escribe dos veces. La regla que lo hace
// posible la cobra `.githooks/commit-msg` ([CAMBIOS.1]): todo título lleva el código de su tarjeta.
// Lee git local; escribe sólo en edgarcg-01/MegaDulces_PM (privado). Los títulos ya son públicos
// en el repo del código, así que la página no expone nada nuevo.
const path = require('path');
const { execFileSync } = require('child_process');
const raiz = path.resolve(__dirname, '..', '..', '..');
const DRY = process.argv.includes('--dry');
const DIAS = 14, REPO = 'edgarcg-01/MegaDulces_PM', ARCHIVO = 'CAMBIOS.md';

const gh = (a, input) => {
  for (let i = 1; ; i++) {
    try { return execFileSync('gh', a, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (i >= 4) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * i); }
  }
};
const git = (a) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 << 20 });
const persona = (a) => /francisco/i.test(a) ? 'Francisco' : /inge|david/i.test(a) ? 'IngeDavid' : /0sistemas/i.test(a) ? '0Sistemas' : /edgar/i.test(a) ? 'Edgar' : a;
const CODIGO = /\[([A-Za-z0-9][A-Za-z0-9.+\-/ ]*)\]/g;

try { execFileSync('git', ['fetch', '-q', 'origin', 'main'], { cwd: raiz, stdio: 'ignore', timeout: 60000 }); } catch { /* sin red: se usa lo local */ }
const filas = git(['log', `--since=${DIAS}.days`, '--no-merges', '--date=format-local:%Y-%m-%d', '--pretty=%ad\t%an\t%h\t%s', 'origin/main'])
  .split('\n').filter(Boolean).map((l) => { const [dia, autor, sha, ...s] = l.split('\t'); return { dia, quien: persona(autor), sha, titulo: s.join('\t') }; });

// Código de commit → tarjeta del tablero (por el prefijo: `CGA-A.15b` → `CGA`).
let tarjetas = [];
try { tarjetas = JSON.parse(gh(['issue', 'list', '-R', REPO, '--state', 'all', '--limit', '400', '--json', 'number,title'])); } catch { /* sin gh: sin ligas */ }
const tarjetaDe = (cod) => {
  const cands = tarjetas.map((t) => ({ t, c: (t.title.match(/^\[([^\]]+)\]/) || [])[1] })).filter((x) => x.c);
  const exacta = cands.find((x) => x.c === cod) || cands.filter((x) => cod.startsWith(x.c) && /^[.\-]/.test(cod.slice(x.c.length))).sort((a, b) => b.c.length - a.c.length)[0];
  return exacta ? `[#${exacta.t.number}](https://github.com/${REPO}/issues/${exacta.t.number})` : '';
};
const limpio = (t) => t.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
const raizCodigo = (c) => c.split(/[.\-+/ ]/)[0];

const porDia = new Map();
for (const f of filas) (porDia.get(f.dia) || porDia.set(f.dia, []).get(f.dia)).push(f);
const resumen = {};
for (const f of filas) { const r = (resumen[f.quien] ||= { n: 0, sin: 0, cods: new Set() }); r.n++; const cods = [...f.titulo.matchAll(CODIGO)].map((m) => m[1]); if (!cods.length) r.sin++; cods.forEach((c) => r.cods.add(raizCodigo(c))); }

const md = [
  '# Cambios del equipo',
  '',
  `> Generado solo cada día desde los commits de \`main\` (últimos ${DIAS} días) · ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}.`,
  '> **Regla del equipo (Edgar, 2026-10-21):** todo cambio se comunica. Cada título de commit lleva el código de su tarjeta — lo frena el hook `commit-msg`. Lo que llegue sin código aparece abajo como **sin tarjeta**.',
  '',
  '## Resumen por persona',
  '',
  '| Persona | Commits | Sin tarjeta | Temas |',
  '|---|---:|---:|---|',
  ...Object.entries(resumen).sort((a, b) => b[1].n - a[1].n).map(([q, r]) => `| ${q} | ${r.n} | ${r.sin ? '⚠️ ' + r.sin : 0} | ${[...r.cods].slice(0, 14).join(', ')}${r.cods.size > 14 ? '…' : ''} |`),
  '',
];
for (const [dia, fs] of [...porDia].sort((a, b) => b[0].localeCompare(a[0]))) {
  md.push(`## ${dia}`, '');
  const porQuien = new Map();
  for (const f of fs) (porQuien.get(f.quien) || porQuien.set(f.quien, []).get(f.quien)).push(f);
  for (const [q, cs] of porQuien) {
    md.push(`### ${q} · ${cs.length} cambio${cs.length > 1 ? 's' : ''}`, '');
    const porTema = new Map();
    for (const c of cs) { const cod = (c.titulo.match(/\[([^\]]+)\]/) || [])[1]; const k = cod ? raizCodigo(cod) : '⚠️ sin tarjeta'; (porTema.get(k) || porTema.set(k, { cod, l: [] }).get(k)).l.push(c); }
    for (const [tema, { cod, l }] of porTema) {
      md.push(`- **${tema}** ${cod ? tarjetaDe(cod) : ''}`);
      for (const c of l) md.push(`  - ${limpio(c.titulo).slice(0, 160)} \`${c.sha}\``);
    }
    md.push('');
  }
}
const contenido = md.join('\n');

if (DRY) { console.log(contenido.split('\n').slice(0, 40).join('\n') + `\n… (${contenido.length} caracteres, ${filas.length} commits)`); process.exit(0); }
let sha = '';
try { sha = JSON.parse(gh(['api', `repos/${REPO}/contents/${ARCHIVO}`])).sha || ''; } catch { /* aún no existe */ }
const cuerpo = JSON.stringify({ message: `bitácora de cambios: ${new Date().toISOString().slice(0, 10)}`, content: Buffer.from(contenido).toString('base64'), ...(sha ? { sha } : {}) });
gh(['api', '-X', 'PUT', `repos/${REPO}/contents/${ARCHIVO}`, '--input', '-'], cuerpo);
console.log(`Publicado ${ARCHIVO}: ${filas.length} commits de ${Object.keys(resumen).length} personas · https://github.com/${REPO}/blob/main/${ARCHIVO}`);
