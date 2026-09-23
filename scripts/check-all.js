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
  // `[CG.22]` Las dos que siguen atrapan defectos de UI **mudos**: build verde, typecheck verde,
  // cero errores en consola, y la pantalla no funciona. La única forma de verlos era abrirla.
  //   · reactividad: un `computed()` sobre un campo plano queda congelado. Pasó el 14-sep en
  //     `almacen-analisis-bi` —con spec de la lección incluido— y volvió a pasar el 22-sep en
  //     `finanzas-caja-general`, donde dejó el botón **Guardar** inhabilitado de por vida.
  //     Un spec que prueba el principio no revisa el código que se escribe después.
  //   · primeng: API que la v22 retiró y que Angular deja pasar como atributo HTML muerto.
  //     `pTemplate="footer"` en un `p-dialog` abre el diálogo SIN BOTONES (GOTCHAS §59).
  { nombre: 'reactividad', cmd: 'node scripts/check-signal-reactivity.js', que: 'ningún computed() depende de un campo plano mutable' },
  { nombre: 'primeng', cmd: 'node scripts/check-primeng-api.js', que: 'sin API de PrimeNG retirada en v22 (falla muda)' },
  // `[NX.3]` Es la única de las cuatro que atrapa un defecto INVISIBLE en la máquina de quien lo
  // introduce: el contexto de Docker sólo se ejerce en el contenedor, y ahí el síntoma no
  // menciona ni Docker ni el COPY. Costó un deploy caído antes de existir.
  { nombre: 'docker-ctx', cmd: 'node scripts/check-docker-context.js', que: 'los Dockerfiles copian lo que los configs de proyecto importan de la raíz' },
  // `[NX.7]` Va ANTES del typecheck a propósito: si los dos mapas de `paths` divergen, el
  // typecheck sale rojo con TS2307 "Cannot find module", que se lee como un error del código y
  // no lo es. Medido el 2026-09-18: así estaba —5 errores, cero de ellos reales— porque a
  // `tsconfig.ts7.json` le faltaban 6 alias y le sobraban 3 de una lib que ya no existe.
  { nombre: 'ts7-paths', cmd: 'node scripts/check-ts7-paths.js', que: 'el mapa de `paths` del typecheck no se desfasó del build' },
  // Un `.ps1` con ParserError no falla una línea: NO COMPILA ENTERO y el script no ejecuta ni su
  // primera instrucción. Medido el 2026-09-22: así estuvo `backup-db.ps1` durante 12 días, con la
  // tarea "corriendo" a diario y cero respaldos de prod. Y hay 26 `.ps1` versionados, varios
  // desatendidos en cajas de sucursal. Nada de esto lo ve eslint ni el typecheck.
  { nombre: 'powershell', cmd: 'node scripts/check-powershell.js', que: 'los 26 `.ps1` compilan (un ParserError los deja mudos, no rojos)' },
  // Editar una migración YA APLICADA en prod no la re-corre → el cambio no llega a prod pero sí a
  // un `migrate:latest` fresco. Patrón que ya cobró cuatro veces (#122/#128/#133/#138). Sólo toca
  // la red (prod) si el diff modifica algún archivo de migración; si no, sale verde sin conectar.
  { nombre: 'migrations', cmd: 'node database/scripts/check-applied-migrations.js', que: 'no se edita una migración ya aplicada en prod (llega a fresh, no a prod)' },
  // [ODS.1] Una lista de sucursales escrita a mano falla HACIA ABAJO y en silencio: el proceso
  // recorre menos ramas de las que hay, no da error, y no puede reportar faltantes porque una rama
  // que no mira no puede faltarle nada. Ya cobró dos veces (Morelia fuera de `mv_sales_blended`
  // por $1.64M; y el reconciliador nocturno sin mirar 07/08, con 2,987 pedidos fantasma en el ODS).
  { nombre: 'sucursales', cmd: 'node scripts/check-branch-catalog.js', que: 'la lista de sucursales sale del catálogo canónico, no de una cadena a mano' },
  // Y las de Nx, que desde 2026-09-17 sí usan caché (antes corrían siempre desde cero).
  { nombre: 'lint', cmd: nx('lint'), que: 'eslint' },
  // `[NX.7]` `apps/api` compila con SWC, que borra los tipos SIN comprobarlos: `build` no
  // typechequea la api. Las 3 apps Angular sí lo hacen en AOT. Éste cubre ese hueco, y desde
  // que es target de Nx entra en `affected` y en la caché como cualquier otro.
  { nombre: 'typecheck', cmd: nx('typecheck'), que: 'tipos de la api (SWC no los comprueba)' },
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
