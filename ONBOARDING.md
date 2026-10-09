# Onboarding — Plataforma Mega Dulces

> De cero a API + frontend corriendo en tu máquina. Meta: **< 1 día**.
> Si algo de esta guía ya no coincide con la realidad, **corrígela en el mismo PR** — es responsabilidad de todos mantenerla viva.

---

## 0. Qué es esto (5 min de lectura)

Monorepo **Nx** con el backend (NestJS) y varios frontends (Angular) de la plataforma B2B / trade-marketing de Mega Dulces. Multi-tenant desde el origen (`tenant_id` + RLS de Postgres).

**Antes de escribir código, leé en este orden:**
1. [`CLAUDE.md`](CLAUDE.md) — contexto del proyecto, fases, reglas críticas. Se auto-carga en cada sesión de Claude Code.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — el mapa del sistema: apps, dominios, DBs, feeds, servicios externos.
3. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — términos de dominio y nombres internos (Thot/Horus/Maat, Kepler, fases…).
4. [`docs/ERP_KEPLER.md`](docs/ERP_KEPLER.md) — decode del ERP Kepler y el pipeline `kepler_ods` (si vas a tocar feeds/finanzas/compras).
5. [`docs/GOTCHAS.md`](docs/GOTCHAS.md) — trampas técnicas ya vividas (RLS, migraciones, permisos). **Antes de tocar DB o permisos.**
6. [`DESIGN.md`](DESIGN.md) — sistema de diseño. **Obligatorio antes de tocar UI.**
7. [`docs/IMPLEMENTACION/INDEX.md`](docs/IMPLEMENTACION/INDEX.md) — mapa de toda la documentación.
8. [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) — qué está hecho y qué falta.

---

## 1. Prerrequisitos

| Herramienta | Versión | Nota |
|---|---|---|
| **Node.js** | `>=20 <21` | El repo fija Node 20 (ver `engines` en `package.json`). Usá `nvm`. |
| **npm** | 10+ | Viene con Node 20. |
| **Docker Desktop** | reciente | Para el stack de DBs local (Postgres + pgvector + Redis). |
| **Git** | 2.40+ | |
| **VSCode + extensión Claude Code** | — | El flujo de trabajo del equipo es con Claude Code (ver §7). |

> **Windows**: usá **Git Bash** o **PowerShell**. Los scripts del repo corren en ambos, pero ojo con los gotchas de arranque de la API (§4).

---

## 2. Setup paso a paso

```bash
# 1. Clonar
git clone <repo-url> Trade_marketing
cd Trade_marketing

# 2. Instalar deps (usar ci, no install — respeta el lockfile)
#    PUPPETEER_SKIP_DOWNLOAD evita bajar Chrome (~120MB) que casi nunca se usa localmente.
PUPPETEER_SKIP_DOWNLOAD=true npm ci

# 3. Levantar las DBs locales (Postgres 5432 + pgvector 5433 + Redis 6379)
npm run dev:up

# 4. Crear tu .env desde el template MÍNIMO de dev (DBs locales ya configuradas)
cp .env.dev.example .env
#    Ya apunta a las DBs del Docker de arriba. Solo pegá las API keys que vayas a
#    usar (Anthropic, Cloudinary, etc.) — pedilas al lead por canal seguro; NO están
#    en el repo (§6). El API arranca igual sin ellas (se saltan esos flujos).
#    Para el env COMPLETO (prod/feeds/todos los servicios) está `.env.example`.

# 5. Correr migraciones (legacy + nueva DB multi-tenant) y seeds
npm run migrate:latest    # DB legacy
npm run migrate:new       # DB multi-tenant (postgres_platform)
npm run seed:new          # seeds baseline (tenant mega_dulces, roles, superoot)
npm run seed:testdata     # data de prueba comercial (brands/products/prices/customers/stock)
```

> Atajo: `npm run dev:bootstrap` hace up + ambas migraciones de un jalón.

> ⛔ **`migrate:new` sobre una base vacía NO llega al final** (2026-10-01): se detiene en la migración 88 (necesita el tenant, que crea la semilla `01`) y más adelante en la 435 —de las 975 que había ese día— (necesita `kepler_ods.*`, que crea la ingesta del ERP y no una migración). Hasta que se corrija este paso, la base de desarrollo se arma desde un dump **solo de estructura** de prod **o, sin acceso a prod, con el script de arranque** (2026-10-02): `npm run dev:bootstrap-vacia -- --url postgresql://postgres:postgres@127.0.0.1:PUERTO/BASE` (ver abajo). Ver [`docs/GOTCHAS.md` §75](docs/GOTCHAS.md).

