# Fase NX — Nx y Nx Cloud a profundidad (local y prod)

> **Estado:** 🧪 NX.4–NX.9 EN CÓDIGO · 2026-09-18
> **Pedido:** *"apliquemos nx y nx cloud a profundidad en local y prod"*
> **Antecedente:** `[NX.1]` (inputs de `build` con los assets de `database/`) y `[NX.3]` (corredor
> vitest inferido, retiro del plugin de webpack, `sharedGlobals`), ambos del 2026-09-17.
> **ADR relacionados:** ADR-056 (lo que no se puede medir se DECLARA), ADR-044 (lo que toca
> Postgres se prueba corrido de verdad).

---

## 0 · Lo que ya estaba, medido antes de tocar nada

La primera conclusión es que **Nx Cloud ya estaba conectado y nadie lo estaba usando en serio**.

| | Estado al 2026-09-18 |
|---|---|
| Nx | 23.1.0, daemon corriendo, caché local de **738 MB** |
| Nx Cloud | `nxCloudId` en `nx.json` desde el **PR #115**, workspace *claimed* |
| Caché remoto | **Funciona** — verificado, ver abajo |
| Prod (Railway) | **3 de 4 Dockerfiles compilaban con CERO caché de Nx** |
| CI (GitHub) | `disabled_manually`, última corrida 2026-08-25, cuenta bloqueada por facturación |
| Branch protection | `required_status_checks: null` — un PR rojo se puede mergear |
| `ci.yml` | Decía *"No hay Nx Cloud configurado"* y usaba `actions/cache` como sustituto |

### El caché remoto funciona — cómo se comprobó

No se asumió. Se corrió `contracts:test` con `NX_CACHE_DIRECTORY` apuntando a **dos carpetas
vacías distintas**:

1. Caché vacía #1 → `Cache: 0/1 hit (0%)`, corrió 1.4 s y **escribió** al remoto.
2. Caché vacía #2 (otra ruta, local igual de vacía) → `Cache: 1/1 hit (100%)`, **8 ms**.

Un hit con la caché local vacía sólo puede venir del remoto. **1.4 s → 8 ms.**

### Modos de falla del token, medidos

Antes de meter el token a los builds de producción había que saber qué pasa si falta o está mal,
porque un build de Railway que muere por un token es peor que no tener caché:

| Token | Resultado |
|---|---|
| Ausente | Nx usa la auth de la máquina / sigue con caché local. Exit **0** |
| Vacío (`""`) | Igual. Exit **0** |
| Inválido | `Invalid Credentials (CI Access Token) … (code: 401)` como *warning*. Exit **0** |

**Nunca tumba el build.** Eso habilita el cableado, y a la vez obliga a declarar su ausencia:
si el token falta, todo se ve igual que si estuviera. De ahí el paso "Declarar el caché remoto"
en CI.

---

## 1 · `[NX.4]` — Prod: los 4 Dockerfiles comparten un solo caché

### El desperdicio que se encontró

`Dockerfile.worker` corre `npx nx build api --configuration=production`. Eso es **exactamente la
misma tarea** que el `Dockerfile` principal ya compiló para el servicio api, del mismo commit,
minutos antes. Se compilaba **dos veces por release**.

No era un descuido de configuración: un cache mount de Railway lleva el Service ID adentro
(`id=s/<service-id>-nx2`), así que **es por-servicio por definición** — no hay forma de que el
worker vea lo que compiló la api. El caché remoto es la única capa que cruza esa frontera.

Y `Dockerfile.worker`, `apps/portal/Dockerfile` y `apps/vendor/Dockerfile` **no tenían ningún
cache mount**: hasta el redeploy del mismo commit recompilaba entero.

### Lo que se hizo

`ARG NX_CLOUD_ACCESS_TOKEN=` + paso del token en la línea del `nx build`, en los cuatro. El
Dockerfile principal conserva además su cache mount como primera capa (rápida, local).

Los 4 validan limpio con `docker build --check`.

### ⚠️ DECLARADO: portal y vendor NO van a acertar, y no es culpa del caché

Los dos hacen `sed -i` con un **reloj de pared** (`date -u`) sobre
`src/index.html` y `public/assets/version.json` **antes** del build. Los dos archivos viven bajo
`{projectRoot}/**/*` → namedInput `default` → `production` → los inputs de `build`.

