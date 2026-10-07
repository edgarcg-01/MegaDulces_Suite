# Handbook del dev nuevo — contexto, reglas y límites

> **Para qué es este archivo:** es el documento que se instala en una máquina/equipo nuevo que va a
> desarrollar en esta plataforma. Trae, en un solo lugar, el contexto de programación, las reglas duras
> y los límites (lo que **no** se hace sin autorización).
>
> **No reemplaza a los docs vivos** — los consolida. Cuando algo de acá contradiga a
> [`ONBOARDING.md`](../ONBOARDING.md), [`CLAUDE.md`](../CLAUDE.md) o [`docs/GOTCHAS.md`](GOTCHAS.md),
> **mandan esos** y este archivo se corrige en el mismo PR. Un handbook que miente es peor que no tenerlo.
>
> Última revisión del consolidado: **2026-09-15**.

---

## 0. Los 10 minutos que te ahorran una semana

Si sólo vas a leer una cosa antes de escribir código, que sea esto:

1. **Todo es multi-tenant con RLS forzado.** Una query sin contexto de tenant devuelve **0 filas sin error**.
   Es el bug #1 del proyecto y es invisible en logs.
2. **Cada request corre en UNA transacción.** Un `try/catch` que traga un error de DB y sigue queryeando
   deja la transacción abortada → el usuario ve `200 OK` y **nada se guardó**.
3. **Nunca borres ni edites una migración ya aplicada.** Borrar una = crash loop en prod.
   Agregarle columnas después = esas columnas **nunca llegan** a donde ya corrió.
4. **Agregar un permiso son 5 cables** (6 si es un proyecto nuevo). Si falta uno: 403, o casilla invisible.
5. **`main` está protegida.** Rama por feature → PR → review. **Nunca `git add -A`**.
6. **Lo que no se pudo medir se DECLARA, no se dibuja como cero ni como verde** (ADR-056).

---

## 1. Qué es el proyecto

Monorepo **Nx** con el backend (NestJS) y los frontends (Angular) de la plataforma B2B / trade-marketing de
**Mega Dulces** (distribuidora de dulces en México). **Multi-tenant desde el origen** (`tenant_id` + Row Level
Security de Postgres). Primer tenant: `mega_dulces`.

Arrancó como app de auditoría de ejecución en punto de venta y hoy cubre comercial, inventario/almacén,
logística, finanzas, fiscal, compras, telemarketing, portal B2B y app de vendedor — más tres motores de AI
internos (**Thot** comercial, **Horus** trade, **Maat** finanzas).

**Stack:** NestJS 11 + Knex + PostgreSQL + Socket.IO · Angular standalone + PrimeNG + Tailwind + Spartan UI ·
Capacitor + Dexie (vendor mobile) · Nx + Docker + Railway.

**Las 4 apps deployables:** `api`, `view`, `portal`, `vendor`.

---

## 2. Prerrequisitos de la máquina

| Herramienta | Versión | Nota |
|---|---|---|
| **Node.js** | `>=20 <21` | Fijado en `engines` de `package.json`. Usá `nvm` (o `nvm4w` en Windows). |
| **npm** | 10+ | Viene con Node 20. |
| **Docker Desktop** | reciente | Para el stack local (Postgres 5432 + pgvector 5433 + Redis 6379). |
| **Git** | 2.40+ | |
| **VSCode + extensión Claude Code** | — | El flujo del equipo se apoya fuerte en Claude Code (§9). |
| **`gh` CLI** | opcional | Para abrir PRs desde la terminal. |

**Windows:** funciona con Git Bash o PowerShell. Ojo con el arranque de la API (§4) y con OneDrive
(rompe operaciones grandes de git como `rebase` — pausalo, o preferí `cherry-pick`).

---

## 3. Setup paso a paso