> 🧪 **`npm run dev:bootstrap-vacia`** levanta una base desde cero completando lo que prod tiene por historia (las tablas de `kepler_ods.*` vacías desde el snapshot, perfiles, zonas, extensiones…) y **marca como aplicadas sin ejecutar** las ~70 migraciones que asertan sobre datos reales del ERP, dejándolas listadas en `public._dev_bootstrap_log`. **Esa base NO es prod**: sirve para probar un esquema (estructura, CHECK, RLS, permisos), **no** para medir nada del ERP. Se niega a correr si el host no es local, si el clúster tiene bases ajenas al stack, o si el clúster ya trae el `search_path` fijado por rol (**un clúster, una base**: las migraciones lo fijan por rol, o sea para todo el servidor — corré el stack en un Docker propio, no en el Postgres nativo de tu máquina).

> ⛔ **La «alternativa del lead» ya no existe.** Acá decía que se podía apuntar `DATABASE_URL_NEW` a `192.168.0.245:5432/postgres_platform`: ese espejo **no se usa desde el 2026-09-12** y hoy **ni conecta** (`3D000`), aunque `pg_database` lo siga listando. Si tu `.env` todavía lo trae, es exactamente la trampa que cierra [`GOTCHAS.md` §75](docs/GOTCHAS.md) — cambialo. El destino de desarrollo es el **Docker local**; la estructura real de prod sale del dump de arriba, **nunca** de apuntar el `.env` a prod.

---

## 3. Verificar que todo quedó bien

```bash
# Build de las 4 apps deployables (mismo comando que corre el CI)
npx nx run-many -t build -p api view portal vendor --configuration=production

# Regression suite (necesita la API arriba en :3334 — ver §4)
npm run regression
```

Si el build pasa, tu entorno está sano. La regression completa necesita la API corriendo + DBs sembradas.

---

## 4. Arrancar las apps

### Backend (API NestJS)

```bash
npm run api        # nx serve api  (modo simple)
# o con hot-reload:
npm run api:dev    # build --watch + node --watch dist/apps/api/main.js
```

> ⚠️ **Gotcha Windows**: `nx serve api` a veces falla con `ENAMETOOLONG`. Si te pasa, corré:
> ```bash
> npx nx build api && node dist/apps/api/main.js
> ```
> Esa es la forma confiable de arrancar la API en Windows.

La API levanta en **`127.0.0.1:3334`** (`API_PORT`, default 3334 — ver `apps/api/src/main.ts`),
que es el mismo puerto al que apunta el proxy del front (`apps/view/proxy.conf.json`)
y el que asume la regression. Swagger en `/api`.

### Frontends (Angular)

```bash
npm run view       # app principal (dashboard/admin/comercial/logística/vendor/televenta)
nx serve portal    # portal B2B del cliente
nx serve vendor    # app del vendedor (mobile-first)
```

Las 4 apps deployables son: **`api`**, **`view`**, **`portal`**, **`vendor`**.

---

## 5. Estructura del repo

> ⚠️ **La ingesta NO corre en tu máquina ni en la de nadie del equipo.** Vive en el servidor
> Linux `md` (`192.168.0.222`) desde el 2026-09-11: los ~13 carriles que alimentan `kepler_ods`
> son contenedores declarados en `ops/vl/`. Si venís a tocar un importer, leé primero
> [`ops/README.md`](ops/README.md) — **editar un importer es un deploy a prod**, y el despliegue
> tiene su propio script (`ops/vl/deploy.sh`).

```
apps/
  api/         → backend NestJS (todos los módulos de negocio)
  view/        → frontend admin/operaciones + módulos /portal y /vendor embebidos
  portal/      → portal B2B standalone (deploy separado)
  vendor/      → app vendedor standalone (Capacitor → Android)
libs/          → código compartido (design-tokens, whatsapp, finance, trade, logistics, platform-core…)
database/
  migrations*/     → migraciones Knex (¡nunca borrar aplicadas! ver §6)
  seeds*/          → seeds
  importers/       → cargadores de data (Kepler, Wincaja, testdata…)
  scripts/         → utilerías one-off (cutover, backfills, sync)
  tests/           → smoke tests (test-newdb-*.js = DB directo · http-*.js = E2E vía API)
  run-all-tests.js → runner de la regression suite
docs/IMPLEMENTACION/ → tracker, ADRs, log de revisiones, specs por fase
ops/           → qué corre en el SERVIDOR de ingesta (md) — leer ops/README.md
  vl/          → compose, agenda del cron, despliegue (deploy.sh) y runbooks de la mudanza
  ingest/      → Dockerfile de la imagen de los carriles + healthcheck de entrega
```

