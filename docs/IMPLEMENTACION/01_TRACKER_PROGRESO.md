# Tracker de Progreso

> Kanban con estado granular por item: **código → probado → staging → prod**. Cada ítem tiene código `[Fase.Sprint.N]`. **Mantener actualizado SIEMPRE** — es la fuente de verdad de qué está hecho, qué está probado y qué falta.

**Última actualización:** 2026-05-26

---

## 📊 Estado global de fases

| Fase | Estado | Sprint actual | % completado |
|---|---|---|---|
| A — Fundaciones | 🟡 En progreso | A.-1 ✅ → próximo: **A.0-multitenant** | 8% |
| B — Kepler | ⏸️ Bloqueada por A | — | 0% |
| C — Sales Intelligence | ⏸️ Bloqueada por A | — | 0% |
| D — Catálogo + B2B Portal | ⏸️ Bloqueada por B | — | 0% |
| E — Remote Manager | ⏸️ Bloqueada por D | — | 0% |
| F — WhatsApp Bot | ⏸️ Bloqueada por D | — | 0% |
| G — Growth | ⏸️ Bloqueada por D | — | 0% |
| H — Fintech | ⏸️ Bloqueada por D | — | 0% |
| I — ML + WS scaling | ⏸️ Bloqueada por H | — | 0% |

Leyenda fase:
- 🔴 No iniciada · 🟡 En progreso · 🔵 En revisión · 🟢 Completada · ⏸️ Bloqueada

---

## 🚦 Estado por item (granular)

Cada item del tracker tiene un estado compuesto que indica EXACTAMENTE en qué punto del pipeline está:

| Símbolo | Significado |
|---|---|
| ⬜ | TODO — no iniciado |
| 🔨 | EN CÓDIGO — implementación en curso |
| 🧪 | PROBADO — código + tests pasando local |
| 🚀 | STAGING — deployado en staging, smoke test ok |
| ✅ | PROD — en producción, observado sin issues 24h+ |
| ⚠️ | BLOCKED — bloqueado por algo externo (lista la razón) |
| ❌ | REVERTED — se intentó y se hizo rollback (registrar en `03_LOG_REVISIONES.md`) |

**Regla:** ningún item llega a ✅ sin haber pasado por 🧪 → 🚀.

**Convención**: cada item tiene la línea:
```
- [ ] **[A.X.N]** ⬜ Descripción del item
```
Y se actualiza el símbolo al avanzar:
```
- [x] **[A.X.N]** ✅ Descripción (cerrado 2026-06-01)
```

---

## 🎯 EN PROGRESO

> Items que un dev está trabajando AHORA. Idealmente 1-3 a la vez. Más que eso = pérdida de foco.

_(vacío — iniciar con Fase A)_

---

## 👀 EN REVISIÓN

> Items terminados pero pendientes de validación (tests, code review, deploy a staging, validación funcional).

_(vacío)_

---

## ✅ HECHO

> Items completados y deployados a producción. Mantener para historial. Limpiar cada cierre de fase moviendo a `03_LOG_REVISIONES.md`.

_(vacío)_

---

## 📋 BACKLOG — Fase A: Fundaciones

> Empezar por aquí. Cada ítem es un commit-able task.

### Sprint A.-1 — Auditoría profunda de la base existente ✅

> **Estado: COMPLETADO 2026-05-26.** Findings consolidados en `AUDITORIA_BASE_INICIAL.md`.
> 60 issues encontrados: 19 críticos, 25 importantes, 16 nice-to-have.

- [x] **[A.-1.1]** ✅ Auditoría schema DB → 14 findings (6 críticos) — cerrado 2026-05-26
- [x] **[A.-1.2]** ✅ Auditoría backend NestJS → 13 findings (4 críticos) — cerrado 2026-05-26
- [x] **[A.-1.3]** ✅ Auditoría frontend Angular → 15 findings (4 críticos) — cerrado 2026-05-26
- [x] **[A.-1.4]** ✅ Auditoría config/seguridad → 18 findings (5 críticos) — cerrado 2026-05-26
- [x] **[A.-1.5]** ✅ Documento consolidado: `AUDITORIA_BASE_INICIAL.md` — cerrado 2026-05-26