```bash
# 1. Clonar
git clone <repo-url> MegaDulces_Suite
cd MegaDulces_Suite

# 2. Instalar deps — SIEMPRE `ci`, no `install` (respeta el lockfile)
PUPPETEER_SKIP_DOWNLOAD=true npm ci        # evita bajar Chrome (~120MB)

# 3. Levantar las DBs locales
npm run dev:up

# 4. Crear tu .env desde el template mínimo de dev
cp .env.dev.example .env
#    Ya apunta al Docker de arriba. Las API keys (Anthropic, Cloudinary...) se piden al lead
#    por canal seguro — NO están en el repo. La API arranca sin ellas (se saltan esos flujos).
#    El env COMPLETO (prod/feeds) está en `.env.example`, sólo como referencia de nombres.

# 5. Migraciones + seeds
npm run migrate:latest    # DB legacy
npm run migrate:new       # DB multi-tenant (postgres_platform)
npm run seed:new          # tenant mega_dulces, roles, usuario base
npm run seed:testdata     # data comercial de prueba
```

Atajo: `npm run dev:bootstrap` = `dev:up` + ambas migraciones.

**Alternativa (la del lead):** apuntar `DATABASE_URL_NEW` a la DB compartida de oficina
`192.168.0.245:5432/postgres_platform`. Requiere estar en la red de la oficina.
**Para empezar usá el Docker local** — es autocontenido y no rompés data compartida.

**Reset de entorno:**

```bash
npm run dev:down     # baja contenedores (conserva data)
npm run dev:reset    # baja + BORRA volúmenes + levanta limpio
```

---

## 4. Arrancar y verificar

### Backend

```bash
npm run api          # nx serve api
npm run api:dev      # build --watch + node --watch (hot reload)
```

> ⚠️ **Windows:** `nx serve api` falla con `spawn ENAMETOOLONG`. La forma confiable es:
>
> ```
> npx nx build api && node dist/apps/api/main.js
> ```
>
> Boot OK cuando loguea `Nest application successfully started`.
> El puerto es **3334 fijo** (ignora `PORT=`). Swagger en `/api`.
> Un proceso viejo queda **stale**: endpoints nuevos dan 404 aunque el build esté verde → reiniciá.

### Frontends

```bash
npm run view      # app principal (dashboard/admin/comercial/logística/vendor/telemarketing)
nx serve portal   # portal B2B
nx serve vendor   # app del vendedor (mobile-first)
```

### Verificar que el entorno está sano

```bash
# Mismo build que corre el CI
npx nx run-many -t build -p api view portal vendor --configuration=production

# Regression suite (necesita la API arriba en :3334 + DBs sembradas)
npm run regression
```

> ⛔ **Nunca pipees `nx build` a `tail`/`grep`.** El exit code que ves es el del pipe, no el de nx:
> un build **fallido** reporta "exited with code 0" y commiteás código roto. Corré
> `npx nx build <proj> --skip-nx-cache` **sin pipe** y buscá `Successfully ran target build`,
> sin `NG8002` / `error TS` / `ERROR in`. (`NG8113 ... is not used` son warnings inofensivos.)

---

## 5. Estructura del repo

```
apps/
  api/         → backend NestJS (composition root, delgado)
  view/        → frontend admin/operaciones (+ módulos /portal y /vendor embebidos)
  portal/      → portal B2B standalone
  vendor/      → app vendedor standalone (Capacitor → Android)
libs/
  commercial/ finance/ fiscal/ logistics/ trade/ reconciliation/ whatsapp/   ← dominios
  platform-core/   ← infra (database, tenant, cache, queue, RBAC, AI, storage, vector)
  contracts/       ← SOLO tipos: enum de permisos, DTOs, interfaces Port
  design-tokens/   ← tokens.css (archivo único para las 3 apps)
database/
  migrations*/       → migraciones Knex (¡nunca borrar aplicadas!)
  migrations-newdb/  → las de la DB multi-tenant
  seeds*/            → seeds
  importers/         → feeds (kepler, wincaja, contpaqi, checadores...)
  scripts/           → utilerías one-off (cutover, backfills, sync)
  tests/             → smoke tests (test-newdb-*.js = DB directo · http-*.js = E2E vía API)
  run-all-tests.js   → runner de la regression suite
docs/IMPLEMENTACION/ → tracker, ADRs, log de revisiones, specs por fase (FASES/)
```