---

## 6. Reglas críticas (leer SÍ o SÍ)

Estas reglas nacieron de errores ya vividos en el proyecto. Romperlas cuesta caro.
El catálogo completo de trampas técnicas (RLS, transacciones, migraciones, permisos, dinero, cron)
está en **[`docs/GOTCHAS.md`](docs/GOTCHAS.md) — léelo antes de tocar DB o permisos.**

### ⛔ Nunca sin autorización explícita del lead
- **No borrar tablas ni columnas** en ninguna DB.
- **No borrar archivos de migración ya aplicados** → Knex valida `knex_migrations` vs filesystem y entra en *crash loop* ("directory corrupt"). Ya nos pasó.
- **No tocar CORS ni credenciales** (decisión pendiente del lead).
- **No hacer `git push` directo a `main`** (ver §8).
- **No `git add -A`** — commiteá archivos explícitos. El entorno tiene threads concurrentes y `-A` arrastra basura ajena.

### 🔐 Secretos
- El `.env` real **nunca** se commitea. Solo `.env.example` (sin valores).
- Los secretos reales (API keys, connection strings de prod) los pedís al lead por un canal seguro — **no** por chat/commit.
- Si alguna vez expones una credencial, **avísale al lead y rótenla de inmediato** (hay un incidente abierto de creds de prod pendientes de rotar).

### ✅ Convenciones
- **Migraciones idempotentes**: `if (!(await knex.schema.hasColumn(...)))` antes de `addColumn`. Siempre.
- Tablas nuevas: **`tenant_id UUID NOT NULL` + audit fields + RLS forzado**.
- Naming **snake_case** en DB. URLs/DTOs/columnas nuevas en **inglés** (español solo para términos de dominio: `exhibicion`, `folio`).
- Usar `Logger` de NestJS, **nunca** `console.log` en código nuevo.
- TZ del backend: `America/Mexico_City`. En `@Cron`, **fijar `timeZone` MX** o corre 6h tarde.
- Queries a tablas con RLS: usar `TenantKnexService.run()` o devuelven **0 rows** silenciosamente.

---

## 7. Cómo trabajamos con Claude Code

El desarrollo de este proyecto se apoya fuerte en **Claude Code**. Puntos clave para el equipo:

- **`CLAUDE.md` es la memoria compartida** — se auto-carga en cada sesión. Si aprendés algo no obvio del dominio, va ahí (o en `docs/`), no en tu cabeza.
- **La primera vez, orientá a tu Claude:** decile *"Leé `docs/CLAUDE_ONBOARDING.md` y seguí el protocolo para entender el proyecto."* Eso lo guía a leer los docs correctos en orden y armar el modelo mental antes de tocar código.
- **La memoria personal de Claude (`~/.claude/memory/`) es local a tu máquina** — no se comparte entre devs. El conocimiento que debe verlo todo el equipo va a `docs/` o `CLAUDE.md`.
- **Actualizá el tracker al cerrar cualquier item**: `01_TRACKER_PROGRESO.md` (estado ⬜→🔨→🧪→🚀→✅) y `03_LOG_REVISIONES.md` (al cerrar sprint). Es mandatorio, no opcional.
- **Decisiones técnicas relevantes → un ADR** en `02_DECISIONES_ARQUITECTURA.md`.

---

## 8. Flujo de Git (equipo de 4)

> ⭐ **SE TRABAJA SOBRE `main`.** Decisión de Edgar, 2026-10-08: commiteás y empujás a `main`, sin
> rama por feature. **Esta sección decía lo contrario** («el push directo a `main` ya no aplica») y
> quedó al revés. Las razones y lo que las motivó están en [`CLAUDE.md`](CLAUDE.md) arriba de todo.
>
> ⛔ **Una rama sólo se justifica si el trabajo no puede entrar a `main` a medias.** Si la abrís: va
> contra `main`, **nunca apilada sobre otra rama** (§8.0b explica por qué: un PR contra otra rama
> **no corre CI**), y se borra al mergear.

### 8.0 Lo primero, una sola vez por máquina

```bash
npm run hooks:install
```

Apunta git a `.githooks/`, que trae **tres** compuertas — y sin este comando **ninguna corre**:

| Hook | Qué hace |
| --- | --- |
| `pre-commit` | **(1)** Marcador de conflicto sin resolver → **bloquea** (94 ms sobre lo staged). Ya entró al repo una vez y rompió el build: `fix([RA-PRO.60-62]): resolver marcador de conflicto en compras.service`. **(2)** Escaneo de secretos con **gitleaks**. Existe desde el 2026-07-24, se escribió *después de una fuga de credenciales de prod al repo* — y nació «opt-in», mencionado sólo en el CHANGELOG. Medido el 2026-09-30: `core.hooksPath` estaba **sin configurar**, o sea que llevaba **dos meses sin correr para nadie**. |
| `pre-push` | Corre 13 gates estáticos sobre **tus** archivos (en paralelo). No te frena con la deuda preexistente del repo: te la informa aparte. ⛔ **Acá decía que «bloquea el push directo a `main`» y era FALSO** — medido el 2026-10-08: la palabra `main` no aparece ni una vez en `.githooks/pre-push`, y los pushes directos pasan. Hoy además sería al revés de la regla. |
| `post-checkout` | Avisa cuando **cambiaste la rama de un árbol compartido** y cuando tu línea lleva >20 commits sin sincronizar. No bloquea: corre después del hecho. Ver §8.1. |

⛔ **Acá decía que «hoy `main` no tiene protección del lado de GitHub» y es FALSO desde el
2026-10-02.** Medido el 2026-10-08, `main` exige `Build & typecheck (affected)` + `Secret scan
(gitleaks)`, y bloquea force-push, borrado e historia no lineal. ⚠️ Pero **`enforce_admins` está en
`false`**, así que el admin las saltea y nadie más: de los últimos 40 commits, **30 son pushes
directos de Edgar y cero de los otros cuatro**, que entran 100% por PR. O sea que "se trabaja sobre
`main`" hoy es cierto para **una** persona; para que valga para el equipo hay que decidir qué pasa
con esos checks.

⭐ **Lo que de verdad separa un commit roto de producción NO es ninguna de esas dos cosas: es
`ci-green`.** El job `sellar` sólo mueve esa rama marcadora si `build` + `secret-scan` pasan, y
`ops/prod/auto-deploy.sh` se niega a desplegar un commit que el sello no bendijo. `main` puede
ponerse roja — lo rojo no llega a prod, pero tampoco llega nada más hasta que la arregles.

> `npm run hooks:check` te dice si quedó activo · `npm run hooks:uninstall` lo desactiva.
> El escape de emergencia es `git push --no-verify`, y deja rastro: el CI lo va a marcar igual.

---

1. **Trabajás sobre `main`.** `git switch main && git pull --rebase` antes de empezar.
   ⭐ Eso **no** significa todos sobre el mismo checkout: **una sesión, un worktree**
   (`git worktree add -B <tema> /c/tmp/<tema> origin/main`). Trabajar todos sobre la misma rama y
   trabajar todos sobre el mismo *árbol* son cosas distintas, y la segunda es la que rompe:
   medido el 2026-10-08, el checkout compartido quedó divergido y **nadie podía ni traer ni
   empujar**, y un rebase falló dos veces porque otra sesión escribía mientras tanto.
2. **Commits** con la convención del tracker: `feat([RA.11]): descripción` — el código entre brackets viene del tracker.
3. **Empujás a `main`.** El `pre-push` corre tus 13 gates antes de dejarte. Si algo sale rojo, es
   **tuyo** (la deuda ajena se informa aparte y no frena).
4. **Antes de empujar, aplicá el protocolo de §8.0b.** Sigue valiendo entero: fundir `origin/main`
   y volver a probar, las reglas de migraciones, y declarar los cambios de comportamiento. Con
   push directo importa **más**, no menos: ya no hay un PR donde el CI corra antes de que entre.
5. **Una rama sólo si el trabajo no puede entrar a `main` a medias.** Va contra `main`, **nunca
   apilada sobre otra** (§8.0b dice por qué: un PR contra otra rama **no corre CI**), y se borra al
   mergear — `delete_branch_on_merge` está prendido. ⚠️ Hay un barredor semanal
   ([`.github/workflows/ramas-abandonadas.yml`](.github/workflows/ramas-abandonadas.yml)) que borra
   lo que lleva 30 días sin PR abierto; si aparcás algo a propósito, anotalo en
   [`.github/ramas-protegidas.txt`](.github/ramas-protegidas.txt) o lo perdés.
