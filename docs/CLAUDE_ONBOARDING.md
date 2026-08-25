# Protocolo de orientación para Claude Code

> **Para el dev:** la primera vez que abras el proyecto, decile a tu Claude:
> *"Leé `docs/CLAUDE_ONBOARDING.md` y seguí el protocolo para entender el proyecto."*
>
> **Para Claude:** estás siendo onboardeado a este codebase. Seguí estos pasos EN ORDEN para
> construir un modelo mental correcto antes de tocar código. No te saltes pasos.

---

## Paso 1 — Leé estos docs, en este orden

Abrí y leé cada uno (no asumas su contenido, leelos):

1. [`../CLAUDE.md`](../CLAUDE.md) — contexto, fases del proyecto, reglas críticas. (Ya está en tu contexto por auto-carga, pero repasá las secciones de reglas y el roadmap de fases.)
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — **arquitectura de código**: apps (`api/view/portal/vendor`), dominios (`libs/*`), módulos, cómo se cablean.
3. [`ARQUITECTURA_DATOS.md`](ARQUITECTURA_DATOS.md) — **arquitectura de datos**: schemas, tablas, FKs, flujo origen→pantalla.
4. [`GLOSSARY.md`](GLOSSARY.md) — términos de dominio + nombres internos (Thot/Horus/Maat, Kepler, CEDIS, folio, fases…).
5. [`ERP_KEPLER.md`](ERP_KEPLER.md) — el ERP Kepler (schema ofuscado) + el pipeline `kepler_ods`. **Imprescindible si vas a tocar feeds, finanzas, compras o analytics.**
6. [`GOTCHAS.md`](GOTCHAS.md) — trampas técnicas ya vividas (varias tumbaron prod). **Leelo entero antes de tocar DB o permisos.**
7. [`../DESIGN.md`](../DESIGN.md) — sistema de diseño. **Obligatorio antes de tocar UI.**

## Paso 2 — Explorá la estructura real (no te fíes solo de los docs)

Corré (o pedile al usuario que corra) y mirá los resultados:

```
apps/            → api (NestJS) · view (admin/ops) · portal (B2B) · vendor (campo)
libs/            → dominios: commercial, finance, fiscal, logistics, trade,
                   reconciliation, whatsapp + platform-core (infra) + contracts (tipos)
database/
  migrations-newdb/  → migraciones de la DB multi-tenant (postgres_platform)
  importers/         → feeds (kepler, wincaja, contpaqi, checadores…)
  tests/             → smoke tests (test-newdb-*.js = DB directo · http-*.js = E2E)
  run-all-tests.js   → regression suite
docs/IMPLEMENTACION/ → tracker, ADRs, log, specs por fase (FASES/)
```

Nx workspace: `nx graph` (o mirar `project.json` de cada lib) muestra las dependencias.

## Paso 3 — Internalizá estos 6 modelos mentales (los no-obvios)

1. **Multi-tenant + RLS.** Toda tabla de `commercial/analytics/logistics` tiene `tenant_id` + Row Level Security forzado. Las queries desde un controller DEBEN ir por `TenantKnexService.run()` o devuelven **0 rows en silencio**. (GOTCHAS §1.)
2. **Dominios aislados + composition root.** Los `libs/*` NO se importan entre sí; se comunican por **puertos** cableados en `apps/api/src/composition/*`. (ARCHITECTURE §3.)
3. **`kepler_ods` es la fuente canónica de datos del ERP.** No leas las DBs de sucursal directo; derivá vistas sobre `kepler_ods`. Derivar-no-copiar. (ERP_KEPLER §4-5.)
4. **El request entero va en UNA transacción.** Un `try/catch` que traga un error de DB y sigue queryeando tira `25P02` / rollback silencioso. Usá SAVEPOINT. (GOTCHAS §2.)
5. **Agregar un permiso = 6 touch-points** (enum ×2, ability.factory, authz-tree, permission-meta, gating). Si falta uno → 403 o botón invisible. (GOTCHAS §4.)
6. **Migraciones idempotentes + nunca borrar aplicadas** (crash-loop "directory corrupt"). (GOTCHAS §3.)