**Regla de dependencias:** los dominios (`libs/commercial`, `libs/finance`, ...) dependen de `platform-core` +
`contracts`, **nunca entre sí**. Se comunican por **puertos** cableados en `apps/api/src/composition/*`.

---

## 6. Los 7 modelos mentales (los no obvios)

1. **Multi-tenant + RLS.** Toda tabla de `commercial/analytics/logistics` tiene `tenant_id` +
   `FORCE ROW LEVEL SECURITY`. Desde un controller, las queries van por `TenantKnexService.run()` —
   si no, **0 filas en silencio**. Para crons cross-tenant existe `KNEX_NEW_DB_ADMIN` (bypassa RLS,
   **nunca** en un controller).
2. **Dominios aislados + composition root.** Nada de imports cruzados entre `libs/*`; puertos y eventos.
3. **`kepler_ods` es la fuente canónica del ERP.** No se leen las DBs de sucursal directo: se **derivan
   vistas** sobre `kepler_ods`. **Derivar, no copiar.**
4. **El request entero va en UNA transacción.** Lo best-effort va por **SAVEPOINT**, nunca `try/catch` pelado.
5. **Agregar un permiso = 5 touch-points** (§7.3). Un proyecto nuevo suma el 6º (su casa en `suite-map.ts`).
6. **Migraciones idempotentes, y nunca se tocan las aplicadas.**
7. **El número publicado carga con qué se calculó** (ADR-056/ADR-059). Frescura, cobertura y unidad se
   **declaran**; lo que no se pudo medir va como `unknown`/NULL, **nunca como 0 ni como verde**.

---

## 7. Reglas duras y límites

### 7.1 ⛔ Nunca, sin autorización explícita del lead

- **No borrar tablas** en ninguna DB de prod.
- **No borrar columnas** sin pedir confirmación.
- **No borrar ni renombrar migraciones ya aplicadas** → Knex compara `knex_migrations` contra el
  filesystem: registro sin archivo = `"migration directory is corrupt"` = **crash loop, prod caída**.
- **No agregarle columnas a una migración ya aplicada** → no vuelve a correr, así que eso **nunca llega**
  a las bases donde ya pasó. Lo que se agrega después va en **archivo nuevo, siempre**.
- **No insertar filas en `knex_migrations` a mano.**
- **No `git push` directo a `main`** (está protegida; el push rebota igual).
- **No `git add -A` / `git add .`** — el árbol tiene trabajo concurrente y dumps sueltos. Paths explícitos.
- **No tocar CORS ni credenciales** (decisión diferida del lead).
- **No crear importers nuevos** (⭐ regla principal, §7.2).
- **No hacer copias de tablas** (`*_bak`, `*_old`, "la misma tabla en otro schema").
- **No conectar la app como superuser en runtime** → bypassa RLS y expone data cross-tenant.

### 7.2 ⭐ La regla de más peso: cero importers, todo del ODS

> Todo dato sale del **ODS**, de **UNA** tabla principal, **normalizada, documentada y verificada**.

Las cuatro condiciones son conjuntas:

1. **Sin importer** — nada de `script → tabla` que haya que re-correr o agendar.
2. **Del ODS** `kepler_ods.*` — no de las réplicas por sucursal, ni de los POS, ni de un `.mdb`.
3. **De una sola tabla principal** — si necesitás otra forma del dato, **derivá** (vista), no materialices
   una segunda.
4. **Documentada y verificada** contra un hecho independiente antes de usarla.

Dataset nuevo = **vista `derive-no-copy` sobre `kepler_ods`**. Tabla real **sólo** para datos propios
(HITL, OCR, feedback) o histórico/snapshots. Si no se puede derivar: **parar y decirlo**, no improvisar.

> Evidencia: `analytics.customer_receivables` quedó en prod como tabla **vacía** porque su importer nunca
> corrió. El fix fue convertirla en vista sobre `kepler_ods.kdue`.

**Corolario:** nunca adivines una fuente de datos. Antes de usar una columna del ERP, contrastala contra un
hecho independiente (¿costo? contra lo que se pagó; ¿precio? contra lo que se cobró) y **probá la unidad**
explícitamente. Ya costó caro dos veces (3.3 pp de margen falso por mezclar pieza y caja; costos 32× por leer
el peldaño equivocado de la escalera de unidades).