6. ⛔ **Acá decía «al menos 1 review de otro dev» y describe algo que no ocurre.**
   `required_approving_review_count` es **ninguna** y 1 de los últimos 25 PRs mergeados tuvo
   reseña. Se deja escrito porque una línea que describe un proceso inexistente se cita para dar
   por revisado lo que nadie miró. Si se quiere revisión de verdad, se prende en la protección.
7. ⛔ **Y decía «mergear a `main` despliega a producción en ≤5 min»: FALSO desde `[CD.22]`.** El
   vigía ya no mira `main` sino **`prod-release`**, que mueve una persona con
   `sh ops/prod/soltar.sh`. Empujar a `main` **no** despliega: deja el commit sellado y listo para
   soltar. Detalle en [`ops/prod/RUNBOOK-despliegue.md`](ops/prod/RUNBOOK-despliegue.md) §0.1.

---

### 8.0b Antes de pedir revisión — el protocolo previo al PR

> **Origen:** feedback de Edgar en #304 y #305 (2026-10-08), lo que valoró en #336 (2026-10-09) y el rojo del CI de #346 (2026-10-09). Cada punto es algo que **ya costó** o que **sí se valoró**: se midió al mergear, no es teoría. La plantilla del PR trae las mismas casillas; esta sección dice **por qué** y **cómo**.

**1. El PR apunta a `main`. Siempre. No se apilan PR sobre ramas de feature.**
- **Por qué:** el CI sólo corre con `pull_request: branches: [main]`. Un PR apuntado a otra rama **nunca se compila**: #305 llegó con 411 líneas que ningún compilador había visto. Y **re-apuntar la base no dispara el CI** (GitHub corre con `opened`/`synchronize`; cambiar la base no es ninguno): lo dispara un *push*.
- **Y el squash rompe la cadena:** el PR #1 entra aplastado, con un SHA que no coincide con ninguno de sus parches, así que `git rebase origin/main` del PR #2 **re-aplica y choca** con los commits del #1. Hubo que trasplantar por cherry-pick.
- **Cómo:** si el sprint B depende del A, **espera a que A se fusione** y abre B contra `main`. Si ya hay una cadena: rama nueva desde `origin/main` + `git cherry-pick` de **tus** commits (`git log --oneline pAnterior..pTuyo`), y **empuja** para que corra el CI.

**2. La rama va al día con `main` — y se vuelve a probar después.**
- **Por qué:** #304 llevaba 14 commits de atraso: su CI verde describía **un `main` que ya no existía**. GitHub aprueba la rama contra el `main` de hace un rato y mergea contra el de ahora, **sin recompilar el resultado**; `main` se rompió dos veces el 2026-10-08 exactamente así.
- **Cómo:** al final, `git fetch origin && git merge origin/main` (o rebase), y **vuelve a correr** build + tests de lo afectado. Si hubo conflicto en `database/run-all-tests.js`, compara **conjuntos**, no conteos.

**3. Migraciones: sin colisión de marca, y jamás renombrar una aplicada.**
- **Por qué:** tres de mis migraciones usaron marcas contiguas a las de `main`; otro PR tomó `…330000` mientras el mío estaba abierto y Edgar tuvo que renombrar la mía. **Renombrar una migración ya aplicada** deja `knex_migrations` apuntando a un archivo que no existe → *«migration directory is corrupt»*, que ya frenó el aplicador dos veces. `main` lleva cinco colisiones de marca de un solo día, **todas aplicadas y por tanto irreparables**.
- **Cómo:**
  - Corre `npm run check:mig-colisiones` **al abrir el PR y otra vez justo antes del merge** (vive en `Lint & test`, que **no es obligatoria**: nadie lo hace por ti). Necesita `PROD_DB_URL` en tu `.env` (sólo hace `SELECT` del ledger): **sin ella no se pone verde a propósito** —no puede distinguir una migración recién escrita de una ya aplicada, y recomendaría justo el renombre que rompe prod—. Sin la URL usa `npm run check:mig-colisiones -- --solo-git`: es un análisis **parcial**, y así hay que reportarlo en el PR («sin ledger de prod»), no como verde.
  - La marca es la **hora real de creación** (`AAAAMMDDHHMMSS`), no «la siguiente del hueco».
  - Si hay colisión y la otra **ya se aplicó**, la tuya cambia **antes** de aplicarse; si la tuya también se aplicó, **no la renombres**: avisa al lead.
  - Una migración **aditiva que el código nuevo lee** va **antes** del código; una que cambia lo que el código viejo lee, con él o después. Dilo en el PR.