---

### Sprint A.0-multitenant — Nueva DB Postgres con multi-tenancy (~3-4 sem) 🔥

> **PRIORIDAD ALTA** (decisión 2026-05-26, ADR-010). Aplicar correcciones del audit sobre schema limpio nuevo. Mega Dulces = primer tenant. Detalle completo en `FASES/FASE_A0_MULTITENANT_NEW_DB.md`.

#### A.0mt.1 — Aprovisionamiento + schema base (5 días)
- [x] **[A.0mt.1.1]** ✅ DB `postgres_platform` creada local en `192.168.0.245:5432` con Postgres 18.4 (2026-05-26). **Migración a Railway pendiente** — se hará en cutover Sprint A.0mt.5.
- [x] **[A.0mt.1.2]** ✅ Variables `DATABASE_URL_NEW` + `NEW_DB_*` agregadas a `.env` local + `.env.example` template (2026-05-26).
- [x] **[A.0mt.1.3]** ✅ `database/knexfile-newdb.js` creado con segunda conexión + dotenv loading explícito + directorios `migrations-newdb/` + `seeds-newdb/` (2026-05-26).
- [x] **[A.0mt.1.4]** ✅ Migración `20260526000001_init_tenants_and_extensions.js` aplicada en local: tabla `tenants` + extensión `pgcrypto` + función `current_tenant_id()`. Seed `01_first_tenant_mega_dulces.js` insertó tenant `mega_dulces` (`00000000-0000-0000-0000-00000000d01c`) (2026-05-26).
- [x] **[A.0mt.1.5]** ✅ Helper `setTenantContext` + `runWithTenant` + `TenantKnexService` creados en `apps/api/src/shared/database/tenant-knex.service.ts` + módulo `NewDatabaseModule` (sin wirear al AppModule todavía — esperará al cutover) (2026-05-26).
- [x] **[A.0mt.1.6]** ✅ Test end-to-end `database/test-newdb-tenant-context.js`: 8/8 pass — incluye aislamiento entre tx concurrentes con tenants distintos, no-leak post-commit, validación regex anti-injection (2026-05-26).

#### A.0mt.2 — Schema completo + RLS (1-1.5 sem)
- [ ] **[A.0mt.2.1]** ⬜ Diseño detallado: revisar cada tabla legacy + decidir inclusión
- [ ] **[A.0mt.2.2]** ⬜ Migración: tablas core (`users`, `zones`, `rutas`, `role_permissions`)
- [ ] **[A.0mt.2.3]** ⬜ Migración: catálogos (`catalogs`, `planograma_*`)
- [ ] **[A.0mt.2.4]** ⬜ Migración: operación (`stores`, `daily_assignments`, `visits`, `exhibitions`, `exhibition_photos`)
- [ ] **[A.0mt.2.5]** ⬜ Migración: capturas (`captures`, `daily_captures`)
- [ ] **[A.0mt.2.6]** ⬜ Migración: scoring (`scoring_config`)
- [ ] **[A.0mt.2.7]** ⬜ Migración: índices `idx_*_tenant_id` en todas
- [ ] **[A.0mt.2.8]** ⬜ Migración: políticas RLS en todas las tablas
- [ ] **[A.0mt.2.9]** ⬜ Seed: rol superadmin + usuario superoot con `tenant_id = mega_dulces`
- [ ] **[A.0mt.2.10]** ⬜ Tests RLS: tenant A NUNCA lee data de tenant B