### 7.3 Agregar un permiso: los 5 cables

Si falta uno, el endpoint tira `403` para todo rol que no sea admin de plataforma.

1. **Enum ÚNICO** en `libs/contracts/src/authz/permissions.ts`. Los `permissions.ts` de `platform-core`,
   `view`, `vendor` y `portal` son re-exports de una línea: **no se editan**.
2. **Gate del endpoint:** `@RequirePermissions(Permission.X)`.
3. **Guard de la ruta** en `app.routes.ts` con `permissionGuard(Permission.X)` — y si la ruta es el índice
   de un proyecto, el `*HomeGuard` tiene que poder mandar a alguien con esa clave a una pantalla que la acepte.
4. **`permission-meta.ts`** (label/description/category) + **`authz-tree.ts`** — sin esto el permiso es
   **invisible** en `/admin/roles`: nadie lo puede otorgar ni revocar.
5. **Gating del botón en el front:** `perms.has(Permission.X)`. Nunca leer `auth.user()?.permissions` a mano.
6. *(sólo proyecto nuevo)* su casa en `libs/contracts/src/authz/suite-map.ts`.

Además:

- El `RolesGuard` es **exact-key**: `COMPRAS_GESTIONAR` **no** hereda `COMPRAS_VALIDAR`.
- **Después de otorgar un permiso: RE-LOGIN.** Vive en el JWT armado al login.
- Un módulo **no está entregado** hasta que su permiso está **repartido en prod**, no sólo declarado en el enum.
- Probá con un **rol de permiso mínimo**, no con admin: `manage:all` oculta el bug.

### 7.4 ✅ Convenciones obligatorias

| Tema | Regla |
|---|---|
| **Migraciones** | Idempotentes siempre: `if (await knex.schema.hasColumn(...)) return;` / `hasTable`. |
| **Tablas nuevas** | `tenant_id UUID NOT NULL` + audit fields completos + RLS forzado. |
| **Naming DB** | `snake_case`. |
| **URLs / DTOs / columnas nuevas** | **inglés** `snake_case` (`zone_id`, `date_from`). Español sólo para términos de dominio sin traducción limpia (`exhibicion`, `folio`). |
| **Logs** | `Logger` de NestJS. **Nunca `console.log`** en código nuevo. |
| **Timezone** | Backend en `America/Mexico_City`. Todo `@Cron` con hora fija lleva `{ timeZone: 'America/Mexico_City' }`. |
| **Dinero** | Los `numeric` de Postgres llegan como **string**. Coercioná: `(Number(v ?? 0) \|\| 0).toLocaleString('es-MX', {...})`. Cantidades/piezas **no** son dinero. |
| **JSONB en knex** | Para diffs de permisos usar `permissions -> 'KEY' IS NULL`, **no** el operador `?` (knex no lo escapa). |
| **Soft-delete** | 12 tablas de `public.*` tienen `activo` **GENERATED** (sólo lectura). Se borra con `deleted_at: knex.fn.now()` y se reactiva con `deleted_at: null`. |
| **Commits** | `feat([CÓDIGO]): descripción` — el código entre brackets sale del tracker. |
| **Optimizar** | Un commit que cambia un número no cierra sin la medición antes/después. Optimizar es un commit **aparte** de cambiar alcance de negocio. |
| **Gates** | Un gate sin prueba negativa es una intención: rompelo a propósito una vez y verificá el rojo. |

### 7.5 🔐 Secretos

- El `.env` real **nunca** se commitea. Sólo `.env.example` / `.env.dev.example`, sin valores.
- Los secretos reales se piden al lead **por canal seguro** — no por chat ni commit.
- Si exponés una credencial: avisá al lead y **rótenla de inmediato**.

---

## 8. Flujo de Git (equipo)