**Cada build estampa un hash nuevo por diseño**, incluso recompilando el mismo commit.

Los tres caminos de salida se investigaron y se cerraron:

- **Estampar después del build:** no. `/index.html` y `/assets/**` están los dos en los
  `assetGroups` de `ngsw-config.json`; mutarlos post-build desfasa `ngsw.json` y el service
  worker entra en loop de re-fetch. Es la lección que el propio comentario del `sed` ya
  documenta, y sigue vigente.
- **Derivar la fecha del commit:** no se puede en el contenedor. `.dockerignore` excluye `.git`
  (línea 34).
- **Recibirla como build arg:** posible, pero requiere saber qué variable expone Railway con la
  fecha del commit, y eso **no se verificó** — no se inventa.

Qué cuesta realmente: sólo el **redeploy del mismo commit** (retry, rollback, botón de
"redeploy"). Un commit nuevo cambia el fuente igual. En `vendor` el sello se lee en **un solo
lugar**: la sonda de diagnóstico de `vendor-shell.component.ts`, al lado de `__BUILD_VERSION__`
—el commit— que ya identifica el build sin ambigüedad.

**Decisión abierta:** quitar el reloj de pared, o pasar la fecha del commit como build arg.

### Lo que falta para que esto rinda (acción humana)

1. Emitir un **CI Access Token de lectura/escritura** en `cloud.nx.app` → workspace → Settings →
   Access Tokens. *(No hay CLI para mintearlo.)*
2. Cargarlo como **build variable** `NX_CLOUD_ACCESS_TOKEN` en los servicios de Railway.

Lectura/escritura y no sólo lectura: con el CI apagado nadie más puebla los hashes de
`--configuration=production`, así que un token de sólo lectura no acertaría nunca.

---

## 2 · `[NX.5]` — CI cableado a Nx Cloud

- `env: NX_CLOUD_ACCESS_TOKEN` a nivel workflow (los tres jobs).
- **Se retiraron los dos `actions/cache` de `.nx/cache`.** Eran el sustituto de cuando no había
  Nx Cloud, y su propio comentario lo decía. Peor que redundantes: suben y bajan un tarball con
  lo mismo que el remoto ya sirve, y particionado por rama (`restore-keys`) — una rama nueva
  arrancaba en frío aunque otra corrida ya hubiera compilado ese hash exacto.
- Paso nuevo **"Declarar el caché remoto"**: si el secret falta, emite un `::warning` en vez de
  degradar callado (ADR-056).
- La cabecera del workflow dejó de afirmar algo falso y ahora lista, en orden, las **cuatro
  acciones humanas** pendientes.

### Lo que NO se hizo, con motivo

**Distribución en agentes (`nx-cloud start-ci-run --distribute-on`).** Consume créditos de
cómputo del plan de Nx Cloud, y cuál es el plan de este workspace **no se verificó**. Encenderlo
a ciegas es gastar sin medir. Es el siguiente paso natural una vez que el CI corra y se conozca
el plan.

---

## 3 · `[NX.6]` — Executors deprecados (vencen en Nx v24)

Ningún proyecto del repo tiene config propia de eslint — la flat config de la raíz cubre todo —
así que el plugin `@nx/eslint/plugin` puede inferir el target sin más. Se borraron los bloques
explícitos.

> ⛔ **Corrección del 2026-09-21.** La primera pasada dijo *"3 proyectos"* y **eran 12**: se
> muestrearon 6 proyectos (`contracts`, `view`, `api`, `portal`, `vendor`, `finance`), se
> encontraron 3 con el executor viejo y **se generalizó desde la muestra en vez de contar**. Lo
> delató el CI al encenderse: el log seguía imprimiendo `The @nx/eslint:lint executor is
> deprecated` después de la fase que supuestamente lo había retirado.
>
> Lección, que es la de siempre en este repo: **una muestra responde "existe", nunca "cuántos"**.
> El conteo se hace con `grep -rn '"@nx/eslint:lint"' --include=project.json`.

**Antes/después, sin mover el veredicto en ninguno de los 12:**