**4. Declara lo que cambia para quien ya usa la función.**
- Qué comportamiento cambia, **para quién** y qué se rompe (p. ej. «poner en espera ahora exige motivo: una integración por API sin `pause_reason` recibe 400»), y **lo que el PR NO incluye**. Es lo que Edgar valoró de #304: *«casi nunca se dice»*.

**5. Pruebas con evidencia.** Pega lo que corriste y el resultado (conteos, no «pasa»); si es una compuerta o una defensa, la **prueba negativa** (rómpela a propósito y muestra el rojo).

**6. Si cambias un tipo compartido (`libs/contracts`), recorre TODOS sus consumidores — y no escribas «compila» sin haberlo medido.**
- **Por qué:** #346 (MSH.2) volvió `priority` nullable en el contrato (`SdPriority | null`) y tres plantillas de `apps/view` indexaban `PRIORITY_LABEL[t.priority]` → **`TS2538: Type 'null' cannot be used as an index type`**, que tiró `Build & typecheck`. `nx test view` pasó **2657 verdes** porque **vitest no tipa las plantillas Angular**; y el PR decía «la app compila», cosa que nadie había medido. Un test verde no es una compilación.
- **Cómo:** `git grep` del campo cambiado en `apps/*` y `libs/*` **incluidas las plantillas** (`{{ x[campo] }}`, `[attr.data-p]`, `@if`); estrechar el tipo con `@if (campo) {…}` en vez de indexar a ciegas. En el PR di la evidencia real: o pegas el build, o dices «lo compila el CI» (si no se compila en local, que es la regla de sesión), y **no pides revisión con `Build & typecheck` en rojo**.

**7. Lo que Edgar valoró en #336 — mantenerlo en los PR de seguridad y de base de datos.**
- Las pruebas **intentan violar la defensa y esperan el error exacto** (`ERRCODE 23514`), no sólo el camino feliz; y cada defensa se prueba **apagándola** una por una.
- Si el PR es **más estricto que el plan**, dilo (aquí: se prohibió también el sentido inverso, normal → confidencial).
- Los triggers y funciones multi-tenant **filtran por `tenant_id`** en el `SELECT` que hacen (ahí es donde se rompen en silencio).
- Declara qué RLS tienen las tablas que tocas y **verifícalo contra producción** (`relrowsecurity` y `relforcerowsecurity`), en vez de suponerlo; y mide que la marca de tiempo de la migración no solape con `main`, los PR abiertos y lo ya aplicado.

> 🤖 Los comentarios de `nx-cloud` («AI Fix») en los PR son ruido del bot (la organización de Nx Cloud está deshabilitada): no son feedback ni hay que atenderlos.

---

### 8.1 Si trabajás con varias sesiones de Claude en la MISMA carpeta

Esto aplica a la máquina de trabajo de Edgar, no a los devs remotos. **Medido el 2026-10-02:
11 sesiones sobre el mismo árbol, el mismo `.git/index` y la misma rama.**

Git tiene **una sola rama activa por árbol de trabajo**. No es una convención: es físico. Así
que todo lo de abajo sale de daños reales, no de preferencias.

**1. Nadie hace `git switch`.** Una sesión fija la rama del día; el resto trabaja donde esté.
Un `switch` arrastra a las otras diez a mitad de su tarea, en silencio.
*Pasó dos veces el 2026-10-02 en una sola sesión*: la primera la movió de `main` a
`integra/trabajo-local-2026-10-02`; la segunda, de vuelta a `main` — y **dejó dos commits de
compuertas en la rama que quedó atrás**, con los archivos desaparecidos del disco. El
`post-checkout` existe para que eso se vea en el acto en vez de descubrirse comparando SHAs.

**2. Commitear SIEMPRE con pathspec:** `git commit -q -F msg -- ruta1 ruta2`.
El índice es compartido: un `git commit` sin rutas se lleva lo que otra sesión dejó stageado.
Antes de cada uno: `git diff --cached --stat`.

**3. Sincronizar a diario, no al final.** Los conflictos no vienen del volumen, vienen de la
**edad**: los 5 PRs abiertos del mismo día estaban `CLEAN` y el único de 3 días, `DIRTY`.
El `post-checkout` avisa pasados **20** commits de divergencia — umbral medido, no estimado:
con **42** costó **9 conflictos** traer **4** commits remotos.

