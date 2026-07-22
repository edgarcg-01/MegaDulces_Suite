# Contexto del proyecto Trade Marketing (auto-cargado por Claude Code)

> Este archivo se lee en cada sesión nueva. Mantenerlo **breve, actualizado, accionable**. Si necesitás detalles, los `.md` están en `docs/IMPLEMENTACION/`.

---

## Modo de trabajo

**Single dev (Edgar)**. **TODO el trabajo se ejecuta desde este chat con Claude** — no hay onboarding para humanos, no hay equipo. Los `.md` son la memoria del proyecto entre sesiones; mantenerlos actualizados es **mandatorio** al cerrar cualquier item.

---

## Qué es el proyecto

App de **trade marketing y auditoría de ejecución en PdV** para **Mega Dulces** (distribuidora de dulces en MX), en evolución hacia **plataforma B2B integral multi-tenant** estilo yom.ai.

**Stack actual (a migrar):**
- NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary
- Angular 18 standalone + PrimeNG + Tailwind + Spartan UI
- Capacitor + Dexie (mobile offline embebido en `apps/view`)
- Nx monorepo + Docker + Railway
- ERP de Mega Dulces: **no existe todavía** — el core comercial se construye desde cero en schema `commercial.*`. Si en el futuro aparece Kepler u otro ERP externo, se integra via FDW o sync hacia estas tablas (ver pivot 2026-05-26 en Fase B).

**Estado funcional hoy:** auditoría de visitas + scoring + reports realtime. **NO toma pedidos**, NO tiene catálogo comercial, NO es multi-tenant.

---

## DECISIÓN CLAVE EN CURSO (2026-05-26)

**ADR-010**: vamos a crear una **DB Postgres nueva multi-tenant desde el origen**.
- Mega Dulces = primer tenant (`slug = 'mega_dulces'`).
- Shared DB + `tenant_id` en todas las tablas + RLS de Postgres como defense-in-depth.
- DB legacy queda en paralelo hasta cutover.
- Aplicar correcciones del audit (60 issues) directamente sobre schema limpio nuevo.

**Sprint actual:** `A.0-multitenant` (3-4 semanas). Plan detallado en [`docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md`](docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md).

**Sub-sprint A.0mt.1 ✅ COMPLETADO 2026-05-26**: nueva DB local + tabla `tenants` + función `current_tenant_id()` + helper TS `TenantKnexService` + tests 8/8.

**Sub-sprint A.0mt.2 ✅ COMPLETADO 2026-05-26**: schema completo 19 tablas + 95 índices + 18 RLS + rol `app_runtime` + seeds + tests RLS 16/16.

**Sub-sprint A.0mt.3 ✅ COMPLETADO 2026-05-26**: TenantContextService (AsyncLocalStorage) + Interceptor + auth-mt + tenants-admin + tests auth multi-tenant 12/12.

**Sub-sprint A.0mt.4 ✅ COMPLETADO 2026-05-26**: 1804/1830 rows migrados (98.6%) legacy → nueva DB. Match perfecto en data core. 26 skips por FK huérfanas en legacy.

**Sub-sprint A.0mt.5 ✅ parte LOCAL 2026-05-26**: runbook cutover + `ENABLE_MULTITENANT=true` toggle en AppModule + smoke test API local OK. Items operacionales Railway (5.3-7) pausados hasta cutover real.

**Sprint A.0bis ✅ COMPLETADO 2026-05-26**: cleanup (70 .js basura + .log + .env duplicate), backend hardening (Helmet + Throttler 3-tier + body limits 2mb), nginx security headers, console→Logger, catches silenciosos arreglados, Zod schemas para JSONBs. CORS/JWT/credenciales BLOCKED por usuario. User non-root nginx + refactor god services DEFERRED.

**Pivot 2026-05-26 (Fase B):** Kepler ERP **no existe** — construimos el core comercial desde cero sobre schema `commercial.*` en `postgres_platform`. Cuando aparezca un ERP externo se integra via FDW o sync hacia estas mismas tablas.

**Sub-sprint B.0 ✅ COMPLETADO 2026-05-26**: schema comercial inicial (9 tablas en `commercial.*`): customers, warehouses, price_lists, product_prices, stock, stock_movements, orders, order_lines, payments. Todas con composite FK `(tenant_id, id)` + RLS forzado + grants `app_runtime`. Pago **cash-only en beta** (CHECK constraint en `orders.payment_method` y `payments.payment_method`). Seed baseline Mega Dulces (warehouse MD-CENTRAL + price_list BASE-MXN + customer DEMO-001). Smoke test RLS OK (0/1/0 sin/con/fake tenant).

**Sub-sprint B.1 ✅ COMPLETADO 2026-05-26**: 4 módulos NestJS — `commercial-customers` (CRUD + RFC validation + search), `commercial-warehouses` (CRUD + default flag exclusivo), `commercial-pricing` (price_lists + bulk upsert prices + endpoint lookup precio por cliente con fallback), `commercial-inventory` (stock read + state-machine de movements con lock pesimista + ajuste absoluto). Permission enum +14 permisos comerciales. Seed roles actualizado. `TenantKnexService` provider exportado. Wireados en AppModule via toggle `ENABLE_MULTITENANT`. Build OK + smoke test end-to-end OK (INSERT/UPDATE/upsert/movement/soft-delete).

**Sub-sprint B.2 ✅ COMPLETADO 2026-05-26**: `CommercialOrdersService` con state machine `draft → confirmed → fulfilled` / `*→cancelled`. Reserva/consumo de stock atómico inline (mismo trx del confirm/fulfill, `FOR UPDATE` anti-race). Generador `PD-YYYY-NNNNN` via `commercial.order_sequences` con UPSERT atómico Postgres. Snapshot de precio en líneas. Recálculo de totales automático. Endpoints REST completos. PaymentsService deferred post-beta (tabla `payments` queda lista en DB). Smoke E2E OK: PD-2026-00001 con `reserve:10 → sale:10`, stock 200→190.

