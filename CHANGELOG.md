# Changelog

> Cambios notables del repo Trade Marketing. Vivo como complemento de
> [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) (detalle de sprints) y
> [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) (kanban). Este archivo es para "¿qué cambió las últimas N semanas?" sin abrir git log.
>
> Convención: secciones por fecha (más reciente arriba). Cada release agrupa por **Added / Changed / Fixed / Deprecated / Removed / Internal**. Actualizar al cerrar sprint o feature relevante.

---

## [Unreleased]

### Added
- `database/scripts/README.md` — mapa de 92 archivos agrupado en 11 familias con estado 🟢🟡🔵⚫.
- `.env.example` — +18 vars que estaban undocumentadas (cutover, vector, tests E2E, S3, etc.).
- `package.json` — npm scripts `regression`, `import:commercial`, `seed:testdata` (loop completo), `cutover:preflight`, `cutover:smoke`, `embeddings:backfill`, `embeddings:sync`, `migrate:new`, `seed:new`.
- `DESIGN.md` — sección **"Mercado / Operations"** extendiendo el design system a `/dashboard/*`, `/comercial/*`, `/logistica/*`, `/admin/*`, `/vendor/*`, `/televenta/*`. Mismo sistema, 2 surfaces (Storefront + Operations).
- `CHANGELOG.md` — este archivo.

### Changed
- `CLAUDE.md` — Design System ahora cubre 2 surfaces (era solo `/portal`).
- **Rutas — tienda↔ruta "última gana"**: el hook `maybeAssignStoreRoute` ahora reasigna `stores.ruta_id` a la ruta de CADA captura (antes solo asignaba si la tienda no tenía ruta). Así el apartado Rutas agrupa cada tienda bajo la ruta que la capturó por última vez. Cambio en `libs/trade/.../daily-captures.service.ts`.

### Added
- `database/scripts/backfill-store-route-from-captures.js` — backfill idempotente (dry-run por default) que aplica "última gana" a la data histórica: cada tienda hereda la ruta de su captura más reciente con `route_id`.

### Fixed
- **Rutas — timezone mismatch maestro vs detalle**: la lista de rutas (`getRoutesData`) filtraba por `DATE(hora_inicio)` en UTC mientras el detalle (`getRouteVisits`/`getRouteStores`) usaba `AT TIME ZONE 'America/Mexico_City'`. Las capturas de la tarde-noche MX caían en el día UTC siguiente → el conteo "N vis" del maestro no cuadraba con el detalle y rutas con actividad real desaparecían con el rango default = hoy. Alineado todo a MX.
- **vendor-capture**: selector de ruta ahora usa `p-select` (igual que captura diaria) en vez de `<select>` nativo.

### Added — Tiempos muertos (detección)
- **Fase 1 (derivado, sin captar data nueva)**: `GET /reports/routes/:id/idle` y `GET /reports/idle/summary`. Detecta tiempo muerto entre visitas consecutivas del mismo vendedor: `idle = max(0, gap − traslado_estimado)`, traslado = haversine(tiendas)/25 km/h, umbral muerto 20 min. UI en /routes: KPI "Tiempo muerto" + columna "Muerto antes" por visita. Resumen agregado por vendedor para dashboard. `computeIdleSegments` corta por (vendedor, día MX).
- **Fase 2 (breadcrumbs GPS)**: tabla `public.route_location_pings` (mig 20260609100000, sin RLS patrón push_subscriptions). Dexie v5 `routePings` + `RoutePingService` (ping cada 3 min en foreground con ruta activa, cola offline, sync bulk idempotente a `POST /reports/route-pings`). Refinamiento: `getRouteIdle` separa estacionado vs traslado con los pings (idle real = tiempo estacionado), con indicador GPS en la UI. Fallback al estimado por haversine si no hay breadcrumbs.

### Pending
- **Plan migración tokens.css** documentado en DESIGN.md → no aplicado (riesgo de regresión visual cross-app).
- **T1** scripts hardening (`--dry-run` uniforme + `assertEnvVars()`).
- **T2** hints contextuales en tests al fallar (TenantKnex, ability.factory).
- **T3** `docker-compose.dev.yml` + `npm run dev:up`.

---

## 2026-06-08 — Apartado Rutas + Cierre Ruta UI + DX hardening