**4. Resolver conflictos por BLOQUE, nunca por archivo.** `git checkout --ours/--theirs` toma
el archivo **entero** y tira lo que el otro lado cambió en zonas que ni estaban en conflicto.
*Medido en `ops/prod/deploy.sh`*: `--ours` habría borrado `SERVICIOS_DEF="registry backup"` y
el cambio a `pgprod.sh`, que no tenían nada que ver con el bloque en disputa.

**5. Antes de descartar un lado, probá que el otro es superconjunto.**
`git log --oneline <rama-A> -- <archivo>` contra `<rama-B>`. Así se salvaron 300 líneas de
`commercial-analytics.service.ts`: una rama traía `IG.7→IG.8→IG.9→IG.10` y la otra la foto
vieja de `IG.7`; «el que tiene más líneas gana» habría acertado por casualidad, y la próxima no.

**6. Un solo nombre para la rama de integración.** Hoy conviven cinco formas
(`integrate/local-*`, `integrate/local-5-*`, `integra/trabajo-local-*`, `integra/pendientes-*`,
`integra/todo-*`) porque cada sesión inventa la suya. **La forma es `integra/<tema>-<AAAA-MM-DD>`.**

**7. Lo que NO está versionado puede ser trabajo ajeno en vuelo.** Antes de borrar un `.tmp-*/`
o un `.txt` suelto de la raíz, mirá `git status`: si no es tuyo y no está en git, es de otra
sesión. *El 2026-10-02 una sesión borró 4 capturas que `docs/CAOS_CASH_SYSTEM.md` cita por
nombre; commitear ese borrado habría dejado el doc apuntando a archivos inexistentes.*

**Antes de pedir review, localmente:**
```bash
npx nx affected -t lint          # lint de lo que tocaste
npx nx affected -t test          # tests de lo que tocaste
npx nx run-many -t build -p api view portal vendor --configuration=production
```

---

### ⚠️ Qué está forzado de verdad hoy, y qué no — medido el 2026-09-30

No hay ninguna protección del lado de GitHub. **Ninguna.** El repo pasó a privado y la cuenta está
en plan free, así que GitHub responde `403` tanto a `branches/main/protection` como a `rulesets`:

> *"Upgrade to GitHub Pro or make this repository public to enable this feature."*

Esto **no es un descuido de nadie**: la compuerta no existe porque el plan no la incluye. La línea
que antes decía *"`main` está protegida"* quedó de cuando el repo era público — y era falsa desde
entonces, porque aun con protección `required_status_checks` estaba en `null`.

Lo que eso costó, medido sobre los 30 días previos:

| Qué se midió | Resultado |
| --- | --- |
| Commits a `main` que entraron por **push directo**, sin PR | **~58 de 60** |
| De los últimos 20 pushes a `main`: **rojos** | **15** |
| …de esos mismos 20: **verdes** | **1** |

El CI **no está roto** — corre y atrapa defectos reales. El problema es que corre *después* del
merge, sobre la rama de la que se deploya.

⛔ **Y no va a haber protección de GitHub: la cuenta no pasa a Pro** (decisión del 2026-09-30).
Esto no es un pendiente, es el escenario definitivo. Volver el repo a público también la
desbloquearía, y se descartó: los docs traen IPs internas, hostnames de DB y cifras del negocio.

**Entonces la compuerta se mueve a donde SÍ somos dueños — hay dos, y sólo una manda:**

| | Dónde vive | Fuerza |
| --- | --- | --- |
| **`.githooks/pre-push`** (§8.0) | tu máquina | **Débil.** Se evade con `--no-verify` y no existe para quien no corrió `npm run hooks:install`. Sirve por rapidez: te dice en 2.5 s lo que el CI te diría en 5 min. |
| **`[CI.SELLO]`** | el servidor `md` | ⭐ **Fuerte.** Nadie la evade. |

⭐ **Cómo funciona `[CI.SELLO]`**: producción dejó Railway el 2026-09-22 y hoy la despliega
`ops/prod/auto-deploy.sh` desde `md`. Cuando el CI pasa `build` + `secret-scan`, el job `sellar`
mueve la rama marcadora **`ci-green`** al commit probado. El auto-deploy **se niega a desplegar un
commit que `ci-green` no haya bendecido**.

O sea: **`main` puede ponerse roja, pero lo rojo no llega a producción.** El merge no está
protegido; el despliegue sí. Es menos de lo que daría Pro, y es lo que se puede tener gratis.

- Qué frena: build roto (el código no compila) · secreto filtrado. Nada más.
- Qué **no** frena, a propósito: lint, tests y compuertas de estilo (`verify`). Hoy están rojos por
  deuda preexistente, y exigirlos dejaría a producción sin despliegues desde el primer día. Se
  declaran en el CI. Apretar esto exige antes partir `verify` en dos y medir.
