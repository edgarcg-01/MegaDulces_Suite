#!/usr/bin/env node
/**
 * `[PURGA.10]` — Después de la reescritura del historial, re-ancla este checkout SIN re-clonar y
 * SIN tocar archivos ni índice: el trabajo sin commitear y los commits sin empujar se conservan.
 *
 * ── Por qué funciona ─────────────────────────────────────────────────────────────────────────
 * La purga quitó del historial archivos que ya NO existen en ningún árbol reciente (volcados,
 * .env.cloudinary, cachés…). El contenido de hoy es idéntico; lo que cambió son los SHA de los commits.
 * Así que cada commit local se rehace con el MISMO árbol encima de su equivalente en la historia nueva
 * (mismo instante de commit + mismo título). Como el árbol de la punta no cambia, la rama se mueve con
 * `update-ref` y el árbol de trabajo y el índice quedan exactamente como estaban: ninguna sesión se entera.
 *
 * Uso:  node scripts/purga-reanclar.js            → simula y dice qué haría
 *       node scripts/purga-reanclar.js --aplicar  → mueve la rama actual (compare-and-swap)
 */
'use strict';
const { execFileSync } = require('child_process');
const g = (a, opts = {}) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts }).trim();
const APLICAR = process.argv.includes('--aplicar');
const rama = g(['symbolic-ref', '--short', 'HEAD']);
const head = g(['rev-parse', 'HEAD']);
const esAncestro = (a, b) => { try { g(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };

// `--refmap=` evita que el fetch mueva origin/main por su cuenta: la simulación no debe cambiar NADA.
g(['fetch', '-q', '--refmap=', 'origin', '+refs/heads/main:refs/purga/nuevo-main']);
const nuevo = g(['rev-parse', 'refs/purga/nuevo-main']);
if (esAncestro(nuevo, head) || esAncestro(head, nuevo)) {
  console.log('✓ Tu rama ya está sobre la historia de origin/main (o se actualiza con un pull normal): no hay nada que re-anclar.');
  g(['update-ref', '-d', 'refs/purga/nuevo-main']);
  process.exit(0);
}

// Índice de la historia nueva por (instante de commit, título): lo que la reescritura conserva.
const clave = (h) => g(['log', '-1', '--format=%ct%x00%s', h]);
const indice = new Map();
for (const l of g(['log', '--format=%H%x00%ct%x00%s', nuevo]).split('\n')) {
  const [h, ct, s] = l.split('\0');
  const k = `${ct}\0${s}`;
  if (!indice.has(k)) indice.set(k, h);
}
// La base es el último commit compartido que SÍ existe en la historia nueva. Si alguien empujó después
// de que se clonó la copia que se reescribió, ese commit no tiene equivalente: se retrocede y se rehace.
let base = null;
for (const c of g(['rev-list', '--first-parent', head]).split('\n')) if (indice.has(clave(c))) { base = c; break; }
if (!base) { console.error('⛔ Ningún commit de tu rama tiene equivalente en la historia nueva: no es este repo, o no se reescribió.'); process.exit(1); }
const locales = g(['rev-list', '--reverse', '--topo-order', `${base}..${head}`]).split('\n').filter(Boolean);
const mapa = new Map();
const equivalente = (viejo) => {
  if (mapa.has(viejo)) return mapa.get(viejo);
  const n = indice.get(clave(viejo));
  if (!n) throw new Error(`sin equivalente en la historia nueva para ${viejo.slice(0, 9)} «${clave(viejo).split('\0')[1]}»`);
  mapa.set(viejo, n);
  return n;
};
equivalente(base);
for (const c of locales) {
  const [an, ae, ad, cn, ce, cd] = g(['log', '-1', '--format=%an%x00%ae%x00%aD%x00%cn%x00%ce%x00%cD', c]).split('\0');
  const padres = g(['rev-list', '--parents', '-n', '1', c]).split(' ').slice(1).map(equivalente);
  const msg = g(['log', '-1', '--format=%B', c]);
  const env = { ...process.env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd };
  const nuevoC = g(['commit-tree', `${c}^{tree}`, ...padres.flatMap((p) => ['-p', p])], { input: msg + '\n', env });
  mapa.set(c, nuevoC);
}
const punta = mapa.get(head);
const mismoArbol = g(['rev-parse', `${punta}^{tree}`]) === g(['rev-parse', `${head}^{tree}`]);
console.log(`rama ${rama}: ${locales.length} commit(s) locales sobre la historia nueva · base ${base.slice(0, 9)} → ${mapa.get(base).slice(0, 9)} · punta ${head.slice(0, 9)} → ${punta.slice(0, 9)} · mismo árbol: ${mismoArbol ? 'sí' : 'NO'}`);
if (!mismoArbol) { console.error('⛔ El árbol no coincide: no se mueve nada.'); process.exit(1); }
if (!APLICAR) { console.log('(simulación) Para aplicarlo: node scripts/purga-reanclar.js --aplicar'); process.exit(0); }
// compare-and-swap: si otra sesión commiteó mientras tanto, falla y se vuelve a correr.
g(['update-ref', '-m', 'purga: re-anclar sobre la historia nueva', `refs/heads/${rama}`, punta, head]);
g(['update-ref', 'refs/remotes/origin/main', nuevo]);
g(['update-ref', '-d', 'refs/purga/nuevo-main']);
console.log(`✓ ${rama} re-anclada en ${punta.slice(0, 9)}. Archivos e índice sin tocar. git status debe verse igual que antes.`);