### Added
- **`/dashboard/routes`** — apartado completo con master-detail (lista rutas + KPIs + mapa Leaflet recorrido + tabla visitas + tabla tiendas). Permiso `RUTAS_VER`. Backend reusa `/reports` (cero schema nuevo). Fases 0-3 (permiso → backend → frontend → backfill).
- **`/comercial` cierre-ruta** — vista admin "Ventas de vendedor" (ticket OCR).
- **Customers Kepler import** — `customers-from-excel.js` + `link-customers-to-stores.js` para combinar maestro Kepler con `commercial.customers`.

### Fixed
- **PWA overflow-x** — `<main>` con `overflow-y-auto` forzaba `overflow-x: auto` → pantalla se deslizaba lateral. Fix: `overflow-x: hidden` en main + body + html, sin romper tablas anchas.
- **Reports** — chromium del SO en Docker + `executablePath` puppeteer, templates `hbs` en webpack assets.
- **PWA service worker** — catalogs/zones/customers a estrategia **freshness** (no cache-first, evita data stale post-merge).

### Internal
- DX review aplicada (F1+F2+F5 del review `/plan-devex-review`): scripts README, .env.example, npm aliases.

---

## 2026-06-07 a 2026-06-05 — Vendor capture + tickets + auth

### Added
- **Vendor capture** — ticket multi-foto, OCR mejorado, visita siempre primero + link `daily_capture_id` + `product_id` via aliases.
- **Catalog aliases** — sistema `trade.catalog_aliases` para mapear UUIDs viejos de conceptos a vigentes. Reporte y resolver de capturas consultan aliases. Migración faltante 20260606100000 agregada en remediation.

### Fixed
- **Auth JWT** — JWT >4KB no entraba en cookie → persistir en localStorage.
- **Auth-trigger** — `auto_populate_tenant_id` no sobrevivió `SET SCHEMA` en prod → mig 20260606000000 dinámica recrea trigger en 57 tablas multi-tenant.
- **Captures** — ticket vendedor acumula varias fotos del MISMO ticket; remap `sku→product_id`; bloquear visita vendedor sin productos.
- **Touch targets ≥44px** en sidebar nav + topbar user menu (F010 design audit).

---

## 2026-06-04 — Portal B2B standalone deploy + Design audit codemods

### Added
- **Portal B2B en repo aparte** — `Portal_MegaDulces` con `API_UPSTREAM` + nginx resolver. `customer_b2b` permisos scoped (mig 20260605120000).
- **Telemetría endpoint** — `commercial-portal-telemetry` con ingesta + resumen.

### Changed
- **Design audit codemods** — sweep monocromo `comercial/*`, `logistica/*`, `portal/catalog`. Codemod hex pass 2 (cart, televenta). AI accent purple `#8b5cf6` → token `--ai-accent` semantic (G1). Tipografía 10-12px + font-weight hierarchy + shadow decorativa fuera (F4/F6/F9).

---

## 2026-06-03 — Module Isolation Sprint (iso.0–iso.6)

### Internal
- **Monolito modular endurecido** — 41 módulos NestJS reorganizados en libs Nx por dominio (`platform-core`, `contracts`, `commercial`, `logistics`, `trade`). Fronteras enforced con `enforce-module-boundaries: error`. Port DI-invertido logistics→commercial. 1 deployable. Ver memoria `project_module_isolation`.

### Fixed
- **FDW boot migrations** — migraciones que ejecutan query contra FDW mega_dulces_srv (.245) crasheaban boot en Railway. Mig 110000 ajustada. Ver memoria `feedback_fdw_boot_migrations`.

---

## 2026-06-02 — Cierre formal Comercial Fases B+C+D+E

### Added
- **ADR-013** — `pending_approval` order status (cliente confirm → `/approve` vendedor → confirmed).
- **Regression suite ampliada** — 19/19 verde, ~155 sub-assertions en ~10.6s.

### Fixed
- **28 mappings ability.factory** — permisos COMMERCIAL_* y LOGISTICS_* sin map a subject/action causaban 403 "permisos dinámicos" para todo rol sin `manage:all`. Ver memoria `feedback_ability_factory_mapping`.

### Internal
- **Fases B+C+D+E cerradas** (beta scope) con regression suite como fuente de verdad. Ver memoria `project_comercial_cierre_formal`.

---

## 2026-05-27 — Fase E Televenta + Fase J Logística + Fase K AI

