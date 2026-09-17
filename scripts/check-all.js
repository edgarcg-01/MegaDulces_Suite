#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `npm run check` — LA compuerta local: corre todas las que existen y dice cuál pasa.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * El workflow de CI (`.github/workflows/ci.yml`) está bien construido —usa `nx affected`, tiene
 * los tres gates propios— y **no corre desde el 2026-08-25**. Motivo textual de GitHub, leído en
 * las anotaciones de la última corrida:
 *
 *     "The job was not started because your account is locked due to a billing issue."
 *
 * Los tres jobs mueren en 2-3 s sin arrancar. No es el workflow, ni los runners, ni cuota (el
 * repo es público, donde Actions es gratis): es la CUENTA. Lo destraba el dueño en la
 * configuración de facturación de GitHub; no hay nada que arreglar en el repo.
 *
 * Mientras tanto las compuertas viven en la máquina de cada quien, repartidas en seis comandos
 * que nadie corre juntos. Esto los junta en uno y —lo que importa— **imprime el estado de cada
 * uno aunque otro falle**: con `&&` el primer rojo tapa a los demás y no se sabe si hay uno o
 * cinco problemas.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────────────────────
 * No arregla nada ni salta lo que está en rojo. Si una compuerta falla, sale con 1. Medido el
 * 2026-09-17, cuatro de cinco estaban rojas y ninguna era reciente: ése es el costo de tener el
 * CI apagado, y esconderlo detrás de un `|| true` sería volver a empezar.
 *
 *   npm run check              # afectado por el diff contra origin/main
 *   npm run check -- --all     # todo el workspace (más lento, sin depender del diff)
 */
const { spawnSync } = require('node:child_process');

const ALL = process.argv.includes('--all');
const sh = (cmd) => spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 1 << 26 });

/** Base del diff para `nx affected`. Sin origin/main alcanzable, se cae a todo el workspace. */
function baseDeDiff() {
  if (ALL) return null;
  const r = sh('git merge-base HEAD origin/main');
  const base = (r.stdout || '').trim();
  return r.status === 0 && base ? base : null;
}

const base = baseDeDiff();
const alcance = base ? `afectado desde origin/main (${base.slice(0, 8)})` : 'TODO el workspace';
const nx = (target) => (base
  ? `npx nx affected -t ${target} --base=${base} --parallel=3`
  : `npx nx run-many -t ${target} --parallel=3`);

const COMPUERTAS = [
  // Las tres propias primero: son segundos y atrapan lo que ninguna herramienta estándar ve.
  { nombre: 'templates', cmd: 'node scripts/check-template-literals.js', que: 'literales de template enteros, CSS que parsea' },
  { nombre: 'boundary', cmd: 'node scripts/lint-boundary-gate.js', que: 'sin `any` nuevo en el borde HTTP (ADR-052)' },
  { nombre: 'provenance', cmd: 'node scripts/check-provenance.js', que: 'un número publicado declara con qué se calculó (ADR-056)' },
  // `[NX.3]` Es la única de las cuatro que atrapa un defecto INVISIBLE en la máquina de quien lo
  // introduce: el contexto de Docker sólo se ejerce en el contenedor, y ahí el síntoma no
  // menciona ni Docker ni el COPY. Costó un deploy caído antes de existir.
  { nombre: 'docker-ctx', cmd: 'node scripts/check-docker-context.js', que: 'los Dockerfiles copian lo que los configs de proyecto importan de la raíz' },
  // Y las de Nx, que desde 2026-09-17 sí usan caché (antes corrían siempre desde cero).
  { nombre: 'lint', cmd: nx('lint'), que: 'eslint' },
  // `[NX.3]` Sin `--passWithNoTests`: cada `vitest.config.ts` lo declara, y el target `test` lo
  // infiere el plugin `@nx/vitest` de ese archivo — si no hay config, no hay target que correr.
  { nombre: 'test', cmd: nx('test'), que: 'las suites del workspace (vitest)' },
  { nombre: 'build', cmd: nx('build'), que: 'compila' },
];

console.log(`\n=== npm run check · ${alcance} ===\n`);

const res = [];
for (const g of COMPUERTAS) {
  const t0 = Date.now();
  process.stdout.write(`  ${g.nombre.padEnd(11)} … `);
  const r = sh(g.cmd);
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  console.log(`${ok ? '✅' : '⛔'}  ${seg}s`);
  res.push({ ...g, ok, seg, salida: `${r.stdout || ''}${r.stderr || ''}` });
}

const rojas = res.filter((r) => !r.ok);
if (rojas.length) {
  console.log(`\n${'─'.repeat(70)}\nDETALLE DE LO QUE FALLÓ\n${'─'.repeat(70)}`);
  for (const r of rojas) {
    console.log(`\n▼ ${r.nombre} — ${r.que}`);
    // Las últimas líneas son donde vive el motivo en las seis herramientas.
    console.log(r.salida.split('\n').filter(Boolean).slice(-14).map((l) => `   ${l}`).join('\n'));
  }
}

console.log(`\n${'═'.repeat(70)}`);
for (const r of res) console.log(`  ${r.ok ? '✅' : '⛔'} ${r.nombre.padEnd(11)} ${String(r.seg).padStart(6)}s   ${r.que}`);
console.log(`${'═'.repeat(70)}`);
console.log(`  ${res.length - rojas.length}/${res.length} en verde\n`);

if (rojas.length) {
  console.log('⛔ No está listo para push. Ninguna de estas compuertas se salta: si una está roja');
  console.log('   desde antes de tu cambio, decilo al equipo — no la escondas.\n');
}
process.exit(rojas.length ? 1 : 0);