#### A.0mt.3 — Integración NestJS (1 sem)
- [ ] **[A.0mt.3.1]** ⬜ `TenantContextInterceptor` global que extrae `tenant_id` del JWT
- [ ] **[A.0mt.3.2]** ⬜ `AsyncLocalStorage` para propagar tenant context
- [ ] **[A.0mt.3.3]** ⬜ Wrapper `KnexTenantService` que setea `app.tenant_id` por transacción
- [ ] **[A.0mt.3.4]** ⬜ JWT extendido con `tenant_id` + actualizar `auth.service`
- [ ] **[A.0mt.3.5]** ⬜ Login multi-tenant
- [ ] **[A.0mt.3.6]** ⬜ Endpoint admin `POST /admin/tenants`
- [ ] **[A.0mt.3.7]** ⬜ Tests integración: 2 tenants, aislamiento verificado

#### A.0mt.4 — Migración data legacy → nueva DB (1 sem)
- [ ] **[A.0mt.4.1]** ⬜ Script `migrate-legacy-to-newdb.ts` con dry-run mode
- [ ] **[A.0mt.4.2]** ⬜ Migrar `zones`, `catalogs` (independientes)
- [ ] **[A.0mt.4.3]** ⬜ Migrar `users` + `role_permissions`
- [ ] **[A.0mt.4.4]** ⬜ Migrar `stores` + `rutas` + `daily_assignments`
- [ ] **[A.0mt.4.5]** ⬜ Migrar `visits` + `exhibitions` + `exhibition_photos`
- [ ] **[A.0mt.4.6]** ⬜ Migrar `captures` + `daily_captures`
- [ ] **[A.0mt.4.7]** ⬜ Migrar `scoring_config`
- [ ] **[A.0mt.4.8]** ⬜ Validación: conteos por tabla + spot-check 50 visitas
- [ ] **[A.0mt.4.9]** ⬜ Reporte de migración (qué se migró/descartó/falló)

#### A.0mt.5 — Cutover (3 días)
- [ ] **[A.0mt.5.1]** ⬜ Documentar plan cutover paso a paso
- [ ] **[A.0mt.5.2]** ⬜ Validar API contra nueva DB en staging por 7 días
- [ ] **[A.0mt.5.3]** ⬜ Snapshot final DB legacy (backup)
- [ ] **[A.0mt.5.4]** ⬜ Sync delta (data nueva desde primer migrate)
- [ ] **[A.0mt.5.5]** ⬜ Cutover: cambiar `DATABASE_URL` en prod → nueva DB
- [ ] **[A.0mt.5.6]** ⬜ Monitoreo 24h post-cutover
- [ ] **[A.0mt.5.7]** ⬜ DB legacy → read-only por 30 días, luego archivar

#### Checkpoint A.0-multitenant
- [ ] **[A.0mt.6.1]** ⬜ Toda data Mega Dulces en nueva DB con `tenant_id` poblado
- [ ] **[A.0mt.6.2]** ⬜ API en prod opera contra nueva DB
- [ ] **[A.0mt.6.3]** ⬜ Tests aislamiento pasan en CI
- [ ] **[A.0mt.6.4]** ⬜ ADR-010 actualizado con realidad final
- [ ] **[A.0mt.6.5]** ⬜ Entry cierre en `03_LOG_REVISIONES.md`

**Total Sprint A.0-multitenant: 3-4 sem.** Resuelve automáticamente findings 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.10, 1.11, 1.13 del audit. El resto (backend/frontend/config) se aborda en A.0bis con la nueva DB ya operando.

---

### Sprint A.0bis — Plan correctivo (~5-7 sem)

> **Objetivo:** arreglar los 19 críticos del audit en orden de prioridad. **Ningún feature nuevo hasta cerrar este sprint.**