### Added
- **Fase E Televenta** (CERRADA beta) — workflow call center sin telefonía. Rol `tele_operator`, pool autoservicio, cron @5min libera leads expirados. Smoke 29/29. Endpoints `/api/commercial/televenta/*`. Frontend `/televenta/*` con 4 páginas.
- **Fase J Logística** (CERRADA beta) — embarques, flotilla, costos, guías, liquidaciones, reports. 7 backend modules + 5 admin pages + analytics + hooks cross-project Comercial↔Logística. UI port desde `_imported/logistica/` (Dashboard ops, Personal/Staff con MultiSelect roles, Guides global con 5 KPIs, Costs con KPIs + dialog 10 categorías).
- **Fase K AI product match** (CERRADA beta) — Docker `pgvector-md` (pg18 + vector 0.8.2) + Voyage AI `voyage-3` (1024 dims) + Claude Haiku 4.5 en wizard captures paso 5. 1278 SKUs embedded. Endpoint `/api/ai/products/match-ai`, threshold 0.40, throttle tier `long`. EmbeddingSyncService @Cron cada 15min + endpoint manual. Script `sync-from-remote.js` Docker↔.245.

### Internal
- **K-debt cerrado** — refactor `catalogs.service.ts` + `daily-assignments.service.ts` + `stores.service.ts` para no escribir a columna virtual `activo BOOLEAN GENERATED`.

---

## 2026-05-26 — Sprint A.0-multitenant + Fases B+C+D (todo en un día)

### Added
- **A.0 Multitenant** (CERRADA beta) — nueva DB Postgres 18.4 multi-tenant en `192.168.0.245:5432/postgres_platform`. Schema completo 19 tablas + 95 índices + 18 RLS + rol `app_runtime` + seeds. `TenantContextService` (AsyncLocalStorage) + Interceptor + auth-mt. 1804/1830 rows migrados desde legacy (98.6%).
- **Fase B Core Comercial** (CERRADA beta) — 9 tablas en schema `commercial.*` (customers, warehouses, price_lists, product_prices, stock, stock_movements, orders, order_lines, payments). State machine orders `draft → confirmed → fulfilled`. Generator `PD-YYYY-NNNNN`. CLI importer + test data realista (5 brands + 25 products + 25 prices + 20 customers + 25 stock).
- **Fase C Sales Intelligence** (CERRADA beta) — 7 endpoints `/commercial/analytics/*` (overview, top-customers, top-products, sales-by-brand, low-stock, etc.) + 3 materialized views + `AnalyticsRefreshService` @Cron('*/15min'). Frontend Command Center con 4 KPIs + 4 tablas + alertas WS realtime (low_stock_critical, vip_inactive).
- **Fase D Catálogo + Portal B2B** (CERRADA beta) — `customer_id` UUID + composite FK + `commercial.order_status_history`. Rol `customer_b2b`. Portal Web B2B en `/portal/*` (PortalLogin, PortalCatalog, PortalCart, PortalOrders, PortalOrderDetail). Vendor app mobile-first `/vendor/*` (ADR-005: extender `apps/view` no app RN separada). Canasta estratégica v1 (base/focus/exploration/innovation con score 0..1).
- **ADRs 010, 011, 012** — multi-tenancy shared DB + tenant_id, Voyage AI embeddings, pgvector en DB legacy.

### Internal
- **A.0bis hardening** — Helmet + Throttler 3-tier + body limits 2mb, nginx security headers, console→Logger, Zod schemas para JSONBs.

---

## Pre-2026-05 — Auditoría base + decisiones iniciales

### Added
- **Auditoría base** (60 findings) en [`docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md`](docs/IMPLEMENTACION/AUDITORIA_BASE_INICIAL.md).
- **Stack inicial** — NestJS 11 + Knex + PostgreSQL + Socket.IO + Cloudinary; Angular 18 standalone + PrimeNG + Tailwind + Spartan UI; Capacitor + Dexie mobile; Nx monorepo + Docker + Railway.
- **Auditoría visitas + scoring + reports** funcional. No tomaba pedidos, no catálogo comercial, no multi-tenant.

---

## Convención de updates

1. **Al cerrar feature o sprint** — agregar entry bajo la fecha actual.
2. **Una sección `[Unreleased]`** al tope agrega los cambios sin tag formal.
3. **Categorías estándar:** Added · Changed · Fixed · Deprecated · Removed · Internal · Pending.
4. **No duplicar lo de `03_LOG_REVISIONES.md`** — ese tiene el detalle de lessons learned + diff de archivos. CHANGELOG es la vista "scan en 30 segundos".
5. **Referenciar memoria cuando aplique** — `project_*` o `feedback_*` para más contexto.