- Si el CI todavía no terminó, el deploy **espera** (reintenta cada 5 min); recién a los 30 min lo
  considera falla y grita en Salud BD.
- Escape de emergencia, en `md`: `AUTO_DEPLOY_SIN_CI=1 sh ~/ops/prod/auto-deploy.sh`.
- El candado tiene su propia prueba, con dos casos negativos: `npm run check:compuerta-ci`.

**Y sigue habiendo una cosa que sólo hace una persona:** mirar el CI antes de aprobar un PR.
`ci-green` cuida producción, no la calidad de lo que entra a `main`.

---

### 8.1 Si clonaste el repo ANTES de tener acceso de escritura

⚠️ El repo **era** público y hoy es **privado** (y además se renombró a `MegaDulces_Suite`). Si
clonaste en esa época sin ser colaborador, tus commits
probablemente quedaron en tu `main` local, que **no se puede empujar** (está protegida). Los cambios
no se pierden; hay que moverlos a una rama.

```bash
# 1. Aceptá la invitación de colaborador que te llegó por correo (o en
#    https://github.com/edgarcg-01/MegaDulces_Suite/invitations). Sin eso, el push rebota con 403.
#
#    ⚠️ El repo se renombró: si tu clon es viejo, tu `origin` todavía dice `Trade_marketing`.
#       GitHub redirige, pero conviene corregirlo:
#         git remote set-url origin https://github.com/edgarcg-01/MegaDulces_Suite.git

# 2. Mirá qué tenés: commits propios en main local + lo que no esté commiteado.
git log --oneline origin/main..HEAD      # tus commits que no están en el remoto
git status --short                        # lo que aún no commiteaste

# 3. Pasá TODO eso a una rama con nombre (no pierde nada: sólo mueve el puntero).
git switch -c feat/<descripción-corta>

# 4. Si te quedaron cambios sin commitear, commiteálos ahora en la rama.
git add <archivo> [<archivo>...]          # archivo por archivo — NUNCA `git add -A`
git commit -m "feat([CÓDIGO]): descripción"

# 5. Devolvé tu main local a donde está el remoto, para no arrastrar divergencia después.
git fetch origin
git switch main && git reset --hard origin/main
git switch feat/<descripción-corta>

# 6. Empujá la rama y abrí el PR.
git push -u origin feat/<descripción-corta>
gh pr create --base main --fill
```

⚠️ **`git add -A` no**, nunca. En este repo varias personas editan el mismo working tree y los mismos
archivos; barrer todo con `-A` se lleva trabajo ajeno al commit. Pasó **cuatro veces** en una sola
sesión de trabajo. Verificá `git diff <archivo>` antes de agregarlo.

⚠️ **Antes de crear una migración**, mirá `public.knex_migrations` en **prod**, no sólo el filesystem:
con 4 personas los timestamps chocan, y una migración puede estar aplicada sin que el archivo exista
en tu clon (ver `docs/GOTCHAS.md`).

---

## 9. Troubleshooting rápido

| Síntoma | Causa / fix |
|---|---|
| `nx serve api` → `ENAMETOOLONG` (Windows) | Usar `nx build api && node dist/apps/api/main.js`. |
| Query devuelve 0 rows sin error | Falta `TenantKnexService.run()` (RLS forzado). |
| Migración crashea el boot / "directory corrupt" | Alguien borró/renombró una migración aplicada. **No borrar migraciones aplicadas.** |
| `@Cron` corre 6 horas tarde | Falta `timeZone: 'America/Mexico_City'` en el decorador. |
| Dinero llega como string y rompe cálculos | Postgres `numeric` → string en JS. Envolvé en `Number()`. |
| `npm ci` se cuelga bajando Chrome | Prefijá `PUPPETEER_SKIP_DOWNLOAD=true`. |
| El build pasa en local pero rompe en CI | Verificá con `--configuration=production` (budgets de Angular + TS estricto). No confíes en `nx serve`. |
| Nx cachea un resultado viejo | Agregá `--skip-nx-cache` para forzar el rebuild real. |

---

## 10. Reset de entorno

```bash
npm run dev:down            # baja los contenedores (conserva data)
npm run dev:reset           # baja + BORRA volúmenes + vuelve a levantar limpio
```

---

**¿Algo faltó o quedó desactualizado?** Editá este archivo en tu PR. Un onboarding que miente es peor que no tener onboarding.
