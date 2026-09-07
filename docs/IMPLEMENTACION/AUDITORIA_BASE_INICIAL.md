# Auditoría de la Base Existente — Hallazgos Iniciales

> Auditoría profunda del código actual antes de iniciar las nuevas fases del roadmap. Cuatro dominios revisados: DB, backend, frontend, config/seguridad.
>
> **Fecha:** 2026-05-26
> **Severidad:** 🔴 Crítico (bloquea o pone en riesgo) — 🟡 Importante (deuda que va a doler) — 🟢 Nice-to-have (cosmético)

---

## Resumen ejecutivo

| Dominio | 🔴 Crítico | 🟡 Importante | 🟢 Nice-to-have | Total |
|---|---|---|---|---|
| **DB / Migraciones** | 6 | 5 | 3 | 14 |
| **Backend NestJS** | 4 | 6 | 3 | 13 |
| **Frontend Angular** | 4 | 6 | 5 | 15 |
| **Config / Seguridad** | 5 | 8 | 5 | 18 |
| **TOTAL** | **19** | **25** | **16** | **60** |

**Conclusión:** la base tiene **19 issues críticos** que deben resolverse antes de construir features nuevas encima. Algunos son riesgos de seguridad activos (CORS abierto, JWT secret fallback, credenciales en `.env`), otros son deuda técnica que va a multiplicarse a medida que crezca el código.

---

## 1. Base de datos / Migraciones (14 findings)

### 🔴 Crítico