| Proyecto | Antes | Después |
|---|---|---|
| `contracts` | 6 problems (2 errors, 4 warnings) | **idéntico** |
| `api` | 213 problems (64 errors, 149 warnings) | **idéntico** |
| `finance` | 1096 problems (5 errors, 1091 warnings) | **idéntico** |
| `commercial` | 1467 problems (8 errors, 1459 warnings) | **idéntico** |
| `trade` | 707 problems (8 errors, 699 warnings) | **idéntico** |
| `logistics` | 217 problems (1 error, 216 warnings) | **idéntico** |
| `fiscal` | 130 problems (2 errors, 128 warnings) | **idéntico** |
| `reconciliation` | 129 problems (0 errors, 129 warnings) | **idéntico** |
| `platform-core` | 79 problems (3 errors, 76 warnings) | **idéntico** |
| `whatsapp` | 65 problems (0 errors, 65 warnings) | **idéntico** |
| `shared-scoring` | limpio | **idéntico** |
| `ui-web` | limpio | **idéntico** |

Verificación de cierre: `grep -rn '"@nx/eslint:lint"' --include=project.json` → **0 resultados**.

> ⚠️ Esos números son deuda de lint **preexistente**, no algo que esta fase introdujo. `lint`
> está rojo hoy, y eso tiene una consecuencia que se descubrió al encender el CI — ver §9.

---

## 4 · `[NX.7]` — El typecheck entra a Nx, y su gate deja de mentir

### Lo que se encontró primero

`npm run typecheck:fast` estaba **ROJO**, con 5 × `TS2307 Cannot find module`. Ninguno era un
error de código: `tsconfig.ts7.json` mantiene su mapa de `paths` **a mano**, y se había
desfasado de `tsconfig.base.json`.

- **Faltaban 6:** los 5 subpaths `@megadulces/contracts/authz/*` y `@megadulces/ui-web`.
- **Sobraban 3:** `@megadulces/shared-auth{,/core,/ui}` — una lib que **no existe** en el repo y
  que nadie importa.

Sincronizado el mapa: **verde en 5.5 s**.

### Por qué la duplicación no se puede eliminar (verificado, no asumido)

Poniéndole `extends: "./tsconfig.base.json"`, tsgo sale 1:

```
TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.
TS5090: Non-relative paths are not allowed. Did you forget a leading './'?
```

TS 7 removió `baseUrl` y exige paths relativos. **La duplicación es forzada por la herramienta.**
Entonces el arreglo durable no es volver a sincronizar a mano: es un candado.

### `scripts/check-ts7-paths.js`

Compara las claves **en los dos sentidos** y además el destino (normalizando el `./`). Un alias
que sobra es tan malo como uno que falta — el de `shared-auth` sobrevivió a la lib que lo
justificaba y nadie lo notó.

**Pruebas negativas ejercidas (las tres salen 1 y nombran el problema):**

| Caso | Resultado |
|---|---|
| Alias borrado de ts7 | ⛔ lo nombra, con la línea exacta para pegar |
| Alias que sólo existe en ts7 | ⛔ lo nombra |
| Mismo alias, destino distinto | ⛔ imprime los dos destinos |

> 🐛 El gate encontró un bug **en sí mismo** al primer intento: al quitar comentarios de JSONC,
> el regex de bloque corría **antes** que el de línea, y un comentario `//` que contenga `/*`
> —por ejemplo al documentar `authz/*`— abría un bloque falso que se comía el archivo.
> Síntoma: `Unexpected non-whitespace character after JSON at position 18`, en una línea sin
> relación. **El orden importa: primero las líneas `//`.**

### El target `typecheck` en Nx

`apps/api` compila con **SWC, que borra los tipos sin comprobarlos** → `nx build api` no
typechequea nada. Las tres apps Angular sí lo hacen en AOT. O sea que este target cubre el único
hueco real, y por eso vive en `api` y no en cada proyecto.

```
"inputs": ["default", "^default", "{workspaceRoot}/tsconfig.ts7.json"]
```

`tsconfig.ts7.json` va explícito porque vive en la **raíz**, fuera de `{projectRoot}`. Es la
misma regla que ya cobró con `database/migrations` en `build` (`[NX.1]`) y con `vitest.shared.ts`
en `test` (`[NX.3]`).

**Medido, incluida la invalidación:**

| | |
|---|---|
| En frío | 5.8 s |
| Con caché | **89 ms** (`1/1 hit`) |
| Tocando `tsconfig.ts7.json` | `0/1 hit` → **re-corre** ✅ |

