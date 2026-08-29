# Fase TS — Contratos de tipos del boundary REST

> **Estado:** 🔨 EN CURSO — TS.0 🧪 + TS.1 (fundación + BFF backend) 🧪 (local · commits `eed2d9a3`+`64966af8` en worktree `feat/ts-contratos-tipados` → `../tm-ts`) 2026-08-29 · **ADR-052** aceptado (evoluciona **ADR-045**)
> **Tesis:** el boundary HTTP es donde vive el 99% del tráfico y hoy está ~78% sin tipar.
> `libs/contracts` ya garantiza "no romper en silencio" para los puertos in-process;
> esta fase extiende **la misma fuente única y el mismo principio** al wire REST —
> un cambio de forma en el backend debe ser **error de compilación en el front**, no un bug de runtime.
> **Meta:** de 849 contratos HTTP escritos a mano y desacoplados → 1 fuente (`libs/contracts`) importada por los dos lados.
>
> **No es GraphQL.** ADR-045 ya lo rechazó (over-fetching no medido) y sigue rechazado. Esto hace **mejor el REST que ya existe**.

---

## 0. Por qué esto no arranca reescribiendo servicios

Si se migra módulo por módulo sin frenar primero la entrada de código nuevo sin tipar, la deuda
sube más rápido de lo que baja. El **primer entregable no es migración**: es el **gate** (TS.0)
que hace que el código nuevo nazca tipado. Recién después se baja el stock viejo.

Tampoco es un big-bang: cada servicio del front **cambia solo el tipo que importa** y borra su
interface local — no se reescribe su lógica. Los ~1,080 endpoints se migran por tráfico, la app
sigue viva todo el tiempo.

---

## 1. Baseline medido (2026-08-29)

| Señal | Valor | Fuente |
|---|---|---|
| Endpoints REST | **~1,080** | 117 controllers en `libs/*` + 19 en `apps/api` |
| Call sites HTTP en el front | **939** en 85 servicios | `this.http.*` |
| Genéricos tipados **a mano** (`.get<T>`) | **849** contratos duplicados | drift-risk: no rompen el compile |
| Llamadas sin tipo | 90 (~10%) | |
| `: any` en services del front | **55** en 20 archivos | |
| `Promise<any>` en services del backend | **47** en 29 archivos | |
| `.dto.ts` en `libs` / 117 controllers | **25** (class-validator en 19) | boundary ~78% sin tipar |
| `@Body()` totales | **310** en 91 controllers | mayoría sin DTO validado |
| `@Body() x: any` explícito | 12 | |
| Gateways Socket.IO | 11 | no cambian (ADR-045) |
| GraphQL / tRPC / cliente codegen | 0 | y así queda (ADR-045) |