**Sub-sprint B.3 ✅ COMPLETADO 2026-05-26**: CLI importer + carga inicial con **test data** realista (dulcería). B.3.1 = CLI con 6 types idempotente. B.3.2 = 5 brands + 25 products + 25 prices + 20 customers + 25 stock cargados via importer en `database/importers/testdata/`. Smoke E2E final: PD-2026-00002 con 4 líneas, total $3,971.84, stock decrementado exacto. Data real de Mega Dulces reemplaza testdata cuando llegue (re-run idempotente).

**Verificación HTTP E2E ✅ COMPLETADA 2026-05-26**: 18/18 endpoints commercial vía HTTP (login + customers CRUD + warehouses + pricing + inventory + order flow draft→confirm→fulfill). 13/13 tenant isolation: 2do tenant creado, login, **NO ve nada** del 1ro (customers/warehouses/prices/stock/orders todos 0). Gaps encontrados y resueltos: (1) circular import `KNEX_NEW_DB` (fix: string token directo), (2) `TenantContextInterceptor` no wireado globalmente (fix: decode JWT inline + `APP_INTERCEPTOR` condicional al toggle), (3) JWT secret mismatch entre `auth-mt` y `TenantModule` por orden de carga de dotenv vs decoradores (fix: defaults unificados; arrancar con `JWT_SECRET=...` env hasta fix de boot order). Tests en `database/http-e2e-test.js` y `database/http-tenant-isolation-test.js`.

**Fase B = 🟢 CERRADA (beta scope) + VERIFICADA END-TO-END**. PaymentsService es lo único deferred post-beta.

**Sub-sprint C.0 ✅ COMPLETADO 2026-05-26** (Fase C arrancó): Módulo `commercial-analytics` con 7 endpoints sobre `commercial.*`: overview (revenue/orders/AOV/units/unique customers), top-customers, top-products, inactive-customers, sales-by-brand (con share%), low-stock, daily-series (TZ MX). Solo cuenta `status='fulfilled'` para revenue real. Pivot vs plan original: skip `exhibition_products` normalization hasta que haya volumen de capturas; arrancar Fase C con valor inmediato sobre data comercial. HTTP smoke 23/23: revenue $4,244 / Top Dulces Típicos 39% / 5 low-stock detectados.

**Sub-sprint C.1 ✅ COMPLETADO 2026-05-26**: schema `analytics.*` + 3 materialized views (`mv_sales_overview_30d`, `mv_top_customers_30d` con `rank`, `mv_top_products_30d` con `rank_by_units`+`rank_by_revenue`) + UNIQUE indexes para REFRESH CONCURRENTLY. `AnalyticsRefreshService` con `@Cron('*/15 min')` + endpoint `POST /commercial/analytics/refresh` manual. Provider `KNEX_NEW_DB_ADMIN` (postgres user, pool 0-2) para REFRESH owner-only. Service refactor: 3 endpoints leen de MVs por default; `?live=true` o `?from=/?to=` fuerza on-the-fly. Tenant filter explícito (RLS no soportado en MVs por Postgres). HTTP smoke 21/21: MV vs live coinciden, refresh 85ms total, tenant 2 nuevo no ve nada.

**Sub-sprint C.3 (MVP) ✅ COMPLETADO 2026-05-26**: Frontend Command Center en `apps/view/src/app/modules/dashboard/command-center/`. `CommandCenterService` consume 7 endpoints analytics. Component standalone con 4 KPI cards (revenue/orders/pipeline/customers), Top customers table, Top products table, Sales by brand (progress bars), Low stock alerts, Inactive customers. Botón Refresh MVs. Ruta `/dashboard/command-center` con `permissionGuard(COMMERCIAL_ORDERS_VER)` + nav item con icono compass. Permission enum frontend sync con backend (+14 commercial). `nx build view` OK. **Deferred**: mapa Leaflet, drill-down zona→tienda (requieren data adicional). **Verificación visual pendiente** (no automatizable desde CLI).

**Sub-sprint C.4 ✅ COMPLETADO 2026-05-26**: Alertas WS realtime. Backend: `AlertsGateway` (namespace `/alerts`, JWT en handshake, tenant rooms automáticos, auth_error + disconnect en token inválido), `AlertsService` con 6 builders tipados (`emitLargeOrder`, `emitOrderConfirmed`, `emitOrderFulfilled`, `emitLowStock`, `emitVipInactive`, `emitTest`), `AlertsScannerService` con `@Cron('*/5')` para low_stock_critical + vip_inactive con cooldown 1h anti-spam, `AlertsController` con `/test`, `/scan-now`, `/stats`. Hooks: `OrdersService.confirm/fulfill` emiten alerts. Frontend: `AlertsSocketService` con socket.io-client + JWT, Command Center muestra tag realtime + toast + feed visual de últimas 20 alerts. Smoke E2E 18/18: aislamiento entre tenants verificado en WS, hooks de orders funcionan, scanner manual emite 6 alerts low_stock, JWT inválido rechazado.

**Sprint C.5 ✅ COMPLETADO 2026-05-26 — Fase C CERRADA (beta scope)**: regression suite `database/run-all-tests.js` ejecutada **10/10 suites verde** en ~9.3s (~100 sub-assertions). Fixes idempotencia: customer code timestamp-based, MV pre-refresh, stock replenish en alerts test. Documentación de cierre en `03_LOG_REVISIONES.md` con arquitectura, decisiones técnicas y pendientes operacionales.

**Fase C = 🟢 CERRADA (beta scope)**. Deferred (post-beta): exhibition_products normalization, mapa Leaflet, drill-down zona→tienda.

**Sub-sprint D.0 ✅ ABSORBIDO 2026-05-26**: todas las tablas planeadas ya existen en `commercial.*` desde Fase B. Sync Kepler N/A. CRUD admin ya operativo.