Ese último renglón es el que importa: sin la línea de `inputs`, cambiarle los `paths` al
typecheck serviría un verde viejo.

Los dos entran a `npm run check` y a CI, y **`ts7-paths` va antes que `typecheck`**: si los mapas
divergen, el typecheck sale rojo por su propia config y se lee como un error del código.

---

## 5 · `[NX.8]` — La suite de regresión entra a Nx (sin caché)

Las ~218 pruebas de `database/run-all-tests.js` vivían **100% fuera de Nx**. Ahora
`database/project.json` declara el target `regression`.

### `cache: false`, a propósito

Estas pruebas leen y escriben **Postgres real** (varias bases, más un API en :3334). El estado de
la base **no entra en el hash de Nx**. Cachearlas serviría un ✔ viejo sobre datos nuevos — el
mismo modo de falla MUDO de `[NX.1]` y `[NX.3]`, pero peor: allá se servía un *build* viejo, acá
se serviría un **veredicto** viejo.

### ⚠️ `affected` acá vale menos de lo que parece

El proyecto no importa TypeScript de nadie, así que el grafo sólo lo marca afectado cuando cambia
`database/**`. Un cambio en `libs/finance` **no** lo dispara. Se podría forzar con
`implicitDependencies`, y **se decidió no hacerlo**: declararle una dependencia a cada lib que
alguna prueba toca es una lista que se desactualiza sola y miente en las dos direcciones.

El target **no se llama `test`**: si se llamara, `nx run-many -t test` y `npm run check` lo
arrastrarían y fallarían en cualquier máquina sin el API arriba.

Verificado corriendo de verdad: arranca por Nx, lee `.env`, clasifica el destino
(`compartida (192.168.0.245/platform_test)`) y la guarda de destino pasa sus 5 casos.

### El efecto colateral que se atajó, con número

Crear el proyecto hizo que `@nx/eslint/plugin` le **infiriera un `lint`**. Medido: **1089
problems (468 errors, 621 warnings)** sobre 238 archivos nunca lintados. Meter eso de golpe a
`npm run check` convierte una compuerta legible en un muro rojo heredado, y un rojo que nadie
puede bajar hoy es un rojo que se aprende a ignorar.

Se excluyó del plugin y **se declara la deuda**: 468 errores en `database/**`. Encenderla es una
decisión aparte, con su propio item — no un efecto colateral. Para medirla sin encenderla:
`npx eslint database`.

> ⚠️ **Gotcha:** `exclude` toma **patrones de archivo, no nombres de proyecto**. Con `"database"`
> a secas el plugin sigue infiriendo el target **y no avisa nada** — se ve idéntico a que
> funcionara. Va `"database/**"`. Lo dice el schema:
> `nx/schemas/nx-schema.json → definitions.plugins → exclude: "File patterns which are excluded by the plugin"`.

---

## 6 · `[NX.9]` — Nx 23.1.0 → 23.2.1

`nx migrate 23.2.1` reportó **cero migraciones que correr**, y movió **sólo `nx`** — dejando los
13 paquetes `@nx/*` en 23.1.0. Ese desajuste **no se dejó pasar**: las 23.2.1 de todos los
plugins están publicadas, así que se alinearon a mano antes del `npm install`.

Verificado después: `nx --version` 23.2.1, grafo intacto (18 proyectos), y el parche de
`patch-package` (`@capacitor-community/background-geolocation`) sigue aplicado — los warnings de
`allow-scripts` del install son política preexistente de npm sobre otros paquetes, no un fallo
del postinstall.

---

## 7 · Estado de los targets después de la fase

| Proyecto | lint | test | build | typecheck | regression |
|---|:--:|:--:|:--:|:--:|:--:|
| api | ✅ inferido | ✅ | ✅ | ✅ **nuevo** | — |
| view | ✅ | ✅ | ✅ | — | — |
| portal | ✅ | ⬜ | ✅ | — | — |
| vendor | ✅ | ✅ | ✅ | — | — |
| contracts, commercial, finance, reconciliation, ui-web | ✅ | ✅ | — | — | — |
| fiscal, logistics, platform-core, trade, whatsapp | ✅ | ⬜ | — | — | — |
| shared-scoring | ✅ | ⬜ | ✅ | — | — |
| feeds-ingest, trade-ingest-lanes | ✅ | ⬜ | — | — | — |
| **database** | ⛔ excluido | — | — | — | ✅ **nuevo** |

