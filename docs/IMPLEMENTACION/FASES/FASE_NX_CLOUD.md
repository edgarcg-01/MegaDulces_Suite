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

`contracts`, `api` y `finance` declaraban `lint` con `@nx/eslint:lint`, que el propio executor
avisa como deprecado. Los otros seis proyectos ya usaban el inferido.

Ningún proyecto del repo tiene config propia de eslint — la flat config de la raíz cubre todo —
así que el plugin puede inferir el target sin más. Se borraron los tres bloques.

**Antes/después, sin mover el veredicto:**

| Proyecto | Con executor explícito | Con target inferido |
|---|---|---|
| `contracts` | 6 problems (2 errors, 4 warnings) | **idéntico** |
| `api` | 213 problems (64 errors, 149 warnings) | **idéntico** |
| `finance` | 1096 problems (5 errors, 1091 warnings) | **idéntico** |

> ⚠️ Esos números son deuda de lint **preexistente**, no algo que esta fase introdujo. `lint`
> está rojo hoy.

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
  Hoy esos dos builds no aciertan el caché ni una vez.
- ⬜ **Distribución en agentes de Nx Cloud.** Depende del plan del workspace, que no se verificó.
- ⬜ **Lint de `database/**`:** 468 errores declarados, apagado a propósito.

### Deuda preexistente que esta fase midió pero no arregló

`lint` está rojo: 2 errores en `contracts`, 64 en `api`, 5 en `finance`. Es anterior a esta fase
y es parte de lo que costó tener el CI apagado desde el 2026-08-25.