```
1. git checkout main && git pull       # partir de main fresco
2. npm run migrate:new                 # aplicar migraciones nuevas de otros
3. git switch -c feat/<algo>           # rama por feature, en TU dominio
4. ...trabajar...
5. nx affected -t lint && nx affected -t test
   npx nx run-many -t build -p api view portal vendor --configuration=production
   npm run check:templates                   # gates locales — el CI NO corre (ver abajo)
   node scripts/check-provenance.js
   node scripts/lint-boundary-gate.js
6. git add <paths explícitos>  &&  git commit -m "feat([CÓDIGO]): ..."
7. git push -u origin feat/<algo>:refs/heads/feat/<algo>
8. PR contra main → 1 review (CODEOWNERS) → merge
9. actualizar el tracker
```

**Trampas de git ya vividas:**

- ⛔ **`git checkout -b mi-rama origin/main` + `git push` apunta a `main`.** El repo tiene
  `push.default = upstream`; crear la rama así le deja `origin/main` de upstream y el push resuelve ahí.
  **Evitalo** creando la rama con `git switch -c mi-rama` (sin upstream) o pusheando con refspec explícito
  `origin mi-rama:refs/heads/mi-rama`. Lo único que frenó el accidente fue la protección de `main`.
- ⛔ **`git add -A` nunca.** Pasó cuatro veces en una sola sesión: se llevó trabajo ajeno al commit.
  Verificá con `git diff <archivo>` antes de agregarlo.
- **Commiteá verde de inmediato**, aunque sea a mitad de tarea: lo no commiteado es lo único que se pierde.
- **Antes de crear una migración**, mirá `public.knex_migrations` **en prod**, no sólo el filesystem: con
  varias personas los timestamps chocan, y una migración puede estar aplicada sin que el archivo exista en tu clon.