**Poster child del waterfall:** Command Center dispara **11 llamadas** al cargar, cola de **3.6 s**,
y tuvieron que inventar **8 señales de loading** para tapar el hueco ([command-center.component.ts:102](../../../apps/view/src/app/modules/dashboard/command-center/command-center.component.ts#L102)).
`forkJoin` aparece en 23 archivos → sí paralelizan, pero siguen siendo N requests × RLS × tenant × throttle × TLS.

---

## 2. Arquitectura del contrato (ADR-052)

Fuente única en el lib que **ya existe** y es dep-free (`libs/contracts`, hoy solo `ports/*`):

```
libs/contracts/src/
  ports/*.port.ts        ← in-process (ADR-045, sin cambio, type-only)
  http/<dominio>.contract.ts   ← NUEVO: esquemas Zod del wire REST
  db/<schema>.gen.ts     ← NUEVO: tipos de fila generados del schema Postgres
```

- **Un schema Zod por endpoint** (request + response). `z.infer` da el tipo TS.
- **Backend**: el controller importa el tipo (`Promise<z.infer<typeof X>>`) y valida el body con un
  `ZodValidationPipe` (propio, ~15 líneas) usando **el mismo schema** → tipo y validación de un solo lugar.
- **Front**: el service importa el **mismo tipo** y borra su interface local. Un cambio de forma
  en el backend = error de compilación en `apps/view`.
- **Naming**: campos de contrato en **English snake_case** (convención del proyecto: `customer_id`, `date_from`…).

**Consecuencia de diseño:** `libs/contracts` deja de ser "solo tipos" y gana **una dep de runtime (zod)**.
Entra al bundle del front (~12–14 kB gzip, aceptable). Los `ports/*` siguen type-only.

---

## 3. La mitad difícil: response sobre Knex

El request es fácil (Zod + pipe). El response es el trabajo real: **Knex no es type-safe** —
`.select('*')` devuelve `any`. Por eso hay 47 `Promise<any>`. Camino:

1. **Generar los tipos de fila desde el schema Postgres** (`kysely-codegen` o `pg-to-ts`) →
   interfaces por tabla de `commercial.*`, `analytics.*`, `finance.*`, `logistics.*`, `trade.*`.
2. Tipar los queries: `knex<Row>('tabla')`.
3. El controller compone el response (schema Zod de `http/`) desde filas tipadas.

**No se migra a Prisma/Drizzle/Kysely** (inversión enorme en Knex + RLS vía `TenantKnexService`).
Se generan tipos y se sigue con Knex — el runtime **no se toca**, RLS intacto.

---

## 4. Sprints

| Sprint | Qué | Estado |
|---|---|---|
| **TS.0** | **Frenar la hemorragia.** Gate de tipado del boundary a **nivel LÍNEA** (no archivo): `no-explicit-any` (back+front) + `explicit-module-boundary-types` (back). `error` en `libs/contracts` + en las **líneas nuevas** de cualquier PR; `warn` en el resto. Ver §8. | 🧪 |
| **TS.1** | **Fundación + rebanada vertical.** (a) `libs/contracts/src/http/` + convención; (b) `ZodValidationPipe` propio; (c) generar `db/*.gen.ts`; (d) verificar tags Nx (`apps/view` puede importar `libs/contracts` runtime); (e) **Command Center BFF**: 1 endpoint agregado que devuelve los 11 paneles en 1 response tipado punta a punta → mata el waterfall 11→1 y el workaround de 8 loadings. Prueba todo el pipeline. | 🔨 |
| **TS.2** | **Barrido por tráfico.** Módulo por módulo: comercial (145) → logística (118) → compras (62) → finanzas/bank (39) → almacén → resto. Por módulo: contratos Zod en `http/`, pipe en writes, return types en controllers, front importa el tipo y borra la interface local. Al cerrar cada módulo, su lint pasa a `error`. | ⬜ |
| **TS.3** | **Cierre.** Eliminar los 12 `@Body() any` + 47 `Promise<any>`, lint global a `error`, gate de CI duro. Opcional: enriquecer el snapshot OpenAPI desde los Zod (`z.toJSONSchema()` nativo de Zod 4). | ⬜ |

**Atajo grande (TS.2):** los **849 genéricos** que ya están escritos a mano en el front **son el
contrato de facto**. Se cosechan como semilla de los schemas Zod — no se arranca de cero, y es
100% automatizable. Ordenar por los servicios más gordos primero.

---

## 5. Ratchet de lint (cómo no morir en el intento)

Prender las reglas repo-wide de golpe explota con miles de violaciones existentes. Estrategia:

- **`error`** desde el día 1 en: `libs/contracts/**` y archivos **nuevos o modificados** (ESLint sobre el diff del PR).
- **`warn`** en el resto; cada módulo cerrado en TS.2 flipa a `error`.
- El gate de CI bloquea PRs que **suban** el conteo de `any` en el boundary (baseline ratchet).

Esto convierte la deuda de "proyecto heroico que se pudre" en "número que solo baja".

---

## 6. Riesgos / gotchas

- **`nestjs-zod` + Zod v4** puede tener fricción de versión → arrancar con `ZodValidationPipe` propio (trivial), evaluar la lib después.
- **`libs/contracts` gana dep de runtime (zod)** → confirmar que el build de Angular la bundlea bien vía path mapping y que los tags de Nx (`enforce-module-boundaries`) dejan a `apps/view`/`vendor`/`portal` importarla.
- **RLS/tenant intacto**: todo es compile-time; `TenantKnexService.run()` no cambia. No introducir queries fuera de `.run()` al tipar (ver gotcha [[feedback_tenant_knex_rls]]).
- **No es el cliente OpenAPI generado** (rechazado por ADR-045): es import de tipo compartido. El snapshot `generate:openapi` se queda para diff, no como puente de tipos.
- **No tocar la lógica** de los services al migrar — solo el tipo importado. Auditar el flujo, no solo el archivo.

---

## 7. Definición de done / métricas

| Métrica | Hoy | Meta |
|---|---|---|
| `Promise<any>` en controllers/services | 47 | **0** |
| `@Body() x: any` | 12 | **0** |
| Interfaces HTTP escritas a mano en el front | ~849 | **~0** (importan `libs/contracts`) |
| Contratos con validación de runtime | ~19 módulos | **todos los writes** |
| Gate de CI que frena `any` nuevo en el boundary | no | **sí** |
| Command Center: requests al cargar | 11 | **1** |

---

## 8. Estado de implementación

**TS.0 — 🧪 PROBADO (local) 2026-08-29.** Gate de tipado del boundary a nivel **LÍNEA**, no archivo.

Archivos:

- [`eslint.gate.config.js`](../../../eslint.gate.config.js) — config standalone (sin `@nx/enforce-module-boundaries`, que necesita el graph de Nx) con las 2 reglas como `error`: `no-explicit-any` (todo `*.controller.ts`/`*.service.ts`) + `explicit-module-boundary-types` (solo backend).
- [`scripts/lint-boundary-gate.js`](../../../scripts/lint-boundary-gate.js) — runner ratchet: lista los archivos de boundary cambiados (`NX_BASE`/`NX_HEAD` en CI; `git merge-base origin/main HEAD` en local), extrae del diff `unified=0` las **líneas nuevas** por archivo, corre eslint en JSON y **falla solo si una violación cae en una línea nueva**. Fail-closed si eslint no produce reporte.
- `eslint.config.js` — bloques nuevos: `libs/contracts/**` → ambas reglas `error`; boundary (services back+front) → `no-explicit-any` `warn` (visible en editor, no bloquea).
- `.github/workflows/ci.yml` — step "Boundary type gate" en el job `verify` (reusa `nx-set-shas`).
- `package.json` — `npm run lint:boundary`.

**Verificado:** el gate a nivel **archivo** sobre `goods-receipt-proofs.service.ts` (legacy, 1840 líneas) daba **95 errores**; a nivel **línea** sobre la rama actual colapsa a **6** (solo lo que la rama tocó). El ratchet ignora la deuda vieja de líneas no tocadas y solo frena `any` nuevo.

**Regla diferida:** `no-unsafe-return` (del plan original §4) necesita typed-linting (`parserOptions.project`), lento de prender repo-wide en este monorepo. Las 2 reglas activas no necesitan type-info. Se reevalúa en TS.3.

**⚠️ Decisión de transición pendiente:** el gate detecta **14 violaciones nuevas** en `feat/mr-rentabilidad-fix` (MR.5 se escribió antes de esta política). Opciones: (a) **grandfather** — aplica a PRs futuros, esta rama se mergea con override; (b) tipar esas 14 antes de mergear. No se tipó nada acá (es código de MR.5, fuera del alcance de TS.0) y no se pusheó.

**TS.1 (fundación) — 🔨 EN CURSO 2026-08-29.** Partes a/b/d hechas y verificadas; c/e pendientes.

- **(a)** [`libs/contracts/src/http/command-center.contract.ts`](../../../libs/contracts/src/http/command-center.contract.ts) — contrato Zod del tablero, **cosechado de las 11 interfaces** que vivían a mano en `command-center.service.ts` (demuestra el atajo de TS.2). Exporta `CommandCenterDashboard` (schema + tipo) + las 11 piezas; barrel actualizado.
- **(b)** [`libs/platform-core/src/lib/pipes/zod-validation.pipe.ts`](../../../libs/platform-core/src/lib/pipes/zod-validation.pipe.ts) — `ZodValidationPipe` reusable (`safeParse` → `BadRequestException` con `issues`); barrel actualizado.
- **(d)** Tags Nx verificados: `apps/view` (`scope:view`) ya puede importar `libs/contracts` (`scope:shared`) — sin cambio.
- **Verificado:** API Zod v4 confirmada en runtime (`z.literal` / `.nullable().optional()` / `safeParse` / `error.issues`; zod 4.4.3). `typecheck:fast` limpio en los archivos nuevos — se chequean transitivamente vía los barrels que importa `apps/api`.

**(e) BFF Command Center — ✅ backend + cliente tipado (commit `64966af8`).** `GET /commercial/analytics/command-center` compone vía `Promise.all` los **7 paneles `COMMERCIAL_ANALYTICS_VER`** (NO los 11: los 4 con otro permiso —erp-customers, conversion, conversion-daily, nba— quedan aparte para no bypassear su gate) y valida la respuesta con `CommandCenterDashboard.parse` → el BFF es el punto de enforcement del contrato. `CommandCenterService.commandCenter()` en el front, tipado con el contrato compartido (`import type`, no arrastra Zod al bundle). `typecheck apps/api EXIT=0`.

Pendiente de TS.1:

- **(c)** generar `db/*.gen.ts` (tipos de fila del schema Postgres) — necesita introspección de la DB.
- **(e.2)** wirear el componente a `commandCenter()` (7 paneles en 1 request; los 4 restantes siguen aparte) + `nx build view` + verificación visual → **necesita la máquina de Edgar** (dev server / build). ⚠️ UX: el per-panel loading que mata "se congela" no debe regresar al colapsar a 1 request.

**Workflow (lección de esta sesión):** el trabajo de TS vive en el **worktree `../tm-ts`** (`feat/ts-contratos-tipados`), aislado del tree principal donde el proceso automático stashea/revierte cambios sin commitear. Editar el tree compartido causó un duplicado-en-commit que hubo que limpiar. Regla: worktree por sesión (ver [[feedback_multi_session_worktree_workflow]]).

---

## Referencias

- **ADR-052** — Contratos de tipos del boundary REST (fuente única en `libs/contracts`). Evoluciona **ADR-045**.
- **ADR-045** — Transportes de comunicación (REST + Socket.IO; GraphQL rechazado). Intacto salvo la cláusula de contrato de tipos.
- Gotcha [[feedback_tenant_knex_rls]] · regla derivar-no-copiar del modelo canónico.
