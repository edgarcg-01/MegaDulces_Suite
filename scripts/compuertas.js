#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * LA LISTA DE COMPUERTAS. Una sola, para los dos runners que las corren.
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────────────────
 *
 * Había DOS listas, en dos archivos, con forma distinta:
 *
 *   · `scripts/gate-push.js`  → `GATES`      {nombre, script, ms}   — 8 entradas, corre al push
 *   · `scripts/check-all.js`  → `COMPUERTAS` {nombre, cmd, que}     — 23, corre a mano
 *
 * Las dos funcionaban perfecto por separado, y por eso la divergencia no se vio: medido el
 * **2026-10-01**, `check-dense-tables` y `check-css-tokens` estaban SÓLO en el push. O sea que
 * `npm run check` —cuyo encabezado dice literalmente *"corre todas las que existen"*— no las
 * ejecutaba. Una de las dos era la compuerta de tablas densas escrita la semana anterior.
 *
 * **Con una sola lista eso no se puede escribir:** para que una compuerta entre al push tiene
 * que estar declarada acá, y al estarlo ya entra en `npm run check`.
 *
 * ── Qué NO se unificó, y por qué ────────────────────────────────────────────────────────────
 *
 * Los dos **runners** siguen separados: hacen trabajos distintos. El del push intersecta los
 * hallazgos con TUS archivos y tiene que terminar en ~2.5 s; el de `check-all` corre todo e
 * imprime cada resultado aunque otro falle. Lo que se unifica es la LISTA, no quien la ejecuta.
 *
 * Y las de Nx (`lint`/`typecheck`/`test`/`build`) **no viven acá**: su comando depende de un
 * `base` que `check-all` calcula en tiempo de corrida desde git. Se quedan allá, declaradas
 * junto al `nx()` que las arma.
 *
 * ── La forma de una entrada ─────────────────────────────────────────────────────────────────
 *
 *   nombre  el que se imprime. Corto: `check-all` lo alinea en columna (`padEnd(11)`).
 *   script  archivo dentro de `scripts/`. El runner del push necesita la RUTA, no un comando.
 *   cmd     comando libre, para lo que no es un script de `scripts/` o lleva argumentos.
 *           Se usa `cmd` **o** `script`, nunca los dos.
 *   que     qué cubre, en una línea. Es lo que `check-all` imprime al lado del resultado.
 *   push    true = entra a la compuerta de `git push`. ⛔ Criterio de admisión, heredado de
 *           `gate-push.js`: escaneo estático, sin red, sin DB, y medido por debajo de ~3 s.
 *           Una entrada con `push: true` **tiene que traer `script`** (el runner arma la ruta).
 *   ms      lo que tardó la última vez que se midió, en la máquina de trabajo.
 *           ⚠️ Es DOCUMENTACIÓN: ningún código lo lee. El criterio que pretende sostener
 *           ("si pasa de 5 s, sacalo de acá") no lo verifica nadie — se comprueba a mano.
 *   final   true = va DESPUÉS de las de Nx en `check-all`. Hoy sólo `boot`, que necesita el
 *           compilado que produce `build`.
 */

