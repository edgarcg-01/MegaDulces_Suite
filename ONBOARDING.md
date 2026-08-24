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

# 4. Crear tu .env desde el template
cp .env.example .env
#    Editá .env — para desarrollo local con el Docker de arriba, apuntá TODO a localhost:
#      DATABASE_URL=postgresql://postgres:postgres@localhost:5432/megadulces_logistica
#      DATABASE_URL_NEW=postgresql://postgres:postgres@localhost:5432/postgres_platform
#      DATABASE_URL_NEW_RUNTIME=postgresql://app_runtime:app_runtime@localhost:5432/postgres_platform
#      VECTOR_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/vector_db
#      REDIS_URL=redis://localhost:6379
#      JWT_SECRET=<generá uno largo aleatorio>
#      ENABLE_MULTITENANT=true
#    Los secretos reales (Cloudinary, Anthropic, Voyage, etc.) los pedís al lead — NO están en el repo (§6).

# 5. Correr migraciones (legacy + nueva DB multi-tenant) y seeds
npm run migrate:latest    # DB legacy
npm run migrate:new       # DB multi-tenant (postgres_platform)
npm run seed:new          # seeds baseline (tenant mega_dulces, roles, superoot)
npm run seed:testdata     # data de prueba comercial (brands/products/prices/customers/stock)
```

> Atajo: `npm run dev:bootstrap` hace up + ambas migraciones de un jalón.

> **Alternativa (lo que usa el lead):** en vez del Docker local, apuntar `DATABASE_URL_NEW` a la DB compartida en `192.168.0.245:5432/postgres_platform`. Requiere estar en la red de la oficina. Para empezar, **usá el Docker local** — es autocontenido y no rompes data compartida.

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

La API levanta en el puerto configurado (default `:3333`; la regression asume `:3334`). Swagger en `/api`.

### Frontends (Angular)

```bash
npm run view       # app principal (dashboard/admin/comercial/logística/vendor/televenta)
nx serve portal    # portal B2B del cliente
nx serve vendor    # app del vendedor (mobile-first)
```

Las 4 apps deployables son: **`api`**, **`view`**, **`portal`**, **`vendor`**.

---

## 5. Estructura del repo

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
- **La memoria personal de Claude (`~/.claude/memory/`) es local a tu máquina** — no se comparte entre devs. El conocimiento que debe verlo todo el equipo va a `docs/` o `CLAUDE.md`.
- **Actualizá el tracker al cerrar cualquier item**: `01_TRACKER_PROGRESO.md` (estado ⬜→🔨→🧪→🚀→✅) y `03_LOG_REVISIONES.md` (al cerrar sprint). Es mandatorio, no opcional.
- **Decisiones técnicas relevantes → un ADR** en `02_DECISIONES_ARQUITECTURA.md`.

---

## 8. Flujo de Git (equipo de 3)

> El repo históricamente trabajó con push directo a `main` (1 dev). **Eso ya no aplica.**

1. **Rama por feature**: `git checkout -b feat/<descripción-corta>` desde `main` actualizado.
2. **Commits** con la convención del tracker: `feat([RA.11]): descripción` — el código entre brackets viene del tracker.
3. **Abrí un PR** contra `main`. El CI (build + lint/test affected + secret-scan) debe pasar en verde.
4. **Al menos 1 review** de otro dev antes de mergear.
5. **`main` está protegida** — nadie pushea directo (ver con el lead la config de branch protection en GitHub).
6. Al mergear: cerrá el item en el tracker.

**Antes de pedir review, localmente:**
```bash
npx nx affected -t lint          # lint de lo que tocaste
npx nx affected -t test          # tests de lo que tocaste
npx nx run-many -t build -p api view portal vendor --configuration=production
```

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
