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
  /**
   * ⛔ **Las cuatro de abajo faltaban acá, y el encabezado de este archivo dice "corre todas las
   * que existen".** Hallado el 2026-10-01: `check-dense-tables` y `check-css-tokens` vivían en
   * `gate-push.js` y NO en esta lista, así que `npm run check` —la compuerta que alguien corre a
   * mano antes de entregar— no las ejecutaba. **Dos registros de compuertas que hay que mantener
   * sincronizados a mano ya divergieron**; mientras sean dos listas, agregá en las DOS.
   *   · tablas densas / tokens CSS: estaban sólo en el push.
   *   · teclado / búsqueda: nacen en las dos el mismo día ([KBD.1] / [KBD.2]).
   */
  { nombre: 'tablas densas', cmd: 'node scripts/check-dense-tables.js', que: 'ninguna tabla nueva sin salida en un teléfono (DESIGN §553)' },
  { nombre: 'tokens CSS', cmd: 'node scripts/check-css-tokens.js', que: 'sin var(--token) inexistente: la declaración se cae en silencio' },
  { nombre: 'teclado', cmd: 'node scripts/check-keyboard-nav.js', que: 'lo que se hace con el mouse se puede hacer con el teclado (DESIGN D.7)' },
  { nombre: 'búsqueda', cmd: 'node scripts/check-busqueda.js', que: 'ningún buscador con .toLowerCase().includes() (DESIGN D.8)' },
  // `[NX.3]` Es la única de las cuatro que atrapa un defecto INVISIBLE en la máquina de quien lo
  // introduce: el contexto de Docker sólo se ejerce en el contenedor, y ahí el síntoma no
  // menciona ni Docker ni el COPY. Costó un deploy caído antes de existir.
  { nombre: 'docker-ctx', cmd: 'node scripts/check-docker-context.js', que: 'los Dockerfiles copian lo que los configs de proyecto importan de la raíz' },
  // `[CT.9]` El handle que dice "producción" tiene que SER producción. Medido el 2026-09-25,
  // tres días después del corte: `FLEET_DB_URL` seguía apuntando a Railway, **que no se apagó**.
  // Los dos clústeres tienen una base llamada `railway`, los dos responden, y el equivocado va
  // 23 migraciones atrás — o sea que un guion que pide prod no falla, **triunfa en el lugar
  // equivocado**. Arrastró a la suite de regresión entera, que lo lee ANTES que
  // `DATABASE_URL_NEW`. Sin red hasta prod reporta NO MEDIDO y sale 0: no se pinta verde lo que
  // no se pudo comprobar, ni se rompe el trabajo de quien no tiene acceso.
  { nombre: 'destino-prod', cmd: 'node scripts/check-prod-target.js', que: 'el handle de "prod" es el clúster de prod, y no puede escribir' },
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
  // Knex ordena por NOMBRE COMPLETO, no por el timestamp: dos migraciones con el mismo prefijo se
  // aplican en orden alfabético, o sea al azar respecto de la intención. Con ~10 sesiones poniendo
  // el timestamp a mano no es teórico — medido el 2026-09-30: `20260930120000` con CINCO archivos.
  // Sólo marca lo que TODAVÍA se puede renombrar: un archivo ya en main o ya aplicado en prod está
  // congelado, y renombrarlo deja el ledger apuntando a un archivo inexistente.
  { nombre: 'mig-colisiones', cmd: 'node scripts/check-migration-collisions.js', que: 'dos migraciones no comparten timestamp (knex las ordena por nombre, no por fecha)' },
  // ⭐ Prod congelada 3 HORAS el 2026-09-30: código commiteado apuntando a archivos sin trackear.
  // Compilar en el árbol de trabajo compila el commit MÁS lo sucio de las ~10 sesiones, y ahí esos
  // archivos SÍ existen; Docker compila el commit pelado. Un build local verde no dice nada sobre
  // un commit. Por eso este candado lee el ÁRBOL DE GIT, nunca el disco. Validado: contra
  // `af6a88d0` encuentra las 4 referencias rotas y ninguna de más.
  { nombre: 'commit-wiring', cmd: 'node scripts/check-commit-wiring.js', que: 'lo que el commit referencia viaja EN el commit (no sólo en tu árbol de trabajo)' },
  // [ODS.1] Una lista de sucursales escrita a mano falla HACIA ABAJO y en silencio: el proceso
  // recorre menos ramas de las que hay, no da error, y no puede reportar faltantes porque una rama
  // que no mira no puede faltarle nada. Ya cobró dos veces (Morelia fuera de `mv_sales_blended`
  // por $1.64M; y el reconciliador nocturno sin mirar 07/08, con 2,987 pedidos fantasma en el ODS).
  { nombre: 'sucursales', cmd: 'node scripts/check-branch-catalog.js', que: 'la lista de sucursales sale del catálogo canónico, no de una cadena a mano' },
  // [VL.16] Postgres rechaza parámetros ligados en `SET` (42601). El 2026-09-23 esa forma en
  // `login-core.ts` dejó el login de PROD devolviendo 500 a todo el mundo y hubo que volver la
  // versión anterior en caliente. El mismo defecto en `freshness.ts` era peor: caía en un `catch`
  // que reporta "no se pudo medir", o sea un bug disfrazado de dato ausente. El repo YA lo tenía
  // escrito en un comentario de `store.service.ts` — un comentario no frena nada.
  { nombre: 'set-bind', cmd: 'node scripts/check-set-bind-param.js', que: 'sin parámetros ligados en sentencias SET (Postgres 42601)' },
  /**
   * ⭐⭐ `[ETQ-FIT.4]` LA ETIQUETA SE MIDE RENDERIZADA, Y EN LOS DOS ESCENARIOS.
   *
   * La etiqueta de anaquel es **papel**: sale de la impresora, se pega en el mostrador y el
   * cliente le cree. Un renglón cortado ahí no es un defecto visual, es un precio a medio
   * imprimir. Y no se puede juzgar leyendo el código —el defecto vive en la geometría—, así que
   * el único juez es el arnés, que la renderiza de verdad sobre un corpus congelado de 220
   * etiquetas reales de prod.
   *
   * ⛔ Estaba escrito y había que acordarse de correrlo. Se corrió dos veces en toda su vida, y
   * las dos por un reporte del mostrador: *"salen mal en otros equipos"*. Un arnés que depende de
   * que alguien se acuerde no es una compuerta, es una herramienta.
   *
   * ⭐ Van LOS DOS escenarios. El segundo (`--sin-fuentes`) mide la etiqueta como sale en un
   * equipo que no tiene las tres tipografías, que es exactamente el reporte que abrió esto:
   * medido antes de arreglarlo, **48 de 220 salían rotas**. Con una sola de las dos corridas, la
   * mitad del riesgo queda sin vigilar.
   *
   * Cuesta ~40 s cada una y no toca red ni base: el corpus está congelado en el repo y las
   * tipografías se incrustan desde `assets/fonts`.
   */
  { nombre: 'etiqueta-gate', cmd: 'node scripts/check-etiqueta-gate.js',
    que: 'el arnés de la etiqueta sigue sin excepciones y sigue siendo compuerta' },
  { nombre: 'etiqueta', cmd: 'node scripts/etiqueta-geometria.js compuerta',
    que: 'la etiqueta impresa no recorta un renglón ni un precio (220 reales, renderizadas)' },
  { nombre: 'etiqueta-sin-fuentes', cmd: 'node scripts/etiqueta-geometria.js compuerta --sin-fuentes',
    que: 'y sigue entera en un equipo SIN las tres tipografías — el reporte que abrió esto' },
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
  // `[VL.19]` LA ÚLTIMA, y la que faltaba: **compilar no es arrancar**.
  //
  // Va DESPUÉS de `build` porque necesita el compilado (si está rancio lo rehace solo). El
  // 2026-09-24 un commit llegó a `main` y a producción sin arrancar: `nx build api`, `typecheck`,
  // `lint` y las 159 pruebas de `libs/finance` en verde, y el proceso muriendo en el arranque
  // porque un módulo no importaba al que exporta uno de sus proveedores. El grafo de inyección lo
  // resuelve Nest al LEVANTAR, y nadie levantaba nada antes de producción.
  //
  // Cuesta ~4 s cuando el compilado está fresco. La caída costó dos ventanas y una reversión.
  { nombre: 'boot', cmd: 'node scripts/check-boot.js', que: 'el API ARRANCA (build verde ≠ proceso vivo)' },
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
