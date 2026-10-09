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
 *
 *           ⛔⛔ `[PVI.18]` **NO SIRVEN PARA DECIDIR SI UNA COMPUERTA NUEVA ENTRA.** Medido el
 *           2026-10-09, las 14 con `push`, cada una SOLA en serie y después las 14 en
 *           `Promise.all` como las corre `gate-push.js:322`:
 *
 *               compuerta      declara    sola   junta   junta/sola
 *               tablas densas     1146     225    1100      x4.89
 *               mig-colisiones    1362     296    1094      x3.70
 *               búsqueda           198     289     708      x2.45
 *               tokens CSS        1318     281     624      x2.22
 *               primeng           2084     892    1500      x1.68
 *               set-bind          2273    1513    2225      x1.47
 *               templates         2521    3851    5266      x1.37
 *               estilos           3106    5768    6689      x1.16
 *
 *           Tres cosas que esa tabla deja dicho, y las tres contradicen algo que se afirmó
 *           antes en este archivo:
 *
 *            1. **Los `ms` declarados están viejos en LAS DOS DIRECCIONES.** `estilos` dice
 *               3,106 y sola tarda **5,768**; `tablas densas` dice 1,146 y tarda **225**. No son
 *               "pisos" ni "mediciones en aislamiento que subestiman ~2×" (lo afirmé yo y es
 *               falso): son números de fechas distintas que nadie volvió a tomar.
 *            2. **La inflación es al revés de lo que parece.** No se inflan las pesadas: se
 *               inflan las LIVIANAS. `estilos`, la que más recorre el repo, es la que MENOS se
 *               infla (×1.16); `tablas densas`, la más liviana, la que más (×4.89). El castigo
 *               de la concurrencia es **aditivo y parecido para todas** (+178 a +1,415 ms,
 *               mediana ~+500), así que el COCIENTE es grande justo donde el denominador es
 *               chico. Una regla que diga "la liviana se parece a la realidad" tiene el signo
 *               invertido.
 *            3. ⚠️ Un ×0.91 sale de comparar el `ms` DECLARADO contra la corrida concurrente.
 *               Eso no mide contención: mide cuánto envejeció el número.
 *
 *           ⇒ Para decidir si una compuerta entra, la única cifra que significa algo es **la
 *           PARED de la rueda completa, medida hoy, con y sin ella**. Hoy: ~6.9 s las 14.
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
  // [IC.24] La OTRA hermana de `templates`, para lo que esa tampoco puede ver: los TIPOS dentro
  // de la plantilla. `check-template-literals` mira que el literal este entero y que el CSS
  // parsee; `tsc -p tsconfig.app.json` NO compila plantillas (para TypeScript son strings); y el
  // unico con `strictTemplates` es `nx build`, prohibido en local. El 2026-10-08 entro a main una
  // pantalla cuyo (onRowSelect)="f($event.data)" pasaba `T | T[] | undefined` a un parametro `T`
  // -- PrimeNG lo declara asi porque [(selection)] admite single y multiple -- y LAS TRES
  // compuertas locales dieron verde. Lo encontro el CI, o sea despues del push.
  // ⚠️ Montar el componente en un spec TAMPOCO lo cubre, y se midio: el TestBed compila en JIT y
  //    no aplica `strictTemplates` (con el error puesto, la prueba de "monta" siguio verde).
  // ⛔ SIN `push: true`: son ~57 s solo `view`, muy por encima del criterio de admision (~3 s).
  //    Por default solo frena por lo COMMITEADO que falta pushear -- en un arbol que comparten
  //    10 sesiones, "sin commitear" no es "mio" sino de todos, y frenar a alguien por el borrador
  //    ajeno es el defecto que esta compuerta estaria introduciendo en vez de resolviendo.
  { nombre: 'templates-types', cmd: 'node scripts/check-template-types.js', que: 'los tipos DENTRO de las plantillas de Angular (strictTemplates), que ni check:templates ni tsc ni un spec ven' },
  // [CD.12] Un marcador de conflicto sin resolver. Ya entro al repo una vez y rompio el build
  // (2026-09-26, `fix([RA-PRO.60-62]): resolver marcador de conflicto en compras.service`), y
  // hasta hoy NADA lo miraba: `pre-commit` solo corria gitleaks. Con 11 sesiones sobre el mismo
  // arbol (medido 2026-10-02) el que lo commitea no es el que ve el build roto.
  // ⛔ SIN `push: true` a proposito: el barrido completo son 4,216 archivos y 7.6 s, muy por
  //    encima del criterio de admision (~3 s). Donde si corre es en `.githooks/pre-commit`,
  //    acotado a lo staged: 94 ms, y ataja ANTES de que el commit exista. Aca queda para el
  //    barrido entero de `npm run check`.
  { nombre: 'conflicto', cmd: 'node scripts/check-conflict-markers.js', que: 'ningun marcador de conflicto sin resolver (rompe el build de todas las sesiones)' },
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
  //   · spec-vivo: un archivo de prueba que no CARGA reporta 0 tests, no fallas — el total de
  //     la suite sigue creciendo y nadie mira la línea de archivos. Medido el 2026-10-06:
  //     13 archivos de libs/ así, 166 pruebas sin correr una sola vez, entre ellas el candado
  //     del teclado de todas las tablas.
  { nombre: 'spec-vivo', script: 'check-spec-vivo.js', que: 'ningún spec de libs/ importa de "vitest" (cargaría en cero)', push: true, ms: 180 },
  //   · sidebar-tabs: una pantalla que sólo está en una barra de pestañas, para quien no
  //     conoce la pestaña, NO EXISTE — es la lección que `[AU.3]` ya había dejado escrita y
  //     que nadie podía sostener sin compuerta. Medido el 2026-10-09: **81 pantallas** en esa
  //     situación, entre ellas las cinco de Ruta Directa y las cuatro de MKT, que no tenían
  //     entrada por sidebar en ningún proyecto.
  { nombre: 'sidebar-tabs', script: 'check-sidebar-tabs.js', que: 'toda pestaña tiene entrada en el sidebar de su proyecto', push: true, ms: 120 },
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
  // `[DS.1]` / `[DS.3]` Las dos de la auditoría del design system (2026-10-02/03). ⚠️ Nacieron
  // cableadas SÓLO en `ci.yml` — o sea que `npm run check` no las corría y el push tampoco, que
  // es **el mismo defecto que este archivo existe para que no se pueda escribir**, en el otro
  // sentido (el encabezado cuenta que el 01-oct `tablas densas` y `tokens CSS` estaban sólo en
  // el push). Lo encontró la pregunta "¿queda algo pendiente?", no una corrida. Registradas acá
  // el 2026-10-03, que es lo que las mete en los DOS runners de una.
  { nombre: 'motion', script: 'check-motion.js', que: 'ninguna animación de Operations pasa el techo de 350ms (DESIGN §Motion)', push: true, ms: 376 },
  { nombre: 'estilos', script: 'check-estilos.js', que: 'escala --fs-*, hex crudo, breakpoints en px y foco sin anillo (DESIGN pre-vuelo 2/6/12c y §R)', push: true, ms: 3106 },
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
  // ⭐ `[PVI.18]` **Volvió a pasar el 2026-10-09** y este candado lo detecta EXACTO: `main` quedó
  // irreproducible porque `finanzas-presupuesto.component.ts` importaba un archivo sin trackear
  // (`[PVI.15]`). Nadie lo corrió antes de empujar — **costaba 141 s**, y una compuerta que nadie
  // corre no es una compuerta. El costo no era leer 27 MB: era **arrancar git 1,879 veces**
  // (~86 ms por `git show`, contra 113 ms del `ls-tree` entero). Con `git cat-file --batch`:
  // **141 s → ~8.7 s, 16×**, misma salida verificada contra los dos refs.
  // ⛔ SIGUE SIN `push: true`, y la decisión es de Edgar. ⚠️ El costo NO es «8.7 s contra un
  // criterio de ~3 s»: `gate-push.js:322` corre las compuertas en `Promise.all`, así que lo que
  // el equipo espera es la **PARED**, no la suma. Medido en vivo, 3 rondas, corriéndolas de
  // verdad en paralelo:
  //
  //     hoy, las 14          6,747 / 6,745 / 7,241 ms   →  ~6.9 s
  //     con commit-wiring   11,358 / 11,043 / 10,831 ms →  ~11.1 s     (+4.2 s, +61 %)
  //
  // ⛔ Acá yo había escrito que «los `ms` están medidos en aislamiento y subestiman ~2×».
  // **Es falso y lo refuta la tabla de la cabecera**: están viejos en las dos direcciones
  // (`tablas densas` declara 1,146 y sola tarda 225) y la inflación por concurrencia es
  // ADITIVA, no un factor — se nota más en las livianas, no en las pesadas. La única cifra que
  // decide es la pared de la rueda completa, medida hoy.
  //
  // El argumento a favor no es el tiempo: es que su modo de falla es TOTAL (un checkout limpio
  // no compila) y que **ninguna otra compuerta local puede verlo**, porque todas compilan el
  // árbol de trabajo, donde el archivo sí existe.
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
  //
  // ⭐ `push: true` agregado el 2026-10-09, y lo obliga una medición: el 09-oct `[TES.12]`
  // escribió LA MISMA LÍNEA, 16 días después del incidente y con esta compuerta ya existiendo.
  // Entre las 09:34 y las 11:31 TRES sesiones la arreglaron — dos de ellas sobre algo que ya
  // estaba arreglado en `main`. La compuerta corría en `npm run check` y nadie corre
  // `npm run check` antes de commitear; al push no llegaba. Cumple el criterio de admisión:
  // escaneo estático, sin red, sin DB, 2,273 ms medidos (tope ~3 s).
  //
  // ⚠️ Esos 2,273 ms se midieron EN AISLAMIENTO el mismo día. La corrida concurrente da 2,071,
  // de donde se concluyó ×0.91 («no se infla; las que se inflan son las pesadas que compiten por
  // disco»). ⛔ **Ese ×0.91 es un artefacto**: compara el `ms` DECLARADO contra la rueda, o sea
  // mide cuánto envejeció el número, no la contención. Medida SOLA hoy, ésta tarda **1,513 ms**
  // y en la rueda **2,225** → ×1.47, con +712 ms de castigo, igual que todas. Y el signo de la
  // regla estaba invertido: la que MENOS se infla es `estilos` (×1.16), la más pesada. Tabla
  // completa y el porqué —el castigo es aditivo, así que el cociente explota donde el
  // denominador es chico— en la cabecera, junto a la definición de `ms`.
  //
  // ⭐ **Y el `2,273` tampoco era un número viejo: lo medí hoy, tres corridas, 2,273/2,176/2,330.**
  // Re-medido unas horas después, CINCO corridas: 1,461/1,567/1,558/1,672/1,583. Mismo comando,
  // misma máquina, mismo día, **−32 %**. La dispersión DENTRO de cada tanda es chica (±7 % y
  // ±13 %); entre tandas es enorme. ⇒ La variable no es la antigüedad ni el método: es **cuántas
  // de las ocho sesiones estaban trabajando en ese momento**. Un `ms` suelto en esta máquina no
  // es reproducible ni contra sí mismo, así que **sólo es comparable contra otro medido en la
  // MISMA corrida** — que es exactamente por qué la única cifra que decide una admisión es la
  // pared de la rueda completa, con y sin la compuerta, tomadas una al lado de la otra.
  { nombre: 'set-bind', script: 'check-set-bind-param.js', que: 'sin parámetros ligados en sentencias SET (Postgres 42601)', push: true, ms: 2273 },
  // [MSH.2] H2: la confidencialidad de la cola de RH se rompe cuando alguien escribe una consulta NUEVA a `servicedesk.requests` sin saber
  // que existe lo confidencial. La lista de lectores es CERRADA: uno nuevo rompe el build y quien lo agrega escribe por qué es seguro.
  { nombre: 'sd-confid', script: 'check-service-desk-confidential-reads.js', que: 'sólo los lectores listados leen servicedesk.requests (lo confidencial no se filtra por una consulta nueva)', push: true, ms: 150 },
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