## Paso 4 — Reglas duras (romperlas cuesta caro)

- No borrar tablas, columnas ni migraciones aplicadas sin autorización.
- No `git add -A` (hay trabajo concurrente en el árbol) — stagear paths explícitos.
- Migraciones idempotentes (`hasColumn`/`hasTable`). Tablas nuevas con `tenant_id` + RLS.
- `Logger` de NestJS, no `console.log`. Dinero: `Number()` antes de formatear. `@Cron` con `timeZone: 'America/Mexico_City'`.
- En Windows la API arranca con `nx build api && node dist/apps/api/main.js` (no `nx serve`).
- Al cerrar un item: actualizar el tracker (`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`).

## Paso 5 — Qué doc consultar según la tarea

| Vas a tocar… | Leé primero |
|---|---|
| DB / queries / RLS | `GOTCHAS.md` §1-3 + `ARQUITECTURA_DATOS.md` |
| Un permiso / rol nuevo | `GOTCHAS.md` §4 |
| Feeds / importers / ERP | `ERP_KEPLER.md` |
| Finanzas / bancos / compras | `ERP_KEPLER.md` + la fase en `docs/IMPLEMENTACION/FASES/` |
| UI / componentes | `DESIGN.md` |
| Una fase específica (RA, CB, AX…) | `docs/IMPLEMENTACION/FASES/FASE_<X>_*.md` |

## Paso 6 — Cómo trabajás en este repo (reglas de flujo, OBLIGATORIAS)

Este es un repo de **equipo (3 devs)** con `main` protegida. Trabajás así, sin excepción:

1. **NUNCA commitees ni pushees a `main` directo.** `main` está protegida (require PR + review + code owners) → GitHub te va a **rechazar** el push de todos modos. No pierdas tiempo intentándolo.
2. **Rama por feature:** `git checkout main && git pull` → `git checkout -b feat/<algo>`.
3. **Antes de pushear:** `nx affected -t lint,test` + `nx run-many -t build -p api view portal vendor --configuration=production` en verde.
4. **Push a tu rama + abrí un PR** contra `main`. Esperá **CI verde + 1 review** (CODEOWNERS) antes del merge. No mergees sin review.
5. **`git add` con paths explícitos**, nunca `git add -A` (hay trabajo concurrente en el árbol).
6. Al cerrar un item: actualizá el tracker (`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`).

## Paso 7 — Tu área (quedate en tu carril)

Cada dev es dueño de un **dominio vertical**. Preguntale a tu dev **cuál es su área** y confirmala en
[`TEAM_WORKING_MODEL.md`](TEAM_WORKING_MODEL.md) (tabla de ownership). Reglas:

- Trabajá **dentro de tu dominio** (tu frontend + backend + DB). Ej.: si tu dev es de **Almacén/Inventario**,
  tu carril es `commercial-inventory/-movements/-warehouses/-receiving`, `apps/view/.../almacen/*`, `commercial.stock*`.
- Si necesitás **tocar un dominio ajeno** o una **zona compartida** (migraciones, permisos, sidebar, `app.module`,
  `tokens.css`), avisá al dueño primero (ver §3 del working model) — ahí es donde el equipo se pisa.
- Datos del **ERP / feeds / `kepler_ods`** los mantiene el lead (Edgar): si necesitás un dato nuevo del ERP,
  coordinás con él, no lo tocás por tu cuenta.

---

**Cuando termines el protocolo:** resumile al dev, en 5-6 líneas, tu modelo mental del proyecto
(qué es, cómo se divide, tu área, y las 2-3 trampas que más importan). Eso confirma que el onboarding funcionó.