#### Bloque 1 — Seguridad inmediata (1 sem) ⚠️
- [ ] **[A.0bis.1]** ⚠️ BLOCKED por usuario [Finding 4.1] CORS — **diferido por decisión 2026-05-26**
- [ ] **[A.0bis.2]** ⚠️ BLOCKED por usuario [Finding 4.2] JWT secret fallback — **diferido por decisión 2026-05-26**
- [ ] **[A.0bis.3]** ⚠️ BLOCKED por usuario [Finding 4.3] credenciales `.env` — **diferido por decisión 2026-05-26**
- [ ] **[A.0bis.4]** ⬜ [Finding 4.5] `npm audit fix` + evaluar upgrade Angular 19
- [ ] **[A.0bis.5]** ⬜ [Finding 4.4] Reemplazar `console.log` con data sensible por `Logger`
- [ ] **[A.0bis.6]** ⬜ [Finding 2.3] Eliminar `catch (e) {}` silenciadores en cron tasks

#### Bloque 2 — Cleanup técnico (1 sem) 🧹
- [ ] **[A.0bis.7]** ⬜ [Finding 2.4] `git rm --cached` de `.js` duplicados + `.gitignore` actualizado
- [ ] **[A.0bis.8]** ⬜ [Finding 4.11] Borrar archivos `*.log` de raíz + agregar a `.gitignore`
- [ ] **[A.0bis.9]** ⬜ [Finding 4.13] Consolidar `.env.cloudinary` en `.env` único
- [x] **[A.0bis.10]** ✅ [Finding 1.2] Roles snake_case — **resuelto por construcción en nueva DB**

#### Bloque 3 — Schema fundamentos 🗄️ — ABSORBIDO POR A.0-multitenant
- [x] **[A.0bis.11]** ✅ [Finding 1.3] Audit fields a `captures` — **resuelto por construcción en nueva DB**
- [x] **[A.0bis.12]** ✅ [Finding 1.4] Audit fields a `visits` — **resuelto por construcción en nueva DB**
- [x] **[A.0bis.13]** ✅ [Finding 1.5] Índices en FKs — **resuelto por construcción en nueva DB**
- [ ] **[A.0bis.14]** ⬜ [Finding 1.6] Schemas Zod para JSONBs (sigue siendo trabajo de backend, no se resuelve solo)

#### Bloque 4 — Hardening backend (1 sem) 🔐
- [ ] **[A.0bis.15]** [Finding 4.6] Activar Helmet en `main.ts`
- [ ] **[A.0bis.16]** [Finding 4.7] Configurar `@nestjs/throttler` global + rules específicas en login/upload
- [ ] **[A.0bis.17]** [Finding 4.8] Body parser limits diferenciados (10mb global, 50mb solo en uploads)
- [ ] **[A.0bis.18]** [Finding 4.9] User non-root en Dockerfile (`USER node`)
- [ ] **[A.0bis.19]** [Finding 4.10] Headers de seguridad en `nginx.conf` (X-Frame-Options, X-Content-Type-Options, HSTS, CSP básico)

#### Bloque 5 — Refactor god services (2-3 sem) 🔨
- [ ] **[A.0bis.20]** [Finding 2.1a] Dividir `reports.service.ts` (1399 LOC) en `ReportsDataCalculator` + `MetricsAggregator` + `ScopeResolver`
- [ ] **[A.0bis.21]** [Finding 2.1b] Dividir `catalogs.service.ts` (788 LOC) en `CatalogRepository` + `PermissionsValidator`
- [ ] **[A.0bis.22]** [Finding 3.1] Dividir `reports.component.ts` (3047 LOC) — extraer tabla, gráficos, export PDF
- [ ] **[A.0bis.23]** [Finding 3.2] Dividir `daily-capture.service.ts` (806 LOC) front

#### Checkpoint A.0bis
- [ ] **[A.0bis.24]** Validar todos los críticos resueltos en staging
- [ ] **[A.0bis.25]** Audit de seguimiento (`AUDITORIA_BASE_POST_FIX.md`) — opcional
- [ ] **[A.0bis.26]** Entry de cierre en `03_LOG_REVISIONES.md`

**Total Sprint A.0bis: 5-7 semanas para 1 dev.**

> Una vez cerrado este sprint, los items A.0 originales (limpieza inmediata) están YA absorbidos. Pasar directo a Sprint A.1 (Observabilidad).

---