**Sub-sprint D.1 ✅ COMPLETADO 2026-05-26**: Portal B2B base. Migración 100007: `public.users.customer_id` UUID NULL + composite FK a `commercial.customers` (partial index) + `commercial.order_status_history` con RLS forzado + CHECK constraints. Rol `customer_b2b` con permisos scoped (sin trade marketing ni admin). Seed `cliente_demo`/`cliente_demo` linkeado a customer `TST-PORTAL-001`. `OrdersService.recordHistory()` privado escribe audit en createDraft/confirm/fulfill/cancel con snapshot de totals. Endpoints `GET /commercial/orders/my` (auto-scoped por customer_id del JWT) y `GET /commercial/orders/:id/history`. HTTP smoke 20/20 OK: role customer_b2b en JWT, /my devuelve 0 inicial luego 1, /history con 3 transitions exactas (null→draft / draft→confirmed / confirmed→fulfilled), snapshot completo de changed_by_username.

**Sub-sprint D.3 MVP ✅ COMPLETADO 2026-05-26**: Portal Web B2B en `apps/view/.../portal/` (no app separada — MVP usa rutas `/portal/*` en la app existente). 5 componentes standalone lazy-loaded: PortalLogin (auth-mt + valida customer_b2b), PortalShell (header propio sin sidebar), PortalCatalog (productos con SU precio + cantidad mínima + add to cart), PortalCart (líneas editables + totales + confirm con dialog), PortalOrders (lista status+totales) y PortalOrderDetail (grid líneas + timeline historial). `AuthService.loginMt()` nuevo método. `customerB2bGuard` enforce rol. `nx build view` OK. **Verificación visual manual pendiente** (no automatizable).

**Sub-sprint D.4 ✅ COMPLETADO 2026-05-26**: canasta estratégica v1. Migración `commercial.recommended_baskets` (UPSERT por customer, items JSONB + category_counts + computed_at, RLS forzado). `RecommendationsService` con 4 categorías heurísticas: **base** (top 5 productos del customer 90d), **focus** (top 5 del tenant 30d que customer no compra), **exploration** (5 SKUs de sus brands), **innovation** (3 productos nuevos 30d). Cada item con score 0..1 + reason + sample_price. 4 endpoints: `/my`, `/:customer_id`, `/:customer_id/compute`, `/refresh-all`. `@Cron('0 0 9 * * *')` nightly refresh (9 UTC = 3 AM MX) con scope CLS sintético. Frontend: nueva página `/portal/recommendations` con 4 secciones visuales (icons + tag severity + grid de cards con score%). Nav item "Sugeridos". Smoke 21/21: 12 items generados para TST-PORTAL-001 (1+5+3+3), refresh-all 28 customers en 776ms.

**Sub-sprint D.2 MVP ✅ COMPLETADO 2026-05-26**: app vendedor mobile-first. **ADR-005 aceptado**: extender `apps/view` con `/vendor/*` (no app RN separada — razonamiento: 1 dev, infra Capacitor+Dexie ya configurada, reuso de PortalService/AuthService/guards). Nuevo módulo con `VendorService` (wrapper completo: listCustomers con search + catalogForCustomer + draft management + myOrdersToday), `VendorShellComponent` (header sticky + bottom nav nativo-style con Clientes/Mi día), 3 pages standalone: customers list (search debounced 250ms), take-order (flujo combinado catálogo + carrito sticky + confirm con dialog), today (3 KPI cards + lista de pedidos del día). `vendorGuard` rechaza customer_b2b. Nav item "Modo Vendedor" en admin layout (pi-briefcase, gateado por COMMERCIAL_ORDERS_CREAR). Lazy-loaded. **Offline real (Dexie sync queue) deferred** — esta sesión solo flujo online. Build view OK.

**Sprint D.5 ✅ COMPLETADO 2026-05-26 — Fase D CERRADA (beta scope)**: regression suite extendida `database/run-all-tests.js` ahora con **12 suites** ejecutadas en ~10.6s (~155 sub-assertions). Fixes idempotencia: D.1 portal test ahora tolera state previo (baseline + delta assert), B.3.2 requirió re-import testdata (legacy migration había uppercased brand names). Arquitectura completa documentada en `03_LOG_REVISIONES.md`.

**Fase D = 🟢 CERRADA (beta scope)**. Deferred post-beta:
- D.2.3 — offline sync queue Dexie real para pedidos sin conexión.
- D.3.1 — app Angular separada `apps/b2b-portal` (refactor desde `apps/view/.../portal/`).
- Validación visual manual del portal + vendor en browser/DevTools mobile.

**Estado global del MVP:** Fases **A + B + C + D 🟢 cerradas (beta scope)**.

**K-debt ✅ CERRADO 2026-05-27**: refactor de `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts` para eliminar WRITES a la columna virtual `activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED` (los `insert/update({ activo: ... })` tiraban error en runtime — bug silencioso no detectado por smoke porque no se ejercían los CRUD admin de catálogos). Ahora soft-deletes usan `deleted_at: NOW()` y reactivaciones usan `deleted_at: NULL`. Las 3 columnas "shim" (`activo` GENERATED, `daily_captures.captured_by_username`, `zones.is_system`) reclasificadas como **canónicas, no debt**: helper de lectura, snapshot denormalizado para audit, y flag system-zone respectivamente. Comments en las migraciones actualizados. Build OK + regression 19/19 verde. Detalle en [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md).

**Próximo:** la app está lista para arranque comercial beta con Mega Dulces. Próximas fases del roadmap son nice-to-have:
- **Fase E** — Remote Manager (televenta)
- **Fase F** — WhatsApp Bot conversacional
- **Fase G** — Growth (campañas/promos)
- **Fase H** — Fintech (wallet)
- **Fase I** — ML credit risk + WS scaling

O alternativamente: cutover a Railway (operacional, A.0mt.5.3-7), JwtAuthGuard formal, refactor god services, o trabajos diferidos acumulados.

---

## Reglas críticas (preferencias del usuario)

### ⛔ NO hacer sin autorización explícita
- **No borrar tablas** en la DB de prod.
- **No borrar columnas** sin pedir confirmación.
- **No hacer push** ni crear PRs sin pedir.
- **No tocar CORS ni credenciales** todavía (diferido por decisión del usuario 2026-05-26 — items `[A.0bis.1-3]` BLOCKED).
- **No borrar archivos de migración aplicados** (Knex valida `knex_migrations` vs filesystem → "directory corrupt" → crash loop. Vivido en este proyecto.).