**No hay specs huérfanas**: todo proyecto que tiene archivos `.spec` tiene target `test` — eso lo
cerró `[NX.3]`. Los ⬜ son proyectos con **cero** specs, o sea deuda de *cobertura de pruebas*,
que es una conversación distinta de la de Nx y no se mezcla acá.

---

## 8 · Pendiente

### Acción humana (fuera del repo)

| # | Qué | Sin esto… |
|---|---|---|
| 1 | Emitir el CI Access Token **read-write** en `cloud.nx.app` | Nada del caché remoto rinde en prod ni en CI |
| 2 | Cargarlo como build var en los **servicios de Railway** | `api:build` se sigue compilando dos veces por release |
| 3 | Cargarlo como secret `NX_CLOUD_ACCESS_TOKEN` en **GitHub Actions** | El CI corre sin caché remoto (avisa con warning) |
| 4 | **Destrabar la facturación** de la cuenta `edgarcg-01` | Cualquier corrida muere en 3 s |
| 5 | `gh workflow enable CI` | El workflow sigue `disabled_manually` |
| 6 | Agregar **required status checks** a la branch protection de `main` | Un PR rojo se puede mergear igual |

### Decisiones abiertas

- ⬜ **El reloj de pared de portal/vendor.** Quitarlo o pasar la fecha del commit como build arg.
  Hoy esos dos builds no aciertan el caché ni una vez. **§10 la desbloqueó con una tercera salida
  medida:** `/build-info.json` en la raíz servida no cae en ningún `assetGroup` de ninguno de los
  dos `ngsw-config.json`, así que el reloj se puede sellar en el stage `runner` —después del
  build— sin desfasar `ngsw.json`, dejando sólo el commit adentro del hash de Nx.
- ⬜ **Distribución en agentes de Nx Cloud.** Depende del plan del workspace, que no se verificó.
- ⬜ **Lint de `database/**`:** 468 errores declarados, apagado a propósito.

### Deuda preexistente que esta fase midió pero no arregló

`lint` está rojo: 2 errores en `contracts`, 64 en `api`, 5 en `finance`. Es anterior a esta fase
y es parte de lo que costó tener el CI apagado desde el 2026-08-25.

---

## 9 · 2026-09-21 — el CI se encendió, y eso midió lo que faltaba

La facturación de `edgarcg-01` se destrabó y el workflow pasó a `active`. Las corridas duran
**2–4 minutos**, no los 3 segundos de las 25 muertes anteriores. Con eso, la fase deja de
apoyarse en suposiciones.

### Lo que quedó verificado en producción

| Qué | Cómo se comprobó |
|---|---|
| El token **ya no se filtra** | El build del `worker` del 21-sep: **0 ocurrencias** del token en claro (antes salía completo) |
| El caché remoto **funciona en Railway** | Mismo build: `shared-scoring:build → Remote Cache Hit`, `Cache: 1/2 hit`. El miss es `api:build` porque el código de api cambió — comportamiento correcto, no falla |
| El build y el typecheck **pasan en CI** | Job `Build & typecheck (affected)`: **SUCCESS** |

### ⛔ El defecto que el CI destapó: mis compuertas nunca corrían

En GitHub Actions **un paso fallado corta el job**. `Lint (affected)` está rojo por deuda
preexistente, y yo puse las compuertas nuevas **después** de él:

```
✗ Lint (affected)        ← muere acá
  Boundary type gate     ← nunca corre
  Provenance gate        ← nunca corre
  Comment gate           ← nunca corre
  Docker context gate    ← nunca corre
  TS7 paths gate         ← nunca corre
  Typecheck (affected)   ← nunca corre
  Test (affected)        ← nunca corre
```

O sea: **siete compuertas instaladas y ninguna reportando**, con el job en rojo de todos modos.
Un rojo que tapa a los otros seis es exactamente el defecto que `scripts/check-all.js` ya existía
para no cometer — su propio comentario lo dice: *"con `&&` el primer rojo tapa a los demás y no
se sabe si hay uno o cinco problemas"*. La versión de CI contradecía a la versión local.