### Sprint A.0 — Limpieza inmediata (~3 días)
- [ ] **[A.0.1]** Borrar archivos `.js` duplicados al lado de `.ts` en `apps/api/src/**`
- [ ] **[A.0.2]** Agregar `**/*.js` al `.gitignore` de `apps/api/`
- [ ] **[A.0.3]** Documentar versión de Node, npm, Nx en `README.md`
- [ ] **[A.0.4]** Iniciar trámite de WhatsApp Business verification con BSP (360dialog/Wati)

### Sprint A.1 — Observabilidad (~1 sem)
- [ ] **[A.1.1]** Crear cuenta Sentry, capturar DSN
- [ ] **[A.1.2]** Instalar `@sentry/nestjs` + configurar en `main.ts`
- [ ] **[A.1.3]** Instalar `@sentry/angular` + configurar en `apps/view`
- [ ] **[A.1.4]** Validar que un throw deliberado aparece en Sentry
- [ ] **[A.1.5]** Reemplazar `console.log` por `Logger` de NestJS donde aún no se usa
- [ ] **[A.1.6]** Instalar `pino` + `nestjs-pino` con formato JSON estructurado
- [ ] **[A.1.7]** Logs en producción a STDOUT en JSON (Railway los captura)

### Sprint A.2 — Staging + CI (~1 sem)
- [ ] **[A.2.1]** Crear branch `staging` en GitHub
- [ ] **[A.2.2]** Crear servicio staging en Railway desde branch `staging`
- [ ] **[A.2.3]** Variables de entorno separadas para staging (DB, Cloudinary, etc.)
- [ ] **[A.2.4]** Crear `.github/workflows/ci.yml` con: lint + typecheck + test + build
- [ ] **[A.2.5]** Configurar branch protection en `main`: PRs requeridos, CI verde
- [ ] **[A.2.6]** Workflow staging → manual promote a main

### Sprint A.3 — Tests base (~1 sem)
- [ ] **[A.3.1]** Setup Jest para `apps/api` (probablemente ya configurado por Nx — validar)
- [ ] **[A.3.2]** Escribir tests para `permissions-cache.service` (cache hit/miss/invalidation)
- [ ] **[A.3.3]** Escribir tests para `roles.guard` (allow/deny por permiso)
- [ ] **[A.3.4]** Escribir tests para `scoring-v2.service` (cálculo de score)
- [ ] **[A.3.5]** Setup Cypress (e2e) para `apps/view` con 1 test smoke (login)

### Sprint A.4 — Redis + BullMQ (~1 sem)
- [ ] **[A.4.1]** Agregar servicio Redis en Railway
- [ ] **[A.4.2]** Instalar `@nestjs/bullmq` + dependencias
- [ ] **[A.4.3]** Crear `apps/api/src/shared/queue/queue.module.ts` global
- [ ] **[A.4.4]** Primera queue: `emails` con worker (aunque no envíe nada aún, validar flow)
- [ ] **[A.4.5]** Health check de conexión Redis al boot del API

### Sprint A.5 — Tipos compartidos (~3 días)
- [ ] **[A.5.1]** Crear `libs/shared-domain-types` con `nx g @nx/js:library`
- [ ] **[A.5.2]** Mover interfaces compartidas (User, Permission, Visit, etc.) a la lib
- [ ] **[A.5.3]** Actualizar imports en `apps/api` y `apps/view` para usar la lib
- [ ] **[A.5.4]** Validar que el build sigue verde tras la refactorización

### Sprint A.6 — Multi-tenancy decisión (~3 días)
- [ ] **[A.6.1]** Decisión documentada en ADR-001: ¿multi-tenant o single-tenant?
- [ ] **[A.6.2]** Si multi-tenant: planear migración de tablas (no ejecutar todavía)

