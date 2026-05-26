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

## Cómo usar este documento

1. Cada finding tiene un código (`1.1`, `2.3`, etc.). Cuando se arregla, agregar fecha en `03_LOG_REVISIONES.md` con referencia al código.
2. El plan correctivo (Sprint A.0bis) está reflejado como tareas en `01_TRACKER_PROGRESO.md`.
3. Cualquier finding rechazado/diferido debe quedar documentado con razón en este archivo (sección "deuda aceptada").
4. Al cerrar Sprint A.0bis, este archivo se marca como `# AUDITORIA_BASE_INICIAL.md (cerrado)` y se genera nuevo `AUDITORIA_BASE_POST_FIX.md` si se quiere verificar.