**Arreglo:** `if: ${{ !cancelled() }}` en los 7 pasos posteriores. Todos reportan, el job sigue
fallando si alguno falla, y el resumen dice cuántos problemas hay — no cuál fue el primero.

### El estado honesto de las compuertas hoy

| Compuerta | Estado | De quién es |
|---|---|---|
| Build & typecheck (affected) | ✅ | — |
| Lint (affected) | ⛔ | deuda preexistente, ~12 proyectos |
| Test (affected) | ⛔ | `view:test`, 7 asserts — `PU.6` agregó `presupuestos` al `suite-map` sin actualizar la paridad de `SN.4` (sigue igual desde el 17-sep) |
| Secret scan (gitleaks) | ⛔ | **fuga real**, ver abajo |
| Las otras 5 | ⬜ NO MEDIDO hasta este arreglo | — |

### ⚠️ Hallazgo ajeno y urgente: gitleaks encontró una credencial de verdad

```
database/tests/http-store-analytics-breakdown-test.js:76
db-connection-string-with-password
commit 3afbebf8 · 2026-09-21 · franciscolopez-hash
```

Es un *fallback* `postgresql://usuario:clave@127.0.0.1:5432/postgres_platform` — host local, no
un prod alcanzable desde internet, así que **no es una puerta abierta**. Pero es una contraseña
en texto plano en un **repo público**, y sigue en `origin/main`.

Importa por una razón concreta y ya documentada: en este entorno **la contraseña del rol se
comparte entre sistemas** (`GOTCHAS §24`, el cluster `.245`). Si ésa es la misma, deja de ser
"la de mi máquina".

**Qué hacer:** sacar el literal (dejar que `DATABASE_URL_NEW` falle fuerte si no está) y rotar
si esa clave se usa en otro lado. **El historial no se reescribe solo** — el commit queda
público aunque se borre la línea.

> Es la misma familia que `§58`: *un secreto que viaja como texto en algo que alguien más va a
> leer*. Allá era un log de build; acá, un repo público.

---

## 10 · `[NX.10]` — El build de prod, medido paso por paso: compilar era el 38%

Disparado por *"los tiempos de compilación y build siguen siendo demasiado tardados… **en prod**"*.
La fase venía optimizando la **compilación** (caché local, caché remoto, `affected`). El log real
del deploy del **2026-09-21 09:03** (servicio `MegaDulces`, 5m 21s) dijo que ese no era el problema
principal.

| paso | tiempo | % |
|---|---|---|
| `nx run-many -t build -p view,api --parallel=1` | 2m 02s | 38% |
| `COPY --from=prod-deps --chown=node:node node_modules` | **1m 30s** | **28%** |
| `exporting to docker image format` | **1m 13s** | **23%** |
| `image push` (633.4 MB) | 21s | 7% |
| resto (unpack, upload, `COPY` de dist y database) | ~10s | 4% |

**Compilar era el 38%. Mover y empaquetar `node_modules` era el 58%.** Todo el esfuerzo previo
estaba puesto sobre la minoría del reloj.

### Lo que se encontró

`prod-deps` instalaba desde el `package.json` de la **raíz** — 116 deps de producción, porque ahí
conviven la api y tres apps de Angular. La imagen final corre exactamente dos cosas:
`node dist/apps/api/main.js` y `npx knex migrate:latest`.

Y el arreglo ya estaba escrito y sin usar: `apps/api/webpack.config.js` emite
`generatePackageJson: true` desde siempre, o sea que **cada build ya producía**
`dist/apps/api/package.json` con las **64** deps que el grafo de imports realmente usa, más su
`package-lock.json` podado (863 paquetes contra 1,331).

### Medido, no estimado

`npm ci --omit=dev` real adentro de Docker, los dos árboles:

| árbol de `node_modules` de producción | tamaño | archivos |
|---|---|---|
| manifiesto de la **raíz** (como estaba) | 1,210 MB | 102,821 |
| manifiesto **generado por el build** | 592 MB | 58,914 |
| | **−618 MB (−51%)** | **−43,907 (−43%)** |

Lo que sobraba: `@imgly` 184 MB · `@angular` 64 MB · `@zxing` 29 MB · PrimeNG + temas + iconos
26 MB · chart.js, leaflet, gsap, dexie, capacitor, ngrx, zone.js.

### La segunda causa: `--chown` en un `COPY` entre stages