- ⛔ **No esperes el CI: hoy no existe.** Medido el 2026-09-15 — el workflow está `disabled_manually`
  (última corrida **2026-08-25**), y las 25 corridas previas murieron en 2-4 s con `steps: 0` **sin runner
  asignado** (infraestructura de GitHub, no código). Además `main` exige review pero **no tiene ningún
  required status check**, así que ni encendido bloquearía un merge. **Los gates se corren en LOCAL**
  (`npm run check:templates`, `node scripts/check-provenance.js`, `node scripts/lint-boundary-gate.js`)
  y la verificación es responsabilidad del autor y del reviewer, no del servidor.
  Detalle en la cabecera de [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
- **Varias sesiones de Claude en una PC:** 1 agente = 1 worktree = 1 rama = 1 carpeta.
  `.\scripts\nuevo-agente.ps1 <nombre>` lo arma; nunca dos agentes en la misma carpeta.

---

## 9. Cómo trabajamos con Claude Code

- **`CLAUDE.md` es la memoria compartida** — se auto-carga en cada sesión. Lo no obvio del dominio va ahí
  o en `docs/`, no en tu cabeza.
- **La primera vez, orientá a tu Claude:** *"Leé `docs/CLAUDE_ONBOARDING.md` y seguí el protocolo."*
  Eso lo guía a leer los docs correctos en orden antes de tocar código.
- **La memoria personal de Claude (`~/.claude/memory/`) es local a tu máquina** y **no se comparte** entre
  devs ni entre máquinas. Lo que debe ver el equipo va a `docs/` o `CLAUDE.md`.
- **Actualizar el tracker al cerrar cualquier item es mandatorio**, no opcional.
- **Decisión técnica relevante → ADR** en `02_DECISIONES_ARQUITECTURA.md`.
- **Estilo de respuesta esperado:** conciso. Confirmación + qué sigue. El detalle va al tracker.

### Sistema de tracking (mantenerlo vivo)

| Archivo | Cuándo se actualiza |
|---|---|
| `docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md` | **cada** cambio de estado de un item |
| `docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md` | al tomar una decisión técnica (ADR) |
| `docs/IMPLEMENTACION/03_LOG_REVISIONES.md` | al cerrar un sprint o checkpoint |
| `CHANGELOG.md` | al cerrar una feature/sprint relevante |

Estados: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## 10. Ownership — quedate en tu carril

Cada dev es dueño de un **dominio vertical** (su frontend + su backend + sus tablas). El reparto vivo está en
[`TEAM_WORKING_MODEL.md`](TEAM_WORKING_MODEL.md) §1-2. Reglas:

- Trabajá **dentro de tu dominio**.
- Para tocar un dominio ajeno o una **zona compartida**, avisá al dueño primero. Las zonas compartidas son
  donde el equipo se pisa: **migraciones**, **permisos**, `composition/*` + `app.module.ts`,
  **sidebar** (`layout.component.ts`), `tokens.css` + `DESIGN.md`, y los docs vivos.
- **Feeds / ERP / `kepler_ods` los mantiene el lead.** Si necesitás un dato nuevo del ERP, se coordina.

---

## 11. Diseño — antes de tocar UI

Leer [`DESIGN.md`](../DESIGN.md) es **obligatorio** antes de cualquier decisión visual. Un solo sistema
("Mercado"), dos surfaces:

- **Storefront** (`/portal/*`): Fraunces editorial + Hanken Grotesk + Geist Mono, decoración intencional,
  densidad cómoda.
- **Operations** (`/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/telemarketing/*`,
  `/tienda/*`, `/compras/*`, `/finanzas/*`): **NO Fraunces**, NO ilustraciones. Page-head Hanken Bold,
  tabla densa + master-detail como organismo primario, densidad compact++.

Comparten paleta Stone, `--action` sunset, IA ember (mata el morado `#8b5cf6` y el azul `#2563EB`), dark
zinc/espresso (mata el `#000` puro) y la escala de radios. Tokens en `libs/design-tokens/tokens.css` —
**archivo único para las 3 apps**. No desviarse sin aprobación; en review, marcar lo que no respete `DESIGN.md`.

---

## 12. Troubleshooting

| Síntoma | Causa / fix |
|---|---|
| Un endpoint devuelve `[]` y debería traer data | **Lo primero a revisar:** falta `TenantKnexService.run()` (RLS). |
| `200 OK` pero no se persistió nada | Transacción abortada por un `try/catch` que tragó un error de DB. Usá SAVEPOINT. |
| `25P02 current transaction is aborted` | Idem anterior. |
| `403 No tienes los permisos dinámicos necesarios` | Falta alguno de los 5 cables del permiso (§7.3) — o falta re-login. |
| Migración crashea el boot / "directory corrupt" | Alguien borró o renombró una migración aplicada. |
| Columna nueva da `42703 does not exist` en prod | Le agregaron columnas a una migración **ya aplicada**. Va en archivo nuevo. |
| `nx serve api` → `ENAMETOOLONG` (Windows) | `npx nx build api && node dist/apps/api/main.js`. |
| Endpoint nuevo da 404 con el build verde | Proceso viejo de la API stale → reiniciá. |
| `@Cron` corre 6 horas tarde | Cron escrito asumiendo UTC. Fijá `timeZone: 'America/Mexico_City'` y hora wall-clock MX. |
| Dinero sale sin `$` ni comas | `numeric` llega como string → envolvé en `Number()`. |
| `42P18 could not determine data type of parameter` | Un `?` literal dentro de `knex.raw()` se toma como binding. |
| `npm ci` se cuelga bajando Chrome | `PUPPETEER_SKIP_DOWNLOAD=true npm ci`. |
| Build pasa en local y rompe en CI | Verificá con `--configuration=production` (budgets Angular + TS estricto). |
| Nx cachea un resultado viejo | `--skip-nx-cache`. |
| El build sale verde pero compiló otra cosa | `nx build` desde un git worktree puede compilar el **otro** checkout. |
| `rebase` muere con "could not write index" (Windows) | OneDrive. Pausalo, o usá `cherry-pick`. |

---

## 13. Definition of done (checklist antes de pedir review)

- [ ] `npx nx affected -t lint` verde.
- [ ] `npx nx affected -t test` verde.
- [ ] `npx nx run-many -t build -p api view portal vendor --configuration=production` verde
      (**sin pipe**, leyendo el output).
- [ ] Los 3 gates locales verdes (el CI no corre, §8): `npm run check:templates`,
      `node scripts/check-provenance.js`, `node scripts/lint-boundary-gate.js`.
- [ ] Si tocaste DB: migración **idempotente**, `tenant_id` + RLS en tablas nuevas, timestamp coordinado.
- [ ] Si agregaste un permiso: los 5 cables + repartido + re-login probado con **rol mínimo**.
- [ ] Si tocaste UI: respeta `DESIGN.md` y el surface correcto.
- [ ] Smoke/regression relevante corrida (`npm run regression` antes de declarar una fase verde).
- [ ] Lo que **no** pudiste verificar está **declarado** en el PR, no dado por bueno.
- [ ] Tracker actualizado + (si aplica) ADR + CHANGELOG.
- [ ] `git add` con paths explícitos.

---

## 14. Mapa de documentación

| Archivo | Para qué |
|---|---|
| [`ONBOARDING.md`](../ONBOARDING.md) | Setup canónico de máquina — **la fuente viva de §2-4 de este handbook**. |
| [`CLAUDE.md`](../CLAUDE.md) | Contexto del proyecto, fases, reglas críticas. Se auto-carga en cada sesión. |
| [`docs/CLAUDE_ONBOARDING.md`](CLAUDE_ONBOARDING.md) | Protocolo de orientación para tu Claude, paso a paso. |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | Mapa de código: apps, dominios, módulos, DBs, feeds, servicios externos. |
| [`docs/ARQUITECTURA_DATOS.md`](ARQUITECTURA_DATOS.md) | Arquitectura de datos (schemas, tablas, FKs, flujo origen→pantalla). |
| [`docs/GLOSSARY.md`](GLOSSARY.md) | Términos de dominio y nombres internos (Thot/Horus/Maat, Kepler, CEDIS, folio...). |
| [`docs/ERP_KEPLER.md`](ERP_KEPLER.md) | Decode del ERP Kepler + pipeline `kepler_ods`. **Imprescindible para feeds/finanzas/compras.** |
| [`docs/GOTCHAS.md`](GOTCHAS.md) | ⭐ Las ~44 trampas ya vividas (varias tumbaron prod). **Antes de tocar DB o permisos.** |
| [`docs/VERDAD_ABSOLUTA.md`](VERDAD_ABSOLUTA.md) | ⭐⭐ Qué **arbitra** cada número y qué se **declara**. Antes de publicar una cifra. |
| [`docs/UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md) | Unidades y factores de caja. **Antes de multiplicar dos columnas.** |
| [`DESIGN.md`](../DESIGN.md) | Sistema de diseño. **Obligatorio antes de tocar UI.** |
| [`docs/TEAM_WORKING_MODEL.md`](TEAM_WORKING_MODEL.md) | Ownership por dominio + zonas compartidas + worktrees. |
| [`docs/IMPLEMENTACION/INDEX.md`](IMPLEMENTACION/INDEX.md) | Mapa de toda la documentación. |
| [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](IMPLEMENTACION/01_TRACKER_PROGRESO.md) | Qué está hecho y qué falta. |
| [`docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md`](IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | Los ADRs. |
| [`docs/IMPLEMENTACION/FASES/`](IMPLEMENTACION/FASES/) | Spec detallada de cada fase (RA, CB, MR, LC, VP...). |

---

## 15. Los ADRs que cambian cómo escribís código

No hace falta leerlos todos; estos cuatro fijan criterios que se aplican a diario:

- **ADR-010** — Multi-tenancy: shared DB + `tenant_id` + RLS desde el origen.
- **ADR-054** — El permiso es una **clave**, no una tupla acción/sujeto. CASL se retiró: el gate es lookup
  por clave exacta y el god-mode se resuelve por nombre de rol.
- **ADR-056** — **Verdad y procedencia:** un número publicado carga con qué se calculó. El veredicto es
  **ternario** (`fresh | stale | unknown`) porque un booleano no puede decir "no sé". Un primitivo genérico
  no cierra la fase hasta vivir en `libs/` compartido o quedar declarado como deuda con nombre.
- **ADR-059** — **La verdad absoluta se arbitra, y lo que no se puede arbitrar se declara.** Cada ERP se
  juzga con SU evidencia; el dinero arbitra la cantidad; lo no medible va NULL, nunca 0.

---

**¿Algo faltó o quedó desactualizado?** Editá este archivo en tu PR.