### Sprint A.7 — Cleanup y verificación final (~3 días)
- [ ] **[A.7.1]** Smoke test completo de la app en staging
- [ ] **[A.7.2]** Comprobar que Sentry reporta errores reales
- [ ] **[A.7.3]** Comprobar que CI bloquea PR con tests rotos
- [ ] **[A.7.4]** Documentar setup completo en `README.md`
- [ ] **[A.7.5]** Checkpoint Fase A → cerrar en `03_LOG_REVISIONES.md`

**Total Sprint A: ~5-7 semanas para 1 dev.**

---

## 📋 BACKLOG — Fase B: Integración Kepler

> Detalles en `FASES/FASE_B_INTEGRACION_KEPLER.md`. Tareas resumidas aquí.

### Sprint B.0 — Discovery (~1 sem)
- [ ] **[B.0.1]** Obtener acceso read-only al SQL Server de Kepler
- [ ] **[B.0.2]** Identificar versión de Kepler (afecta qué tablas/vistas/SPs existen)
- [ ] **[B.0.3]** Documentar tablas/vistas relevantes para: productos, precios, stock, clientes
- [ ] **[B.0.4]** Identificar si Kepler tiene API REST o solo DB

### Sprint B.1 — Adapter de lectura (~2 sem)
- [ ] **[B.1.1]** Instalar driver `mssql` en `apps/api`
- [ ] **[B.1.2]** Crear módulo `kepler-sync` con conexión configurable
- [ ] **[B.1.3]** Implementar `KeplerProductsService.fetchAll()` (lee del SQL Server)
- [ ] **[B.1.4]** Implementar `KeplerPricesService.fetchByCustomer()`
- [ ] **[B.1.5]** Implementar `KeplerStockService.fetchByWarehouse()`
- [ ] **[B.1.6]** Implementar `KeplerCustomersService.fetchAll()` (extiende stores)

### Sprint B.2 — Storage local + sync job (~2 sem)
- [ ] **[B.2.1]** Schema `commercial.*` en Postgres con tablas espejo
- [ ] **[B.2.2]** Migración de las nuevas tablas
- [ ] **[B.2.3]** Job de sync nocturno con BullMQ (cron: 03:00 AM)
- [ ] **[B.2.4]** Endpoint admin: `POST /admin/kepler/resync` para trigger manual
- [ ] **[B.2.5]** Logs de cada sync run con: registros leídos / actualizados / errores

### Sprint B.3 — Checkpoint Fase B (~3 días)
- [ ] **[B.3.1]** Validar que el catálogo de productos en Postgres refleja Kepler
- [ ] **[B.3.2]** Validar que precios se actualizan correctamente
- [ ] **[B.3.3]** Cerrar checkpoint en `03_LOG_REVISIONES.md`

**Total Sprint B: ~4-6 semanas.**

---

## 📋 BACKLOG — Fase C: Sales Intelligence ampliado

> Detalles en `FASES/FASE_C_SALES_INTELLIGENCE.md`.

### Sprint C.0 — Modelo exhibition_products (~2 sem)
- [ ] **[C.0.1]** Migración: tabla `exhibition_products`
- [ ] **[C.0.2]** Endpoint backend: agregar productos a una exhibición
- [ ] **[C.0.3]** UI de captura: el capturista marca SKUs por exhibición
- [ ] **[C.0.4]** Tests del flujo

### Sprint C.1 — Capa analítica (~2 sem)
- [ ] **[C.1.1]** Schema `analytics.*` en Postgres
- [ ] **[C.1.2]** Tabla `daily_mix_depth_by_store`
- [ ] **[C.1.3]** Tabla `weekly_top_underperformers`
- [ ] **[C.1.4]** Job (BullMQ) que refresca tablas analíticas al recibir `capture:created`

### Sprint C.2 — Endpoints Command Center (~1 sem)
- [ ] **[C.2.1]** `GET /command-center/mix-depth`
- [ ] **[C.2.2]** `GET /command-center/underperformers`
- [ ] **[C.2.3]** `GET /command-center/heatmap` (zonas con score actual)