### ✅ SÍ hacer por default
- Commits locales cuando se completa un item del tracker. Convención: `feat([A.0mt.1.1]): descripción`.
- **Actualizar `01_TRACKER_PROGRESO.md` y `03_LOG_REVISIONES.md` al cerrar items**. Cambiar símbolo: ⬜ → 🔨 → 🧪 → 🚀 → ✅.
- Crear ADRs en `02_DECISIONES_ARQUITECTURA.md` cuando se toma una decisión técnica relevante.
- Migraciones nuevas: **idempotentes** (con `hasColumn` antes de `addColumn`).
- Usar `Logger` de NestJS (no `console.log`) en código nuevo.
- Tablas nuevas: **siempre con `tenant_id` UUID NOT NULL + audit fields completos**.

### Convenciones técnicas
- Naming snake_case en DB y `role_name`.
- **URLs, query params, DTO fields y columnas DB nuevas: English snake_case.** Spanish solo para domain terms sin traducción limpia (`exhibicion`, `folio`). Legacy ES queda como alias hasta que se complete la migración. Ejemplos canónicos: `zone_id`, `route_id`, `date_from`, `date_to`, `user_id`. Migración inicial 2026-06-01: `/visitas/*` → `/visits-sync/*`, `/stores?zona_id` → `?zone_id`, `/daily-captures?fecha` → `?date`.
- TZ del backend: `America/Mexico_City` (helpers en `apps/api/src/shared/date/mx-date.ts`).
- Schemas Postgres: `commercial.*` (Fase B+), `analytics.*` (Fase C+).
- Para diffs de role_permissions JSONB: usar `permissions -> 'KEY' IS NULL` NO el operador `?` de JSONB (knex no lo escapa correctamente).

---

## Sistema de tracking (mantener vivo)