const COMPUERTAS = [
  // Las tres propias primero: son segundos y atrapan lo que ninguna herramienta estándar ve.
  { nombre: 'templates', script: 'check-template-literals.js', que: 'literales de template enteros, CSS que parsea', push: true, ms: 2521 },
  // [AUD-DAT.23] La hermana de `templates`, para lo que esa NO puede ver: `check-template-literals`
  // recorre solo `*.component.ts`. El 2026-10-02 un acento grave dentro de un comentario SQL de un
  // knex.raw en un SERVICIO de NestJS se commiteo, llego a origin/main, tiro el build del PR y
  // -como ci-green se sella con build- freno el despliegue. La compuerta de componentes escaneo
  // 368 archivos y dio verde: el roto no era un componente. Septima vez en el proyecto, primera
  // que para la tuberia. Una compuerta que pasa sobre un archivo que no inspecciona se lee igual
  // que una que lo aprobo.
  { nombre: 'sql-backticks', script: 'check-sql-backticks.js', que: 'ningun comentario SQL lleva acentos graves (rompen el template literal)', push: true, ms: 900 },
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
  { nombre: 'reactividad', script: 'check-signal-reactivity.js', que: 'ningún computed() depende de un campo plano mutable', push: true, ms: 1801 },
  { nombre: 'primeng', script: 'check-primeng-api.js', que: 'sin API de PrimeNG retirada en v22 (falla muda)', push: true, ms: 2084 },
  /**
   * ⛔ **Las cuatro de abajo faltaban acá, y el encabezado de este archivo dice "corre todas las
   * que existen".** Hallado el 2026-10-01: `check-dense-tables` y `check-css-tokens` vivían en
   * `gate-push.js` y NO en esta lista, así que `npm run check` —la compuerta que alguien corre a
   * mano antes de entregar— no las ejecutaba. **Dos registros de compuertas que hay que mantener
   * sincronizados a mano ya divergieron**; mientras sean dos listas, agregá en las DOS.
   *   · tablas densas / tokens CSS: estaban sólo en el push.
   *   · teclado / búsqueda: nacen en las dos el mismo día ([KBD.1] / [KBD.2]).
   */
  { nombre: 'tablas densas', script: 'check-dense-tables.js', que: 'ninguna tabla nueva sin salida en un teléfono (DESIGN §553)', push: true, ms: 1146 },
  { nombre: 'tokens CSS', script: 'check-css-tokens.js', que: 'sin var(--token) inexistente: la declaración se cae en silencio', push: true, ms: 1318 },
  // `[PR.V9]` Nace de un reporte con captura: el expediente del motor imprimia emojis en
  // parrafos de la interfaz, con la regla "iconos, nunca emojis" escrita desde hace rato y
  // nada que la vigilara. Un emoji lo pinta la fuente del SISTEMA OPERATIVO: el mismo
  // parrafo sale distinto en Windows, en Android y en el navegador del vendedor.
  { nombre: 'sin emojis', script: 'check-no-emoji-ui.js', que: 'el texto que ve el usuario no lleva emojis (iconos, nunca emojis)', push: true, ms: 420 },
  { nombre: 'teclado', script: 'check-keyboard-nav.js', que: 'lo que se hace con el mouse se puede hacer con el teclado (DESIGN D.7)', push: true, ms: 197 },
  { nombre: 'búsqueda', script: 'check-busqueda.js', que: 'ningún buscador con .toLowerCase().includes() (DESIGN D.8)', push: true, ms: 198 },
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
  { nombre: 'mig-colisiones', script: 'check-migration-collisions.js', que: 'dos migraciones no comparten timestamp (knex las ordena por nombre, no por fecha)', push: true, ms: 1362 },
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
  // `[VL.19]` LA ÚLTIMA, y la que faltaba: **compilar no es arrancar**.
  //
  // Va DESPUÉS de `build` porque necesita el compilado (si está rancio lo rehace solo). El
  // 2026-09-24 un commit llegó a `main` y a producción sin arrancar: `nx build api`, `typecheck`,
  // `lint` y las 159 pruebas de `libs/finance` en verde, y el proceso muriendo en el arranque
  // porque un módulo no importaba al que exporta uno de sus proveedores. El grafo de inyección lo
  // resuelve Nest al LEVANTAR, y nadie levantaba nada antes de producción.
  //
  // Cuesta ~4 s cuando el compilado está fresco. La caída costó dos ventanas y una reversión.
  { nombre: 'boot', script: 'check-boot.js', que: 'el API ARRANCA (build verde ≠ proceso vivo)', final: true },
];

/**
 * ⛔ El único defecto que la unificación NO elimina sola, así que se revienta acá.
 *
 * `gate-push` no corre un comando: hace `path.join(RAIZ, 'scripts', g.script)` y ejecuta ese
 * archivo. Una entrada con `push: true` pero sin `script` —porque alguien la declaró con `cmd`,
 * que es la forma mayoritaria del registro— le pasaría `undefined` a `path.join`, que **no tira**:
 * arma `…/scripts/undefined` y la compuerta falla por "no existe el archivo", o peor, el runner
 * la cuenta como una corrida más. Un fallo de declaración disfrazado de fallo de compuerta.
 *
 * Revienta al CARGAR el módulo, no al correr la compuerta: los dos runners lo requieren antes de
 * hacer nada, así que el error sale en el primer `git push` y dice exactamente qué entrada es.
 */
for (const g of COMPUERTAS) {
  if (g.push && !g.script) {
    throw new Error(
      `compuertas.js: "${g.nombre}" está marcada push:true pero no declara \`script\`. ` +
      'La compuerta de push necesita la RUTA del archivo, no un comando — pasale `script` ' +
      "(el nombre dentro de `scripts/`) en vez de `cmd`.",
    );
  }
  if (g.cmd && g.script) {
    throw new Error(
      `compuertas.js: "${g.nombre}" declara \`cmd\` Y \`script\`. Es uno o el otro: con los dos, ` +
      'cada runner podría elegir distinto y correrían cosas diferentes con el mismo nombre.',
    );
  }
}

/** Las que corren al hacer `git push`. Todas traen `script` — lo garantiza la guarda de arriba. */
const DEL_PUSH = COMPUERTAS.filter((g) => g.push);

/** El comando de una entrada, venga por `cmd` o por `script`. */
const comandoDe = (g) => g.cmd ?? `node scripts/${g.script}`;

module.exports = { COMPUERTAS, DEL_PUSH, comandoDe };