### Sprint C.3 — Frontend Command Center (~3 sem)
- [ ] **[C.3.1]** Módulo `apps/view/.../command-center/`
- [ ] **[C.3.2]** Mapa con Leaflet heat-mapped
- [ ] **[C.3.3]** Grid "visitas en curso"
- [ ] **[C.3.4]** Drill-down zona → ruta → tienda → última visita

### Sprint C.4 — Alertas (~1 sem)
- [ ] **[C.4.1]** Configurador de thresholds en UI admin
- [ ] **[C.4.2]** Job que evalúa thresholds y emite evento WS al supervisor
- [ ] **[C.4.3]** Componente Angular de notificaciones in-app

### Sprint C.5 — Checkpoint Fase C
- [ ] **[C.5.1]** Validar que el supervisor de prueba usa diariamente el Command Center
- [ ] **[C.5.2]** Cerrar checkpoint

**Total Sprint C: ~6-8 semanas.**

---

## 📋 BACKLOG — Fase D: Catálogo + Pedidos + Portal B2B

> Detalle en `FASES/FASE_D_CATALOGO_PORTAL_B2B.md`.

### Sprint D.0 — Dominio comercial (4 sem)
- [ ] **[D.0.1]** Tablas: `products_commercial`, `price_lists`, `customers_b2b`
- [ ] **[D.0.2]** Sync desde Kepler (extiende Fase B)
- [ ] **[D.0.3]** Endpoints CRUD admin
- [ ] **[D.0.4]** Rol nuevo `cliente_b2b` en role_permissions

### Sprint D.1 — Carrito + pedidos (4 sem)
- [ ] **[D.1.1]** Tablas: `carts`, `cart_items`, `orders`, `order_items`, `order_status_history`
- [ ] **[D.1.2]** Endpoints: agregar al carrito, checkout, ver estado
- [ ] **[D.1.3]** Lógica de reserva de stock (transacción)
- [ ] **[D.1.4]** Resolución de conflictos en sync offline

### Sprint D.2 — App de vendedor (modo pedido) (4 sem)
- [ ] **[D.2.1]** Decisión: extender Ionic actual o crear `apps/mobile-sales` con RN
- [ ] **[D.2.2]** Módulo "Toma de pedido" en app mobile
- [ ] **[D.2.3]** Carrito offline con Dexie
- [ ] **[D.2.4]** Catálogo navegable + búsqueda

### Sprint D.3 — Portal web B2B (4 sem)
- [ ] **[D.3.1]** Crear `apps/b2b-portal` con `nx g @nx/angular:app`
- [ ] **[D.3.2]** Login del dueño de tienda
- [ ] **[D.3.3]** Catálogo + carrito + checkout
- [ ] **[D.3.4]** Historial de pedidos + estado de cuenta

### Sprint D.4 — Canasta estratégica v1 (2 sem)
- [ ] **[D.4.1]** Tabla `recommended_basket` por tienda (nightly job)
- [ ] **[D.4.2]** Categorización: focus / exploración / innovación / base
- [ ] **[D.4.3]** Endpoint `GET /sales/recommendations/:store_id`
- [ ] **[D.4.4]** UI integración en app vendedor

### Sprint D.5 — Checkpoint Fase D
- [ ] **[D.5.1]** Cerrar checkpoint

**Total Sprint D: ~16-20 semanas.**

---

## 📋 BACKLOG — Fases E, F, G, H, I

_(Items detallados se agregan al iniciar cada fase. Plan macro está en cada `FASES/FASE_X_*.md`)_

---

## 📝 Convenciones

- **Códigos** `[A.0.1]` = Fase A, Sprint 0, Item 1.
- **Commits** referencian el código: `feat([A.1.2]): integrate Sentry SDK in NestJS`.
- **Cerrar item**: marcar checkbox + agregar fecha de cierre en comentario.
- **Bloqueado**: agregar `🚫 BLOQUEADO: <razón>` en el item.
- **Si descubrís un item nuevo durante una fase**: agregarlo al sprint con el siguiente número correlativo.