| Archivo | Cuándo actualizar |
|---|---|
| [`01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | **CADA vez** que un item cambia estado (⬜→🔨→🧪→🚀→✅) |
| [`02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | Al tomar decisión técnica relevante (crear ADR) |
| [`03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Al cerrar un sprint o checkpoint |
| [`AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | Si aparece finding nuevo no listado |
| [`/CHANGELOG.md`](CHANGELOG.md) | Al cerrar feature/sprint relevante. Vista "qué cambió las últimas N semanas" sin abrir git log. Una entry por fecha + categorías Added/Changed/Fixed/Internal. |

**Estados granulares por item:**
- ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED

---

## Roadmap rápido

| Fase | Tema | Estado |
|---|---|---|
| A.-1 | Auditoría base | ✅ Hecho (2026-05-26) |
| **A.0-multitenant** | **Nueva DB multi-tenant** | **🔥 En curso** |
| A.0bis | Plan correctivo audit (post-multitenant) | ⏸️ Espera A.0mt |
| A.1-A.7 | Fundaciones (Sentry, Pino, Redis, CI, etc.) | ⏸️ Espera A.0mt |
| B | Core Comercial (built from scratch, no ERP externo) | 🟢 CERRADA (beta) — B.0+B.1+B.2+B.3 ✅ |
| C | Sales Intelligence ampliado | 🟢 CERRADA (beta) — C.0+C.1+C.3+C.4+C.5 ✅ |
| D | Catálogo + Portal B2B + Pedidos | 🟢 CERRADA (beta) — D.0+D.1+D.2+D.3+D.4+D.5 ✅ |
| **E** | **Remote Manager (televenta)** | **🟢 CERRADA (beta) — E.0+E.1+E.2 ✅ 2026-05-27. MVP delgado (sin Twilio, pool autoservicio, cartera scoped). Schema (lead_reservations UNIQUE PARTIAL + call_logs 6 outcomes), rol `tele_operator`, backend 7 endpoints + smoke HTTP 29/29 + cron @5min libera expired. Frontend `/televenta/*` con 4 páginas standalone (queue priorizada + lead snapshot + modal log call + take-order que reusa VendorService). Lesson: `TenantKnexService.run()` obligatorio para queries con RLS forzado. Validación visual pendiente. Deferred: E.4 dashboard métricas, E.5 telefonía Twilio, E.6 asignación inteligente, E.7 handoff WhatsApp, E.8 recordatorios callback.** |
| F | WhatsApp Bot conversacional | ⏸️ |
| G | Growth (campañas + promociones) | ⏸️ |
| H | Fintech (wallet) | ⏸️ |
| I | ML credit risk + WS scaling | ⏸️ |
| **J** | **Logística (embarques, flotilla, costos)** | **🟢 CERRADA (beta) — J.0+J.1+J.2+J.4+J.5+J.6+J.7+J.8+J.9.1-4 ✅ (2026-05-27). J.8 = migración schema + backend (checklists, photos, reports, importer 96 destinos reales). J.9 = port de UI completa del repo `_imported/logistica/`: 4 páginas nuevas (Dashboard ops con shimmer, Personal/Staff con avatares+MultiSelect roles, Guides global con 5 KPIs+filtros, Costs con KPIs+edit dialog 10 categorías). Nav extendido a 9 items. Ver [`FASE_J9_UI_REPO_PORT.md`](docs/IMPLEMENTACION/FASES/FASE_J9_UI_REPO_PORT.md). Deferred J.9.5-11: Reports avanzado, DeliveryWizard, Driver Assignments, Config tabs, Fleet check-in/out, Shipment form rico, Theme CSS vars.** |
| **K** | **AI product match en captures (pgvector + Voyage + Haiku)** | **🟢 CERRADA (beta) — K.0+K.1+K.2+K.3+K-sync ✅ 2026-05-27. Endpoint `POST /api/ai/products/match-ai`, threshold 0.40, throttle 10/min tier `long`. Docker `pgvector-md` (pg18+vector 0.8.2 en localhost:5433) + 1278 products embedded. **Integridad eventually-consistent**: trigger SQL marca stale al cambiar nombre/brand_id; hook updateBrand marca stale products del brand; `EmbeddingSyncService` @Cron cada 15min + endpoint `POST /api/ai/products/sync-now`; script `database/scripts/sync-from-remote.js` para sincronía Docker ← .245. UX wizard refactor minimalista (a11y WCAG AA, touch targets, focus visible, motion-safe). **2 migraciones compatibility shim** + **trigger staleness** pendientes de aplicar a `.245`. Deferred: K.4 bulk import, K.5 portal/vendedor, K.6 telemetry, K.7 AI vision.** |
| **Horus** | **Supervisor AI de ejecución (Trade)** | **🔨 DISEÑADO (planeación) 2026-06-16 — ADR-020. Supervisor de ventas aumentado por AI para auditoría de ruta. Motor decide / agente comunica / **co-piloto** (acción → `pending_approval` → humano aprueba). Hermano de Thot pero SEPARADO (vive en `libs/trade`, no toca `commercial-intelligence`). 3 capacidades: parte diario, auditoría visual de fotos (Claude vision), detección de fraude. Feature store `trade.execution_360`. Reusa infra AI Fase K. Plan + schema + 8 sprints en [`FASE_HORUS`](docs/IMPLEMENTACION/FASES/FASE_HORUS_SUPERVISOR_AI.md). **Horus.0–H2.x + Horus.L + Horus 360 en PROD (detalle en tracker).** **Fase Horus-IQ ✅ COMPLETA (HIQ.0–HIQ.6) 2026-07-15** (subir la inteligencia percibida: "Pregúntale a Horus" chat ReAct 13 tools + briefing con memoria + backfill L1 604/726 sujetos + umbrales por percentiles + prioridad por valor/anti-fatiga + nudge WS al campo + cross-foto pHash/shelf_declining + visibilidad de errores en tablero; HIQ.0–4 verificados en runtime, HIQ.5/3b/6 builds+validación puntual; migs 120000/130000/140000 en Railway, 150000/160000 pendientes; plan [`FASE_HORUS_IQ`](docs/IMPLEMENTACION/FASES/FASE_HORUS_IQ.md)). **Fase HV (visión a producto) 🔨 HV.0 gate NO pasó SKU (recall marca 24%/SKU 29% — declaración ~37 vs ~8 visibles/foto, dulcería a granel); recortada a marca: HV.1 extrae `products_seen[]` crudo + regla `over_declaration` + encuadre guiado en captura; matching/bandeja diferidos; plan [`FASE_HV`](docs/IMPLEMENTACION/FASES/FASE_HV_VISION_PRODUCTOS.md)).** |
| **LM** | **Última Milla (entrega a domicilio local en moto)** | **🔨 DISEÑADO (planeación) 2026-07-02 — ADR-027. Digitaliza el SOP de entrega a domicilio. Tesis: orquestación, NO módulo nuevo — pedido = `commercial.orders (delivery_type='home_delivery')`, entrega = `logistics.delivery_guides`+`guide_recipients` (ya trae POD/GPS-vivo/ETA/checklists/fotos/costos/ROI), moto = `logistics.vehicles`. 4 gaps: (1) **PaymentsService** multi-método sobre `commercial.payments` (hoy vacía/cash-only) + `deliverAndCollect` — cierra la deuda "payments deferred" de Fase B; (2) intake a domicilio (cliente casual + `delivery_address`); (3) incidencias tipificadas (patrón `call_logs`); (4) moto + overflow CEDIS. Más: arqueo por denominación + firma de cliente obligatoria. Rol `repartidor`, frontend reusa `apps/vendor`. 10 sprints (LM.0–LM.9), ruta crítica LM.0→LM.1. Plan en [`FASE_LM`](docs/IMPLEMENTACION/FASES/FASE_LM_ULTIMA_MILLA.md). Sin código aún. Decisiones abiertas: quitar cash-only global + sucursal=`store_id`.** |
| **VR** | **Venta en Ruta (autoventa offline-first, lap/móvil)** | **🔨 DISEÑADO (planeación) 2026-07-13 — ADR-032 propuesto: el device es la fuente de verdad de la venta en ruta; el server acepta+concilia (idempotente por `client_uuid`, respeta precio cobrado, divergencias → `libs/reconciliation`), nunca rechaza. Endpoint atómico `POST /commercial/orders/route-sale` (1 trx: orden fulfilled + consume stock camión + payment), folio local por device, transfer CEDIS↔camión, liquidación arqueo ciego (reusa `rider_liquidations`) + cuadre carga−ventas=retorno. 9 sprints VR.0–VR.8. Camino para retirar Kepler local de ~35 camionetas. Plan en [`FASE_VR`](docs/IMPLEMENTACION/FASES/FASE_VR_VENTA_EN_RUTA.md). Sin código. Decisiones abiertas: ADR-032 + CHECK stock negativo truck + JWT 7d + folio local.** |
| **Maat** | **AI de Finanzas (conocimiento + chat + patrones)** | **🔨 EN CURSO — MAAT.0 + MAAT.3 ✅ 2026-07-06 · MAAT.1 ✅ 2026-07-07 (ADR-028 aceptado). NO fine-tuning: conocimiento curado + chat tool-use (cero números del LLM) + motor determinista + aprendizaje Horus-L. MAAT.0 = `libs/finance` + schema `finance.*` 7 tablas RLS (Batch 139) + perms + 27 entries conocimiento. MAAT.3 = chat "Pregúntale a Maat" `/finanzas/maat` (réplica /thot-chat; 10 tools; Haiku/Sonnet-think/deep/vision; audit + 👍/👎). MAAT.1 = balanza completa `analytics.ledger_monthly` (fam 1-9, 19 meses, cuadra vs análisis contable y reproduce sola el bug PD −$972k) + cadena `analytics.expense_doc_chain` (lineage c39; 9,800 cadenas; BOTANAS exact) + importer `import-ledger-chain.js` (regla: cada DB solo aporta SU sucursal — DB03 traía réplicas 100% de la 02) + `expenseDocument.chain` (timeline del drill despierta) + tools maat_balanza/maat_pnl/maat_cadena + fix tenant_id explícito en analytics.*. Smoke 19/19. **MAAT.3.1 ✅ 2026-07-07** = navegable (`maat_buscar_documentos` sin folio + `ui_url` deep-links SPA + botón Ver póliza + el detalle abre diálogo por `?doc_*`) + proactiva (`GET /briefing` empty-state + tool `maat_alertas` detector-lite + follow-up chips `[[SEGUIR]]`) + visual (gráficas Chart.js + export CSV) + confiable (few-shot + catálogo sucursales); smoke 27/27, en vivo detectó 631 facturas $52.2M sin recepción sin pedírselo. **MAAT.2 ✅ 2026-07-07** = motor de patrones: `MaatDetectorService` 10 detectores en 3 clases (riesgo/error_captura/oportunidad) → `finance.findings` UPSERT idempotente + `MaatScannerService` @Cron 3AM MX + `MaatFindingsService` bandeja con triage + **feedback L2** (precision_score → auto-supresión salvo pinned). Frontend `/finanzas/hallazgos` (KPIs+tabla densa+evidencia+confirmar/descartar+link póliza+panel reglas). `maat_hallazgos` lee `finance.findings`. Smoke 36/36 (scan→103 hallazgos cadena_incompleta, feedback→precisión). **Pendiente prod: migs newdb (139/140) + seeds + feeds (GX v3 docs + cadena) + `ANTHROPIC_API_KEY` Railway + re-login; cron importer.** **MAAT.7 (2.0 ReAct) + Maat 3.0 (5 pilares) ✅ 2026-07-07** (commits cb5c200 + bloque 3.0): 2.0 = loop paralelo + `render_response` (structured output, mata `[[SEGUIR]]`) + z-score (stddev) + token-diet columnar + scratchpad + prompt causa-raíz. 3.0 (forma factible, sin CrewAI/Neo4j/BullMQ): P4 `maat_simular_flujo` (what-if determinista 3 escenarios) · P5 `maat_red_proveedores` (grafo colusión CTE recursivo Postgres) · P1 `maat_investigar_a_fondo` (sub-agente Auditor in-process) · P3 HITL `finance.proposed_actions` + `maat_proponer_accion` + bandeja Aprobar/Rechazar (ADR-013, sobre nuestras tablas, nunca Kepler) · P2 `FINANCE_NOTIFIER_PORT` → alerta WS en hallazgo crítico (cron nocturno, sin cola). Smoke 42/42. Diferidos con gate: CrewAI/LangGraph, BullMQ (Fase F), Neo4j (sin data forense), pgvector-knowledge (>100 entradas). **Pendiente prod: migs newdb (139/140/141) + seeds + feeds + `ANTHROPIC_API_KEY` Railway + re-login.** Plan en [`FASE_MAAT`](docs/IMPLEMENTACION/FASES/FASE_MAAT_FINANZAS_AI.md).** |
| **RA** | **Compras / Reabastecimiento (punto de reorden + existencia crítica + sugerido)** | **🟢 CERRADA (beta) + DESPLEGADA A PROD 2026-07-09 — ADR-030. RA.0–RA.9 + RA.11–RA.14 ✅; 5 migs en Railway; smoke `test-newdb-replenishment` 18/18 en regression. Trae el reabastecimiento que Kepler ya opera. Decode verificado: `kdii.c33`=mínimo/`c34`=reorden/`c35`=máximo (piezas, NO precios; doc corregida). Nuevo proyecto de primer nivel **Compras** (`/compras`, perms `COMPRAS_VER/GESTIONAR`): página Existencia Crítica (buckets agotado/bajo_min/bajo_reorden/sobrestock + `sugerido = max(0, objetivo − existencia − tránsito)`) + Requisiciones HITL (folio `RQ-YYYY-NNNNN`, aprobar/rechazar). Schema `commercial.reorder_policy` (producto×almacén, source kepler/computed/manual) + `purchase_requisitions/_lines` (mig 20260708120000/120100). Importers BULK reusan `STOCK_BRANCH_MAP`: `import-reorder-policy` (Kepler, 3924 local) + `import-computed-reorder` (demanda, cubre el ~82% sin config; CEDIS=0). Backend `commercial-replenishment`. Motor decide/humano aprueba/LLM fuera (ADR-016). Builds view+api OK; SQL+smoke DB validados (449 agotado/447 bajo mín, sugerido $1.1M). **RA.11–RA.14 ✅ local 2026-07-09** (mig 20260709120000, decode cadena Kepler §2.5: `xa3701`=Vale de entrada `X-A-37`; compra=género X, traspaso=género N): origen proveedor/sucursal por línea (RA.11), multi-sucursal → N requisiciones (RA.12), mínimo de pedido EN CAJAS `suppliers.min_order_boxes` (RA.13a), flujo `approved→ordered→received`+fill rate (RA.14). **RA.5 ✅ local 2026-07-09** (mig 20260709140000): `analytics.purchase_in_transit` + `import-in-transit.js` (OCs `X-A-35` sin `X-A-40`) → el sugerido resta el tránsito + columna "OC a recibir". **RA.8 ✅ local 2026-07-09** (mig 20260709160000): `commercial.replenishment_findings` + `ReplenishmentScannerService` (@Cron nocturno) detecta agotado_abc/bajo_reorden → bandeja `/compras/hallazgos` + `scan-now`. **RA-PRO.1+2 ✅ local 2026-07-09** (mig 20260709180000, benchmark vs SAP IBP/Blue Yonder/RELEX/Netstock): eleva el reorden a **estándar de industria** — safety stock por **nivel de servicio** (`ceil(Z(servicio)×σ×√lead)`, Z por inversa normal Acklam, A=0.98/B=0.95/C=0.90) reemplaza días-de-cobertura + segmentación **ABC-XYZ** (XYZ por CV=σ/μ). σ en import-inventory-health, cómputo en import-computed-reorder, UI /compras (columnas Clase+Colchón, filtros ABC/XYZ). Smoke `test-newdb-ra-service-level` 18/18. **RA-PRO.3 ✅ 2026-07-09 (sin migración):** lead time por proveedor = CAPTURA MANUAL (Kepler NO codifica LT real — verificado: 73% OC→entrada mismo día, promedio −7.6d). Página `/compras/proveedores` (lead time + mínimo cajas editables). **RA-PRO.6 ✅ 2026-07-09 (mig 20260709190000, prod):** DRP multi-echelon — el CEDIS (que no tenía política) se planea sobre demanda dependiente `media_red=Σavg(suc)+propio`, `σ_red=√(Σσ²)` risk pooling. Topología `warehouses.source_warehouse_id` + página `/compras/red` + `import-network-reorder.js` (nightly). Smoke `test-newdb-ra-network` 7/7. Doc [`FASE_RA_BENCHMARK_ENTERPRISE`](docs/IMPLEMENTACION/FASES/FASE_RA_BENCHMARK_ENTERPRISE.md). **Migs 20260709180000+190000 aplicadas a Railway. Diferido: RA-PRO.4 Croston (marginal), RA-PRO.5 vendor scorecard (débil), RA-PRO.6.2 vista distribución, RA-PRO.7 estacional; RA.13b fill rate; write-back Kepler. Pendiente prod: redeploy api+view + agendar/configurar topología de red (source_warehouse_id arranca NULL) + re-login.** Plan en [`FASE_RA`](docs/IMPLEMENTACION/FASES/FASE_RA_REABASTECIMIENTO.md).** |
| **CB** | **Conciliación bancaria (interfaz reemplaza el Excel)** | **🔨 EN CURSO — CB.0 ✅ 2026-07-22 (ADR-033). El workbook Excel manual de bancos ("CUENTAS LUIS FRANCISCO": 19 cuentas + caja + factoraje, ~4,865 movs/mes a mano) → interfaz `/finanzas/bancos`. Entendido y validado vs enero 2026 (parse == CONCENTRADO al peso: Ingresos $52.95M/Compras $43.5M/Gastos $6.58M/TI=TE $25.4M). Hallazgo: códigos Excel SOBRECARGADOS (612=SUA+comisión+capital+arrendamiento; 610=nómina; 613=caja-ahorro+vehículo) y no empatan Kepler → catálogo LIMPIO alineado a Kepler (decisión Edgar: rediseñar, no migrar). Schema `finance.bank_*` (mig 20260722130000, RLS): bank_accounts (20 seed) + movement_categories (18 seed) + bank_statements + bank_movements (UPSERT client_uuid) + bank_recon_matches. Piedra Rosetta: workbook = detalle por banco que Kepler colapsa en `102` único; `BNMX 1463`=subcuenta Kepler "BANAMEX 1463"; `FACTORAJE`=`210`. **CB.0–CB.7 ✅ local (beta):** CB.1 importer XLSX (exceljs) · CB.2/2.1 backend + upload web · CB.3 frontend `/finanzas/bancos` · CB.4/4.1/4.2 conciliación control-total + matching por-transacción + diferencias · CB.5 clasificación afinada · **CB.6 Admin + reglas de clasificación en DB** (`bank_classify_rules` mig 20260722160000 + `classified_by` mig 20260722160500; classify() hardcodeado+duplicado → tabla editable, motor lee DB en CLI+web, reclasificar respeta manual) · **CB.7 diferencias→hallazgos** (`syncFindings` empuja a `finance.findings` vía `FINANCE_FINDINGS_SINK_PORT`; reglas banco_retiro_sin_kepler/sin_clasificar/pnl_descuadre; auto-push en runMatch + botón) · **CB.8 cuadre de saldos** (import deriva `opening_balance`; `GET /balances` + card `inicial+dep−ret==final` + check TI=TE + hallazgo `banco_saldo_no_cuadra`; 2º pase matcher monto-exacto sin tope fecha ≥$10k). Hallazgo: grandes sin casar = descuadre de MONTO (centavos), no fecha → lever real = tolerancia monto + fuzzy-name (diferido). **Pendiente Railway: migs 130000/140000/150000/160000/160500 + redeploy.** Diferido (CB.9+): comparativa MoM + desglose clickeable, filtros (recon_status/fecha/importe), webhooks salientes, tolerancia monto+fuzzy-name en matcher. Plan en [`FASE_CB`](docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md).** |

Detalle de cada fase en [`docs/IMPLEMENTACION/FASES/`](docs/IMPLEMENTACION/FASES/).

---

## Documentación clave

| Archivo | Para qué |
|---|---|
| [`docs/IMPLEMENTACION/INDEX.md`](docs/IMPLEMENTACION/INDEX.md) | Mapa de toda la documentación |
| [`docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md`](docs/IMPLEMENTACION/00_ROADMAP_GENERAL.md) | Vista de pájaro 9 fases |
| [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) | Kanban en vivo |
| [`docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md`](docs/IMPLEMENTACION/02_DECISIONES_ARQUITECTURA.md) | 10 ADRs |
| [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) | Historial de checkpoints |
| [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md) | 60 findings del código actual |
| [`docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md`](docs/IMPLEMENTACION/FASES/FASE_A0_MULTITENANT_NEW_DB.md) | **Sprint actual** detallado |
| [`docs/PLAN_PLATAFORMA_B2B.md`](docs/PLAN_PLATAFORMA_B2B.md) | Visión completa (29KB, solo leer al planear features grandes) |

---

## Datos del entorno

- **Service ID Railway**: `69f64078-1678-40f4-a266-a18b61a20cde` (cache mounts `id=s/<service>-<target>`).
- **DB legacy (actual prod)**: Postgres en Railway (host `switchback.proxy.rlw...`, accesible via `.env` local).
- **DB nueva multi-tenant**: ✅ Creada local en `192.168.0.245:5432/postgres_platform` con Postgres 18.4. Pendiente migrar a Railway (Sprint A.0mt.5 cutover).
- **Primer tenant**: `mega_dulces` con UUID `00000000-0000-0000-0000-00000000d01c`.
- **WhatsApp BSP**: pendiente decidir (ADR-006).
- **LLM provider**: pendiente decidir (ADR-007, recomendado Claude Haiku 4.5).
- **Partner fintech**: pendiente identificar (ADR-008).

---

## ADRs vigentes (resumen)

- **ADR-001** ✅ Tracking via markdown en repo (no Linear/Jira).
- **ADR-002** ✅ Orden de fases: limitaciones primero.
- **ADR-003** ❌ Superseded by ADR-010.
- **ADR-004** ❌ Superseded by ADR-009.
- **ADR-005** ✅ Stack mobile: extender `apps/view` con módulo `vendor/` (no app RN separada). Decidido 2026-05-26.
- **ADR-006** ⏳ WhatsApp BSP — pendiente.
- **ADR-007** ⏳ LLM provider — pendiente.
- **ADR-008** ⏳ Partner fintech — pendiente.
- **ADR-009** ⚠️ Superseded por pivot 2026-05-26: Kepler no existe, core comercial se construye desde cero. El plan FDW se reactiva si aparece ERP externo.
- **ADR-010** ✅ Multi-tenancy aceptado: shared DB + `tenant_id` desde DB nueva.
- **ADR-011** ✅ 2026-05-27 — Embeddings: Voyage AI `voyage-3` (1024 dims, multilingual). Necesita `VOYAGE_API_KEY`.
- **ADR-012** ✅ 2026-05-27 — pgvector en DB legacy ahora; la columna `embedding` se mueve con la tabla cuando se migre TM a multi-tenant.
- **ADR-016** ✅ 2026-06-10 — Motor de Inteligencia Comercial (respuesta a comparativa yom.ai): **el motor decide, el agente comunica, el LLM fuera del camino del dinero**. 5 capas (Customer 360 → Decisión → Agente → Canales → Feedback). Build por rebanada vertical. Plan en [`FASE_M`](docs/IMPLEMENTACION/FASES/FASE_M_MOTOR_INTELIGENCIA.md).
- **ADR-018** ✅ 2026-06-11 — **Thot**: motor comercial multi-señal (rotación/margen/afinidad/zona/momentum/whitespace), heurístico→ML→agente, feedback loop = entrenamiento. Evoluciona ADR-016.
- **ADR-020** ✅ 2026-06-16 — **Horus**: Supervisor AI de ejecución en Trade. Hereda ADR-016 (motor decide / agente comunica / LLM fuera de lo laboral). Nivel **co-piloto** (acción → `pending_approval`). Motor SEPARADO de Thot (`libs/trade`). 3 capacidades: parte diario, visión de fotos, fraude. Plan en [`FASE_HORUS`](docs/IMPLEMENTACION/FASES/FASE_HORUS_SUPERVISOR_AI.md).
- **ADR-021** ✅ 2026-06-17 — **Aprendizaje de Horus** (track Horus.L): el motor aprende (determinista/auditable/overridable), el LLM sigue fuera del lazo. Taxonomía L0 memoria→L1 baselines→L2 auto-calibración→L3 efectividad (diff-in-diff)→L4 pesos adaptativos→L5/L6 diferidos. **Ship-collector-before-learner** (gate por calendario, no código). L2 ✅ en código (precisión por regla → suprime/capa ruidosas; pin humano). Plan en [`FASE_HORUS`](docs/IMPLEMENTACION/FASES/FASE_HORUS_SUPERVISOR_AI.md).
- **ADR-027** ⏳ 2026-07-02 — **Última milla** (entrega a domicilio local): orquestación, no módulo nuevo. Pedido = `commercial.orders (delivery_type='home_delivery')`, entrega = `logistics.*` (guías/POD/GPS/ETA ya existen), moto = `logistics.vehicles`. Lo nuevo = el dinero: `PaymentsService` multi-método + corte de caja con arqueo. Quita cash-only global (cierra deuda Fase B). Hereda ADR-016/020. Propuesto. Plan en [`FASE_LM`](docs/IMPLEMENTACION/FASES/FASE_LM_ULTIMA_MILLA.md).
- **ADR-028** ⏳ 2026-07-06 — **Maat**: AI de Finanzas SIN fine-tuning. Conocimiento curado + chat tool-use (cero números del LLM) + motor determinista de patrones (riesgo/error/oportunidad) + aprendizaje Horus-L (baselines → auto-supresión por feedback). `libs/finance`, hereda ADR-016/021/026. Propuesto. Plan en [`FASE_MAAT`](docs/IMPLEMENTACION/FASES/FASE_MAAT_FINANZAS_AI.md).

---

## Notas de operación con Claude

- **Auto mode** activo → avanzar sin pausas largas, tomar decisiones razonables.
- **Estilo CONCISO**: no explicar de más. Confirmación + qué sigue. El tracker registra el detalle, no la respuesta. Sin recaps largos. Solo expandir cuando hay bug raro o decisión arquitectónica nueva.
- **Tickets/commits**: `feat([A.0mt.1.1]): descripción`. Código va entre brackets, viene del tracker.
- **Al cerrar item**: marcar `[x]` + cambiar símbolo a ✅ + fecha de cierre.
- **Al cerrar sprint**: entry en `03_LOG_REVISIONES.md` con resumen + lessons learned.
- **Finding nuevo no listado**: agregar a `AUDITORIA_BASE_INICIAL.md` con código nuevo.

---

## Design System ("Mercado" — 2 surfaces)

Antes de cualquier decisión visual/UI, leer [`DESIGN.md`](DESIGN.md). Un solo sistema, dos modes:

- **Storefront** (`/portal/*`): Fraunces editorial + Hanken Grotesk + Geist Mono. Decoración intencional, ilustraciones SVG, density comfortable.
- **Operations** (`/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`): **NO Fraunces**, NO ilustraciones. Page-head = Hanken Bold. Tabla densa + master-detail como primary organism. Density compact++. Tesis "esto es serio".

Comparten: paleta Stone, sunset acción (`--action`), IA ember (mata morado `#8b5cf6` y azul `#2563EB`), dark espresso (mata `#000` puro), escala de radios. Tokens en [`apps/view/src/styles/tokens.css`](apps/view/src/styles/tokens.css). No desviarse sin aprobación. En QA, marcar código que no respete `DESIGN.md`.

Migración Operations (tokens.css): **pendiente de aprobación del diff** — plan documentado en sección "Plan de migración Operations" de `DESIGN.md`.