Con `--chown`, BuildKit no puede reusar los inodos del snapshot origen y crea uno nuevo por
archivo. Sobre decenas de miles de archivos chicos, eso **es** el 1m 30s. El `chown -R` movido al
stage `prod-deps` queda dentro de una capa cacheada y el `COPY` del runner preserva el owner gratis.

### Antes/después, build local completo, misma máquina y misma sesión

| | viejo | nuevo | |
|---|---|---|---|
| `COPY node_modules` → runner | 88.6s | **26.9s** | −70% |
| `exporting to docker image format` | 115.3s | **85.3s** | −26% |
| imagen | 3.97 GB | **3.11 GB** | −860 MB |
| candado de externals | — | 0.7s | nuevo |

⚠️ Las dos causas se arreglaron en el mismo commit: **la atribución entre "menos archivos" y "sin
`--chown`" no quedó aislada.** Lo medido es el efecto combinado.

⚠️ El `npm ci` de `prod-deps` **no es comparable** entre las dos corridas (196.6s vs 50.4s): la
primera tenía el cache mount de npm frío. No se usa como número.

### ⛔ El modo de falla que esto abre, y su candado

`generatePackageJson` deriva la lista de los `externals` que **webpack ve**. Un
`require(unaVariable)` no está en el grafo → no entra al manifiesto → no se instala →
`MODULE_NOT_FOUND` **recién en el arranque de prod**. Un build verde no lo ve.

`scripts/check-bundle-externals.js` corre en el stage `runner` de los dos Dockerfiles: saca del
bundle emitido los `require("...")` **literales** —árbitro independiente del manifiesto— y exige
que cada uno resuelva contra el árbol podado. Si el recorte se pasa de listo, **rompe el build**.

- Prueba positiva: `✔ 59 externals … resuelven` (adentro del build real).
- Prueba negativa: contra un `node_modules` vacío sale 1 nombrando los 59.
- Lo que **no** cubre, declarado en el propio script: el `require` dinámico, que tampoco queda
  literal en el bundle. Para eso el testigo es arrancar el contenedor.

### Verificación de runtime (el testigo del segundo modo de falla)

Contra la imagen podada, en local:

| qué | resultado |
|---|---|
| `npx knex --version` | `Knex CLI version: 3.2.7` |
| `sh ./migrate.sh` sin DB | muere en `connect ECONNREFUSED`, **no** en `MODULE_NOT_FOUND` |
| `node dist/apps/api/main.js` | los ~200 módulos de Nest inicializan · **0 `MODULE_NOT_FOUND`** |

### Lo que cambia de operación

`prod-deps` ahora **depende de `builder`**. Sigue cacheándose por contenido del manifiesto, que
sólo cambia cuando cambia el grafo de dependencias de la api —bastante más raro que "cambió
código"— pero cuando cambia, paga el `npm ci` (~50s en caliente) en vez de los 5 ms de hoy. Y ya
no puede correr en paralelo con `builder`; hoy eso no costaba nada porque estaba cacheado.

### El resultado REAL en prod — y la proyección estaba mal

Deploy del **2026-09-21 16:10**, contra el de las 09:03 que fundó el diagnóstico:

| paso | 09:03 (antes) | 16:10 (después) | Δ |
|---|---|---|---|
| `nx run-many` | 2m 02s | 2m 58s | +56s · **ajeno** (no se tocó el stage `builder`) |
| `prod-deps` `npm ci` | 0 ms (cached) | **11s** | +11s · previsto y declarado (se estimó ~50s) |
| `COPY node_modules` → runner | 1m 30s | **52s** | **−38s (−42%)** |
| candado de externals | — | 1s | +1s |
| `exporting to docker image format` | 1m 13s | **1m 38s** | **+25s** ⬅️ |
| `image push` | 633.4 MB | **428.7 MB** | **−204.7 MB (−32%)** |

**Sobre los pasos que esta fase tocó, el neto es ≈ empate en wall-clock** (−38 +11 +1 +25), con la
imagen un 32% más liviana. **La proyección de −85s no se cumplió** y hay que leerla como lo que
era: una regla de tres sobre razones medidas en otra máquina, no una medición.

⚠️ **Los +25s de `exporting` quedan SIN ATRIBUIR.** Dos candidatos:

1. El `RUN` del candado quedó **después** del `COPY` de `node_modules` en el stage final, y esa
   capa obliga a BuildKit a diffear un filesystem con ~60k archivos recién copiados — trabajo que
   no aparece en el renglón del `RUN` (reportó 1s) sino en `exporting`.
2. El estado de la caché de capas del builder de Railway, que no se controla ni se observa.

**La medición local no sirve de árbitro**: ahí `exporting` bajó (115.3s → 85.3s), pero el build
viejo escribió *todas* las capas y el nuevo reusó `deps` y `builder`. n=1 de cada lado en prod.

#### ⭐ El tercer dato desarma las dos hipótesis de tamaño

Al rehacer el build local **en frío** con el candado ya movido:

| build local | imagen | `exporting` |
|---|---|---|
| viejo, **en frío** | 3.97 GB | 115.3s |
| nuevo, candado en `runner`, **en caliente** | 3.11 GB | 85.3s |
| nuevo, candado en `prod-deps`, **en frío** | 3.11 GB | **116.3s** |

En frío contra frío, **quitar 860 MB movió el export 1 segundo**. O sea que `exporting` no escala
con el tamaño de la imagen sino con **cuántas capas son nuevas** — y el `RUN` extra en el stage
final tampoco lo explica (el build que lo tenía fue el más rápido de los tres, por estar tibio).

Con eso, el candidato que queda para los +25s de prod es el **estado de la caché de capas del
builder de Railway**, que no se observa desde acá. **No se sigue persiguiendo.** Lo que sí bajó de
verdad y es atribuible es el `COPY` (−38s) y el push (−32%).

### `[NX.10.1]` — el candado se mueve a `prod-deps`

No porque esté probado que es la causa, sino porque **ahí es estrictamente más barato y cuesta
cero**: `prod-deps` es sólo fuente de un `COPY --from`, sus capas nunca se exportan. Elimina uno
de los dos candidatos sin apostar a cuál era. Va **después** del `npm ci` para no invalidarlo
(`main.js` cambia en cada build) y borra sus dos archivos en el mismo `RUN`.

Si el próximo deploy sigue con `exporting` arriba de 1m 30s, el candidato que queda es el builder
de Railway y hay que dejar de perseguirlo.

### ⭐ Lo que hay que mirar en el PRÓXIMO deploy

`COPY --from=prod-deps node_modules` costó 52s porque `prod-deps` era nuevo. Si el manifiesto de
la api no cambia, esa capa **debería cachear y costar ~0**. Con el esquema viejo eso no pasaba:
el `prod-deps` de las 09:03 estaba cacheado (5 ms) y aun así el `COPY` tardó 1m 30s. Entender por
qué esa capa no cacheaba es la próxima pregunta, y vale más que los 25s del export.

### ⬜ Lo que NO se tocó, con motivo

- **`--parallel=1`.** Nx recomienda en el log subir el paralelismo para recuperar 24.2s. El
  comentario del Dockerfile ya documenta por qué está en serie (2×4 GB de heap contra 8 GB de
  contenedor = OOM-kill sin línea de error). 24s no paga ese riesgo mientras haya 85s más baratos.
- **El reloj de pared de portal/vendor** (decisión abierta de §1). **Hallazgo nuevo que la
  desbloquea:** un archivo en la RAÍZ servida —`/build-info.json`— **no cae en ningún `assetGroup`**
  de ninguno de los dos `ngsw-config.json` (sólo listan `/index.html`, `/manifest.webmanifest`,
  `/*.css`, `/*.js`, `/favicon.ico`, `/assets/**` y extensiones de imagen/fuente). O sea que el
  sello se puede escribir **en el stage `runner`, después del build**, sin desfasar `ngsw.json`:
  el commit queda determinista adentro del hash de Nx y el reloj de pared sale afuera.
  No se hizo acá porque esos dos servicios salieron **`SKIPPED`** en el deploy medido → no hay
  antes/después que exhibir, y toca una sonda de diagnóstico que pide validación visual.
- **El `npm ci` sin cache mount de portal/vendor.** Cada build de esos dos baja las deps enteras
  de la red. Railway exige `id=s/<service-id>-…` y **no tengo los Service ID** de
  `Portal_MegaDulces` ni `Vendor_MegaDulces`. Acción humana: pasarlos.