**1.1 — Migraciones no idempotentes (no usan `hasColumn`)**
Múltiples migraciones rompen si se ejecutan dos veces:
- [`20260331000001_v3_add_scores_to_catalogs.js:7-14`](database/migrations/20260331000001_v3_add_scores_to_catalogs.js#L7-L14)
- [`20260331231959_add_gps_to_captures.js:6-9`](database/migrations/20260331231959_add_gps_to_captures.js#L6-L9)
- [`20260402141501_add_parent_id_to_catalogs.js:6-8`](database/migrations/20260402141501_add_parent_id_to_catalogs.js#L6-L8)
- [`20260402160000_update_assignments_to_weekly.js:5-20`](database/migrations/20260402160000_update_assignments_to_weekly.js#L5-L20)
- [`20260409174829_refactor_zones.js:32-38`](database/migrations/20260409174829_refactor_zones.js#L32-L38)
- [`20260410151048_add_cloudinary_public_id.js`](database/migrations/20260410151048_add_cloudinary_public_id.js)

**Fix:** patrón `if (!await knex.schema.hasColumn(table, col)) { ... }` en cada `addColumn`. **No tocar las migraciones viejas (ya aplicadas)**; aplicar el patrón solo a las nuevas a partir de aquí, documentado como convención.

**1.2 — Inconsistencia naming en roles entre seeds y código**
- Seed [`database/seeds/00_roles.js:33`](database/seeds/00_roles.js#L33) define `"Jefe_M"` (PascalCase).
- Código [`apps/api/src/modules/catalogs/catalogs.service.ts:19-26`](apps/api/src/modules/catalogs/catalogs.service.ts#L19-L26) define `'jefe_marketing'` (snake_case).
- Cualquier reseed re-inserta el nombre viejo.

**Fix:** actualizar seed para usar snake_case + migración que renombra cualquier rol antiguo a la convención nueva.

**1.3 — Tabla `captures` sin audit fields completos**
[`20260330165442_init_captures_schema.js`](database/migrations/20260330165442_init_captures_schema.js) solo tiene `created_at`. Sin `updated_at`, `updated_by`, `deleted_at`, `deleted_by`. Es core del negocio.

**Fix:** migración nueva `add_audit_fields_to_captures` siguiendo el patrón de las migraciones de `20260523_*`.

**1.4 — Tabla `visits` sin audit fields**
Mismo problema que `captures`. [`20260330165447_init_field_operations_schema.js:17-33`](database/migrations/20260330165447_init_field_operations_schema.js#L17-L33).

**Fix:** migración nueva análoga.

**1.5 — FKs sin índices** (performance)
- `users.zona_id` — sin índice
- `stores.zona_id` — sin índice
- `daily_captures.store_id` — sin índice (agregado en `20260508` sin index)

**Fix:** migración que agrega índices `idx_users_zona_id`, `idx_stores_zona_id`, `idx_daily_captures_store_id`.

**1.6 — JSONB sin validación de schema**
Columnas como `role_permissions.permissions`, `daily_captures.exhibiciones`, `kpis_data`, `scoring_config` son blobs libres. Sin Zod o JSON Schema validation en backend.

**Fix:** definir schemas Zod en `libs/shared-domain-types` para cada JSONB, validar en serializers.

### 🟡 Importante

- **1.7** — Inconsistencia `captured_by_username` (string) vs `user_id` (FK) en captures/visits/daily_captures.
- **1.8** — `daily_assignments` con audit incompleto (`updated_at`/`updated_by` pero sin `created_by`/`deleted_at`).
- **1.9** — Migración con timestamping irregular: [`20260519_normalize_niveles_lowercase.js`](database/migrations/20260519_normalize_niveles_lowercase.js) sin hora, rompe convención.
- **1.10** — `role_permissions` sin `created_by`.
- **1.11** — `daily_captures` unique constraint `(user_id, fecha)` no actualizado al agregar `store_id`.

### 🟢 Nice-to-have

- **1.12** — `zona_captura` (string denormalizado) duplica info de `zona_id` (FK).
- **1.13** — Permisos `LOG_*` aún en seed `00_roles.js` aunque migración `20260522104500` los limpia.
- **1.14** — JSONB con naming camelCase/snake_case mezclado dentro del mismo blob.

---

## 2. Backend NestJS (13 findings)

### 🔴 Crítico

**2.1 — Servicios obesos (god services)**
- [`apps/api/src/modules/reports/reports.service.ts`](apps/api/src/modules/reports/reports.service.ts) — **1.399 LOC**. Mezcla cálculo de reports + broadcast WS + caché + transformaciones por scope.
- [`apps/api/src/modules/catalogs/catalogs.service.ts`](apps/api/src/modules/catalogs/catalogs.service.ts) — **788 LOC**. Mezcla CRUD + anti-escalation + scoring + soft-delete.
- [`apps/api/src/modules/visitas/visitas-sync.service.ts`](apps/api/src/modules/visitas/visitas-sync.service.ts) — **379 LOC**.

**Fix:** dividir en servicios cohesivos (extract `ReportsDataCalculator`, `PermissionsValidator`, etc.). Cualquier servicio > 400 LOC es candidato a partir.

**2.2 — DTOs aceptando `any` o `Record<string, any>`**
- `kpis_data!: Record<string, any>` en [`create-capture.dto.ts:5`](apps/api/src/modules/captures/dto/create-capture.dto.ts#L5)
- `@Body() body: any` en [`daily-captures.controller.ts:64`](apps/api/src/modules/daily-captures/daily-captures.controller.ts#L64)
- 14 ocurrencias de `@ReqUser() user: any`.

**Fix:** DTOs nested con `class-validator`, tipo `UserPayload` en lugar de `any`.

**2.3 — Error handling con silenciamiento**
- [`apps/api/src/modules/cron/tasks.service.ts:71`](apps/api/src/modules/cron/tasks.service.ts#L71): `catch (e) {}` — silencia.
- [`apps/api/src/modules/reports/reports.service.ts:731-733`](apps/api/src/modules/reports/reports.service.ts#L731-L733): catch de scope filtering loguea pero continúa **sin filtro** → puede retornar data de otros usuarios.

**Fix:** los catches que silencian son bugs. Eliminar o re-throw.

**2.4 — Archivos `.js` compilados checkeados en git (~70 archivos)**
Confunden, divergen, agregan ruido a diffs. Lo vimos varias veces este chat.

**Fix:** agregar `apps/api/src/**/*.js` al `.gitignore` y `git rm --cached` de los actuales.

### 🟡 Importante

- **2.5** — `ValidationPipe` configurado a nivel controller con opciones inconsistentes (algunos `whitelist: true`, otros `false`). Debería ser global en `main.ts`.
- **2.6** — `@Global()` innecesario en `scoring-v2.module.ts` (solo 2 consumidores).
- **2.7** — Transacciones Knex subutilizadas (solo 11 ocurrencias en 40+ servicios). Operaciones multi-tabla sin transacción → riesgo de inconsistencia.
- **2.8** — Lógica de permisos duplicada en `catalogs.controller.ts:41-64` (`checkCatalogManageAccess` con CASL hardcoded — debería ser decorator).
- **2.9** — Configuración hardcoded (`UPLOAD_TIMEOUT_MS`, `METRICS_COOLDOWN_MS`, etc.) que debería venir de `ConfigService`.
- **2.10** — Cobertura de tests: 3 archivos `.spec.ts` de 85+ módulos (~3.5%).

### 🟢 Nice-to-have

- **2.11** — Documentación Swagger sin `@ApiResponse` consistente para 4xx/5xx.
- **2.12** — Lógica de negocio en controllers (`daily-captures.controller.ts:64-115` parsea multipart en el controller en lugar de interceptor).
- **2.13** — Responses sin wrapper consistente (`{ data, meta }` mezclado con respuestas directas).

---

## 3. Frontend Angular (15 findings)

### 🔴 Crítico

**3.1 — Componentes mega-size**
- [`reports.component.ts`](apps/view/src/app/modules/dashboard/reports/reports.component.ts) — **3.047 LOC** en un solo archivo.
- [`reports/graphics/dashboard.component.ts`](apps/view/src/app/modules/dashboard/reports/graphics/dashboard.component.ts) — **1.801 LOC**.
- [`captures.component.ts`](apps/view/src/app/modules/dashboard/captures/captures.component.ts) — **1.356 LOC**.

**Fix:** extraer sub-componentes y servicios. Ningún componente debería superar 500 LOC.

**3.2 — Servicios monolíticos**
- [`daily-capture.service.ts`](apps/view/src/app/modules/dashboard/captures/daily-capture.service.ts) — **806 LOC**.
- [`retry-strategy.service.ts`](apps/view/src/app/core/services/retry-strategy.service.ts) — **430 LOC**.
- [`offline-sync.service.ts`](apps/view/src/app/core/services/offline-sync.service.ts) — **409 LOC**.

**Fix:** dividir en servicios cohesivos.

**3.3 — Mezcla de signals + BehaviorSubject**
Patrón inconsistente: algunos servicios usan signals (modernos), otros BehaviorSubject (legado). Confunde a consumidores.

**Fix:** estandarizar en signals + `toObservable()` cuando se necesite stream.

**3.4 — Sin interceptor global de errores**
Solo hay `auth.interceptor` (maneja 401). Sin handling consistente de 403/500/timeout. Cada componente hace `MessageService.add()` manual.

**Fix:** crear `error.interceptor.ts` + `ErrorNotificationService` singleton.

### 🟡 Importante

- **3.5** — Strings hardcoded en español (sin i18n setup).
- **3.6** — 222 ocurrencias de `: any` en frontend.
- **3.7** — Solo 1 `.spec.ts` en 70+ componentes.
- **3.8** — Reconexión WS robusta pero sin manejo de "eventos perdidos durante reconexión" (no hay reconciliación de state).
- **3.9** — `LayoutComponent` no está lazy-loaded → carga toda la UI dashboard al arrancar.
- **3.10** — `permissions.service.ts:32` recibe `rules: any[]` perdiendo tipos.

### 🟢 Nice-to-have

- **3.11** — Mix PrimeNG + Spartan + Tailwind sin guía de design system documentada.
- **3.12** — Interfaces duplicadas entre módulos (no hay `shared/models/` central).
- **3.13** — `OfflineDatabaseService` (256 LOC) podría usar Dexie wrapper más robusto.
- **3.14** — 94 `console.log` sin envolver en `ngDevMode` (van a prod).
- **3.15** — Falta documentación de qué eventos WS emite y consume cada componente.

---

## 4. Configuración / Seguridad (18 findings)

### 🔴 Crítico — vulnerabilidades activas

**4.1 — CORS `origin: '*'` con `credentials: true`**
[`apps/api/src/main.ts:43-50`](apps/api/src/main.ts#L43-L50). Combinación inválida en CORS spec, navegadores modernos la rechazan o la procesan inconsistentemente. **Es vulnerabilidad de CSRF / robo de sesión.**

**Fix:** lista blanca de orígenes en env var:
```ts
origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['https://trade-marketing.megadulces.mx'],
```

**4.2 — JWT secret con fallback inseguro hardcoded**
Strings como `'super_secret_dev_key_change_in_prod'` en múltiples lugares del código como fallback si la env var falta. Si en algún ambiente la env falta, los tokens son forgeables trivialmente.

**Fix:** sin fallback. Si `JWT_SECRET` no está definido, **abortar boot** con error claro.

**4.3 — Credenciales en `.env` no protegido suficiente**
`.env` contiene `DATABASE_URL` (con password de Postgres prod), `CLOUDINARY_API_SECRET`. Aunque está en `.gitignore`, vivir en disco del dev es riesgo de backup/leak accidental.

**Fix:** estructura mínima de `.env` localmente para dev. **Producción: solo variables en Railway dashboard.**

**4.4 — `console.log` con data sensible llega a prod**
Logs con GPS, usernames, folios, datos de zona en `daily-captures.service.js` y `catalogs.service.js`. Visibles en logs de Railway.

**Fix:** reemplazar por `Logger` con niveles + redactar campos sensibles.

**4.5 — Vulnerabilidades HIGH en deps (npm audit)**
- Angular 18.2.x: XSS via SVG, i18n, URL.
- @nestjs/core <=11.1.17: path-to-regexp injection.
- @babel/plugin-transform-modules-systemjs: arbitrary code execution.

**Fix:** `npm audit fix`. Angular requiere `--force` (upgrade major a v19+, validar breaking changes).

### 🟡 Importante

- **4.6** — Sin Helmet activado en NestJS (paquete instalado pero no usado en `main.ts`).
- **4.7** — Sin rate limiting (paquete `@nestjs/throttler` instalado pero no configurado).
- **4.8** — Body parser limit `50mb` global (debería ser específico para endpoints de upload).
- **4.9** — Container corre como root (sin `USER` en Dockerfile).
- **4.10** — Sin headers de seguridad en nginx (X-Frame-Options, CSP, HSTS).
- **4.11** — Archivos `*.log` en raíz del repo sin rotación.
- **4.12** — Sin HEALTHCHECK en Dockerfile (lo quitamos a propósito, pero conviene reconsiderar uno simple tipo TCP-check al puerto 10000).
- **4.13** — `.env.cloudinary` adicional con credenciales parciales duplicadas.

### 🟢 Nice-to-have

- **4.14** — Migrations en boot sin timeout ni rollback automático.
- **4.15** — JWT expiration 12h sin refresh tokens.
- **4.16** — Swagger `/api/docs` expuesto en prod sin auth (revela estructura de API).
- **4.17** — Socket.IO sin CORS explícito (hereda de Express? validar).
- **4.18** — `.npmrc` con `legacy-peer-deps=true` enmascarando conflictos.

---

## Plan correctivo recomendado (Sprint A.0bis)

Los **19 críticos** se atacan en este orden de prioridad (riesgo de seguridad primero, deuda técnica después):

### Bloque 1 — Seguridad inmediata (1 sem) ⚠️
1. [4.1] CORS lista blanca con env var
2. [4.2] JWT secret sin fallback (abortar boot si falta)
3. [4.3] Auditar `.env` actual, mover credenciales prod 100% a Railway
4. [4.5] `npm audit fix` + plan de upgrade Angular 19
5. [4.4] Reemplazar `console.log` sensibles por Logger
6. [2.3] Quitar `catch (e) {}` que silencian errores en cron

### Bloque 2 — Cleanup técnico (1 sem) 🧹
7. [2.4] Borrar `.js` duplicados + `.gitignore`
8. [4.11] Borrar archivos `*.log` de raíz
9. [4.13] Consolidar `.env.cloudinary` en `.env`
10. [1.2] Reseed con role names consistentes + migración renombrado

### Bloque 3 — Schema fundamentos (1 sem) 🗄️
11. [1.3] Audit fields a `captures`
12. [1.4] Audit fields a `visits`
13. [1.5] Índices en FKs frecuentemente consultados (`zona_id`, `store_id`, `user_id`)
14. [1.6] Schemas Zod para JSONBs principales

### Bloque 4 — Hardening backend (1 sem) 🔐
15. [4.6] Activar Helmet
16. [4.7] Configurar Throttler global con reglas por endpoint
17. [4.8] Body parser limits diferenciados
18. [4.9] User non-root en Dockerfile
19. [4.10] Headers de seguridad en nginx

### Bloque 5 — Refactor god services (2-3 sem) 🔨
20. [2.1] Dividir `reports.service` (1399 LOC) en 4 servicios cohesivos
21. [2.1] Dividir `catalogs.service` (788 LOC) en 2-3 servicios
22. [3.1] Dividir `reports.component` (3047 LOC) en componentes feature
23. [3.2] Dividir `daily-capture.service` (806 LOC) front

**Total Sprint A.0bis estimado: 5-7 semanas** para 1 dev. **Después de esto, Sprint A.0 (limpieza inmediata) ya queda absorbido.**

---

## Items que NO se atacan ahora (deuda aceptada)

Estos se difieren al sprint correspondiente o a fases posteriores:

- **3.5 (i18n)**: solo si Mega Dulces planea internacionalización.
- **3.11 (design system docs)**: cuando exista lib `shared-ui` (Fase A.5).
- **2.10 / 3.7 (tests)**: cobertura crece a partir de Sprint A.3, sin pretender 80% al instante.
- **4.16 (Swagger en prod)**: bloquear con auth en Fase D cuando haya portal B2B.
- **1.7-1.14 (consistencia naming, normalizaciones)**: progresivo, no bloqueante.
- **3.4 / 3.10 (interceptor errores, tipos any)**: Sprint A.5 cuando se cree `shared-domain-types`.

---

## Addendum — Hallazgos sesión QA 2026-06-02

Findings descubiertos post-auditoría inicial, durante una sesión de QA + caza de
bugs internos. Todos **ya resueltos** salvo donde se indique. Detalle en
[`03_LOG_REVISIONES.md`](03_LOG_REVISIONES.md) (entrada 2026-06-02).

### 🔴 Crítico

**S2.1 — Clase "transacción envenenada" (25P02 / rollback silencioso)** ✅ FIXED
`TenantContextInterceptor` corre TODA request autenticada en una sola trx; un
`catch` que traga un error DB y sigue queryeando tira `25P02` o el COMMIT hace
rollback silencioso. Afectó: `daily-captures` (INSERT idempotente → savepoint),
`registrarLog` (conexión separada), `safeRecalcularScoreMaximo` + `embedProduct`
(savepoint). Patrón a evitar en TODO handler que corre dentro de la trx global.

**S2.2 — `VisitasSyncModule` roto contra el schema** ✅ FIXED (eliminado)
Referenciaba tabla `tiendas` (nunca existió; la canónica es `stores`), tabla
`sync_logs` (nunca creada) y 9 columnas inexistentes en `daily_captures`. Wired
con 2 controllers → cualquier llamada real 500. Frontend usa `/daily-captures`.
Módulo borrado tras verificar 0 uso.

**S2.4 — Promo form guarda percent 1-100 pero el engine quiere [0..1]** ✅ FIXED
`comercial-promotions` guardaba `percent: 15`; el engine hace `Math.min(1, pct)`
→ una promo creada por UI aplicaba **100% de descuento**. Fix: conversión
fracción↔1-100 en el borde (load/save + tiers).

### 🟡 Importante

**S2.3 — `ExhibitionsModule`: POST huérfanos sin autorización** ✅ FIXED (eliminado)
`@Post()` y `@Post(:id/photos)` solo con `RequireAuthGuard` (sin RolesGuard ni
permisos ni ValidationPipe) → cualquier autenticado creaba nodos / subía a
Cloudinary. Frontend no los llama. Borrado.

**S2.5 — Reports sin filtro `tenant_id` (RLS bypasseado)** ✅ FIXED
`buildBaseQuery` + counts de `stores` no filtraban tenant; la conexión legacy es
`postgres` (bypassa RLS) → leak latente con 2+ tenants. Filtro explícito agregado.

**S2.6 — `REFRESH MATERIALIZED VIEW CONCURRENTLY` en MV sin poblar** ✅ FIXED
`AnalyticsRefreshService` fallaba si la MV no estaba poblada. Ahora chequea
`pg_class.relispopulated` y hace REFRESH normal la primera vez.

**S2.7 — Inventory list devolvía pagination flat** ✅ FIXED
`commercial-inventory` devolvía `{data, page, pageSize, total}` flat; el resto de
endpoints + el frontend usan `{data, pagination:{...}}` → contador en 0. Anidado.

### 🟢 Nice-to-have / diferido

**S2.8 — Promo display no convertía fracción a %** ✅ FIXED
Mostraba `-0.15%` en vez de `-15%`. Fix ×100 en `promotions-meta`.

**S2.9 — Historical (FDW) "0 clientes únicos"** ⏳ DEFERRED
Módulo nuevo en curso; el conteo de unique customers de la fuente FDW parece roto.

**S2.10 — `isPercent` backend acepta ≤100** ⏳ DEFERRED
Debería ser ≤1 (convención fracción del engine). El form ya manda fracciones, así
que no rompe; endurecer como defensa.

---

## Addendum — Cobertura del factor de caja de Wincaja (2026-09-07)

Medido en prod al preguntarse *"¿ya se traen todas las unidades por caja de Wincaja?"*. **La
respuesta es no**, y el faltante se parte en tres casos con veredicto distinto.

`analytics.v_warehouse_box_factor` (ADR-055) toma el divisor de `wincaja.articulos.factor_venta`
**sólo donde `factor_venta > 1`**; si no, cae al `box_factor` de Kepler, que está en unidades BASE.
Por almacén de Wincaja, de ~11,212 productos del catálogo:

| origen del divisor | productos | con existencia | divisor prom | qué significa |
|---|---|---|---|---|
| `wincaja_factor_venta` | **8,680** (77.4%) | 3,074 | 29.48 | correcto, es Wincaja quien manda |
| `default` (divisor 1) | **2,263** (20.2%) | 169 | 1.00 | **sin factor en ninguna fuente** |
| `kepler_c84` | 83 | 44 | 23.96 | divisor del ERP que no manda acá |
| `etiquetera` | 76 | 20 | 19.05 | idem |
| `override` | 65 | 28 | 16.15 | idem |
| `factor_sale` | 45 | 18 | 18.98 | idem |

(cifras de MD-30; suman 11,212 productos y 3,353 con existencia.)

**⚠️ Corrección de una primera lectura de este mismo día.** El primer conteo llevaba un filtro
`box_factor > 1` y reportó "243 heredan de Kepler", presentando el sub-caso de 15 productos (W1.1)
como si fuera el problema. **No lo es.** Con el corte abierto la exposición son **2,532 productos**
—los 2,263 sin factor más los 269 con divisor de Kepler—, de los cuales **279 tienen existencia
hoy**. De esos 2,532, **1,385 sí están en `wincaja.articulos` con `factor_venta = 1`** (1,176 PZA,
120 KGS, 84 CJA) y los otros **1,147 no existen en `articulos`**: son productos del catálogo de
Kepler parados en un almacén de Wincaja, y para ellos el divisor de Kepler es defendible.

**W1.0 — 2,263 productos (20% del almacén) con divisor 1 sin fuente que lo respalde** 🟠 *DECLARADO
en pantalla 2026-09-07; la cifra NO se cambió, y el motivo está medido abajo*
Es el hallazgo grande, y no el que se nombró primero. `default` significa que ninguna fuente declaró
un factor, así que la pantalla divide por 1 = "se muestra en unidad nativa". Eso es correcto **sólo
si** el producto de verdad va uno por caja, y **no está verificado para ninguno de los 2,263** (169
con existencia). Es el patrón que ADR-056 nombra: lo que no se pudo medir se declara, y el divisor 1
se publicaba como si fuera un hecho.

**Resuelto como DECLARACIÓN, no como corrección de la cifra — y el motivo está medido.** Ocultar
esas celdas del total (la regla estricta *"convertir sólo con factor con fuente y unidad que no sea
peso"*) borraría entre **24% y 58% del total de cajas de CADA almacén**, y **no sólo de Wincaja**:

| almacén | cajas hoy | con la regla estricta | |
|---|---|---|---|
| `00` CEDIS | 25,699.6 | 11,788.5 | −54.1% |
| `01` (Kepler) | 29,774.4 | 18,854.3 | −36.7% |
| `05` (Kepler) | 6,320.3 | 2,630.3 | −58.4% |
| `MD-30` | 32,450.9 | 24,695.8 | −23.9% |
| `MD-32` | 8,988.6 | 4,646.4 | −48.3% |

Son 1,692 celdas, y **11 de ellas no tienen ni rótulo nativo** que mostrar en su lugar. Eso es una
decisión de negocio, no una corrección técnica, así que la cifra se dejó intacta y lo que se agregó
es que **se vea**: KPI "Sin factor de caja", banner que declara la causa, y un grado `°` por celda
con su explicación en el `title` (y en texto para lector de pantalla, porque el símbolo no puede ser
el único portador). Vive en `existencia.service.ts` como el predicado `sinFactor()`, hermano de
`MEDIBLE`, y en la respuesta como `celdas_sin_factor` / `skus_sin_factor` / `cells[].nf`.

**Lo que falta decidir (de Edgar):** si el total de cajas debe excluir lo que no tiene factor. Hasta
entonces el número es el mismo de siempre, pero ya no se lee como si todas sus celdas tuvieran
respaldo.

**W1.1 — `unidad_venta = 'CJA'` + `factor_venta = 1`: el divisor de Kepler pisa la declaración de
Wincaja** 🟡 *(chico, pero es el único caso con prueba positiva)*
**15 productos por almacén** (7 con existencia en MD-30, 1 en MD-32, 0 en el 00). Rastreo completo de
los 193 `CJA + fv=1` de la rama 30: **109 no están en `catalog.products`** (no salen en pantalla),
**65 ya reciben divisor 1** por `default` (correcto), **19 heredan de Kepler** y de esos **15 con
divisor > 1**. Por eso da 15 y no más: la mayoría ya cae bien o no está en el catálogo. Verificado
además que **`CJA` es el único rótulo de caja que existe** — los valores son PZA 15,154 / CJA 197 /
KGS 165 / SER 11 / N/A 1, sin `PAQ`, `CAJ` ni `PQT` escondidos subcontando. Wincaja declara que
su unidad de venta **ya es la caja** — `CJA` con factor 1 es coherente y sin ambigüedad — y la vista
divide por **21.07** de todos modos, porque el `> 1` descarta la declaración. Es el espejo del bug
que ADR-055 cerró: aquel dividía entre 140 en vez de 14; éste divide entre 21 en vez de 1. Arreglo =
una condición en la vista (tomar `factor_venta` cuando el SKU existe en `articulos`, no cuando es
`> 1`), pero **cambia una cantidad en pantalla para 8 SKUs**, así que va con su antes/después.

**W1.2 — `unidad_venta = 'PZA'` + `factor_venta = 1`: supuesto no declarado** 🟡
**1,176 productos por almacén, 223 con existencia** en MD-30 (de los cuales 215 / 84 llevan además
un divisor > 1 heredado de Kepler; el resto cae en `default`). Acá `fv = 1` **no** es declaración: "1
pieza = 1 caja" no se sostiene en dulcería, es ausencia de captura. Reparto que lo prueba (rama 30,
`actual`): con `fv = 1` hay 1,872 PZA / 193 CJA / 152 KGS, y con `fv > 1` hay 13,282 PZA — o sea el
campo está poblado para unos PZA y no para otros. El fallback a Kepler es lo menos malo, pero hoy
**no se declara**: la pantalla muestra el divisor sin decir que vino del ERP que no manda en ese
almacén. `factor_source` ya lo sabe (`kepler_c84`, `etiquetera`, `factor_sale`, `override`); falta
que llegue al usuario.

**W1.3 — `unidad_venta = 'KGS'` con divisor de caja** 🟡
**120 productos por almacén, 38 con existencia** en MD-30 (13 / 7 de ellos con divisor > 1 de
Kepler, el mayor promediando **41.54**). Dividir kilos por
un factor de caja no significa nada. La vista **ya expone `is_weight`** y `existencia.service.ts` la
selecciona (línea 360), pero pasa la bandera hacia el frontend sin cortar la división — hay que
verificar si la pantalla la respeta. Nota lateral: `v_product_box_factor` marca `is_weight` en **44**
de los 215 que Wincaja llama `PZA`; las dos fuentes no coinciden en qué es peso.

**Cómo se midió:** cruce de `analytics.v_warehouse_box_factor` contra `wincaja.articulos`
(`source_dataset = 'actual'`, por `source_branch` del almacén) y contra `commercial.stock` para
separar lo que se ve en pantalla hoy de lo que sólo está en el catálogo. Ejemplos vivos: MD-30 sku
`59038` con 465 PZA se ve como **19.38** (divide por 24); el 00 con 1,646 PZA se ve como **68.58**.

---

## Addendum — El sync de Wincaja entrega la MITAD y reporta `ok` (2026-09-07)

> ⚠️ **CORREGIDO el mismo día, después de leer el log y la fuente.** La primera versión de W2.1
> (abajo) concluyó que *"la carga entrega la mitad"* y que el churn quedaba descartado porque
> `detalles_mov_almacen` tuvo todas sus filas tocadas mientras su maestro tuvo cero. **Ese argumento
> era malo:** maestro y detalle simplemente usan estrategias de escritura distintas (uno reescribe
> incondicionalmente, el otro es UPSERT-sin-churn), así que la diferencia no prueba nada. El log de
> hoy muestra que BRONZE **leyó todas las tablas** y reportó conteos reales
> (`Existencias -> existencias 15529 OK` en la rama 00). El defecto es **aguas arriba** y está en
> W2.2. Se deja el texto original porque el modo de falla del latido sigue siendo cierto.

**W2.2 — el sync lee el `.mdb` ANTES de que se copie: siempre carga el archivo de ayer** 🔴

Los tiempos de modificación de `Z:\Salidas\Bases\Actuales` contra el horario del job:

| archivo | modificado | |
|---|---|---|
| `30 MORELIA ABASTOS.MDB` | 2026-09-07 **08:45** | se copia DESPUÉS del sync |
| `32 MORELIA MADERO.MDB` | 2026-09-07 **08:46** | idem |
| `0 BPIRAPUATO MOV.MDB` | 2026-09-07 **08:43** | idem |
| `0 BPIRAPUATO.mdb` | 2026-09-**05** 12:33 | **dos días**, y es el grande (636 MB) |

**`sync-wincaja-actual.ps1` arranca 05:00:02 y termina BRONZE 06:16.** Las copias llegan ~2.5 h
después. O sea cada corrida consume el archivo del día anterior — y por eso las tablas
UPSERT-sin-churn no mueven `imported_at`: **de verdad no cambió nada, porque leyó el mismo archivo**.
Las que reescriben incondicionalmente (`detalles_mov_almacen`, `cotizacion_lineas`,
`faltantes_cotizacion`, `autorizaciones`) sí quedan con fecha de hoy, pero con **contenido de ayer**
— que es peor que estar viejo: es dato viejo con etiqueta fresca.

Arreglo obvio y barato: **correr el sync después de la copia**, no antes. Las dos mitades ya existen;
lo único mal puesto es el orden.

Aparte, `0 BPIRAPUATO.mdb` con dos días es un problema propio: su hermano `MOV` sí se copió hoy, así
que la copia del grande falla o se salta. El hueco del **05-sep** (no hay
`sync_actual_20260905_*.log` y el salto de `imported_at` fue de 47.9 h) es consistente con eso.

**Lo que NO es un problema:** que `10 PHIDALGO.MDB` (26-ago), `40 8ESQUINAS.MDB` (26-ago),
`44 YURECUARO.MDB` (23-jul), `42 PIEDAD ABASTOS.MDB` (**2024-01-09**) y las rutas 21-28 / 321 / 322
estén viejos. Esas sucursales ya operan en Kepler; sus `.mdb` son histórico. Los tres que importan
—CEDIS `00`, MD-30 y MD-32— son exactamente los tres que sí se copian a diario.

---

**W2.1 — el latido dice `ok` sin medir entrega** 🟠 *(mecanismo corregido por W2.2; el defecto del
latido queda)*

Salió del smoke de Existencia, que reportó `frescura: kepler=0.4min · wincaja=1955.6min` (**32.6 h**).
Antes de dar la alarma se descartaron las dos explicaciones inocentes:

1. **¿Cadencia normal?** No. La carga es **diaria ~05:00 MX** (`sync-wincaja-actual.ps1`, latido
   `wincaja_sync` "Wincaja sync (BRONZE+GOLD)"). El historial de `imported_at` da saltos de 23.9 h /
   24.0 h — y luego uno de **47.9 h** entre el 04-sep y el 06-sep. O sea ya se había saltado un día.
2. **¿UPSERT sin churn?** Tampoco, y esto es lo que lo cierra: `detalles_mov_almacen` tuvo
   **1,159,050 de 1,159,050 filas tocadas hoy** mientras su propio maestro `maestro_mov_almacen`
   tuvo **0**. Un detalle no puede ganar los renglones de hoy si su maestro no gana ninguno.

**Reparto medido (dataset `actual`), tras una corrida que reportó `ok` hace 6.7 h:**

| refrescadas hoy (7.6–7.9 h) | clavadas en 32.6–32.7 h, **0 filas tocadas** |
|---|---|
| `detalles_mov_almacen` 1,159,050 | `precios` 1,882,733 · `existencias` **321,977** · `articulos` 322,019 |
| `cotizacion_lineas` 118,948 | `movimiento_clientes` 253,306 · `pagos_dia` 249,215 |
| `faltantes_cotizacion` 15,236 | `maestro_mov_almacen` 186,413 · `clientes` 30,480 |
| `autorizaciones` 10,827 | `arqueos` 15,598 · `retiros` 15,472 · `ofertas` 14,246 |
| | `cotizaciones` 12,246 · `cortes` 3,261 · `movimiento_proveedores` 4,460 |

`pagos_dia` con 249 k filas y **cero** tocadas en un día que las tiendas vendieron no se sostiene;
`cortes` tampoco (una tienda que vende genera cortes diarios).

**Consecuencia concreta:** `wincaja.existencias` es del **06-sep 05:11 MX**, así que la pantalla de
Existencia muestra el inventario de CEDIS, MD-30 y MD-32 con **día y medio** de atraso mientras la
mitad Kepler va en 0.4 min. Y el sensor no lo dice: `wincaja_sync` está en **`ok`**.

Es exactamente el modo de falla de **ADR-053 / Fase OBS**: *latido de proceso, no de entrega*. El
incidente del carril de catálogos (6 días parado mientras la app publicaba precios) fue esta misma
forma. Lo que falta es lo que OBS.1 ya hizo para el ODS: que el latido mida **filas entregadas por
tabla**, no "el script terminó sin lanzar" — un paso que sale con código 0 sin escribir nada hoy
pasa la compuerta.

**No diagnosticado todavía:** POR QUÉ divergen los dominios. `import-wincaja.js` corre con
`--domain all --source replica` (las ramas 30/32/00 leen de `:5433/wincaja`, las demás caen a Jet);
hay que ver el log de la corrida de hoy para saber si un dominio falló silenciosamente o si el
`--source replica` sólo cubre parte de las tablas.

---

## Cómo usar este documento

1. Cada finding tiene un código (`1.1`, `2.3`, etc.). Cuando se arregla, agregar fecha en `03_LOG_REVISIONES.md` con referencia al código.
2. El plan correctivo (Sprint A.0bis) está reflejado como tareas en `01_TRACKER_PROGRESO.md`.
3. Cualquier finding rechazado/diferido debe quedar documentado con razón en este archivo (sección "deuda aceptada").
4. Al cerrar Sprint A.0bis, este archivo se marca como `# AUDITORIA_BASE_INICIAL.md (cerrado)` y se genera nuevo `AUDITORIA_BASE_POST_FIX.md` si se quiere verificar.
