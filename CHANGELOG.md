# Changelog

> Cambios notables del repo Trade Marketing. Vivo como complemento de
> [`docs/IMPLEMENTACION/03_LOG_REVISIONES.md`](docs/IMPLEMENTACION/03_LOG_REVISIONES.md) (detalle de sprints) y
> [`docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md`](docs/IMPLEMENTACION/01_TRACKER_PROGRESO.md) (kanban). Este archivo es para "¿qué cambió las últimas N semanas?" sin abrir git log.
>
> Convención: secciones por fecha (más reciente arriba). Cada release agrupa por **Added / Changed / Fixed / Deprecated / Removed / Internal**. Actualizar al cerrar sprint o feature relevante.

---

## [Unreleased]

### Added — Modo Vendedor v2 · V.0: cartera del vendedor + orden de visita
- **`commercial.vendor_sales_routes`** (mig `20260610100000`): qué rutas de venta (`sales_route`) cubre cada vendedor — el `supervisor_ventas` asigna. La cartera del vendedor = clientes de esas rutas. + **`customers.visit_sequence`**: orden de visita del cliente dentro de su ruta. FK a `identity.*` (las tablas reales; `public.users/tenants` son vistas), RLS, idempotente.
- **Módulo `commercial-vendor-routes`** (7 endpoints): rutas+conteo+asignados, vendedores asignables, clientes-por-ruta, asignar/quitar (idempotente), "mi cartera" (vendedor), ordenar (`visit_sequence` 1..N). Gestión gateada por `USUARIOS_ASIGNAR_RUTA` (lo tiene `supervisor_ventas`), lectura por `COMMERCIAL_CUSTOMERS_VER` — sin permiso nuevo (evita el riesgo de ability.factory).
- **Página `/comercial/cartera`** ("Cartera de ventas"): el supervisor asigna/quita rutas a vendedores y **ordena la secuencia de visita** de los clientes de cada ruta con botones subir/bajar (PrimeNG 18 no expone `reorderableRows`). Ítem en el nav comercial.

### Added — Modo Vendedor v2 · V.1: backend de pedidos por cartera + ciclo de vida del vendedor
- **`GET /commercial/orders` con filtros nuevos**: `?statuses=pending_approval,confirmed` (multi-status CSV), `?mine=true` (restringe a clientes de la cartera del vendedor del JWT vía `vendor_sales_routes`) y columna calculada **`is_preventa`** (`true` si el pedido lo originó el cliente desde el Portal B2B — su user es `customer_b2b`; `false` si lo tomó un vendedor en campo). Base de "Por entregar".
- **`GET /commercial/customers?mine=true`**: cartera del vendedor (clientes de sus rutas) ordenada por `visit_sequence` (nulls al final). Base de "Clientes por ver" / "Pedido nuevo".
- **`VendorService`**: métodos `myCartera()`, `pendingDeliveries()`, `approve()` (pending_approval→confirmed), `fulfill()` (confirmed→fulfilled) + tipo `VendorOrder` (Order enriquecida con `is_preventa`/`customer_name`/`route_name`).
- **Ciclo de pedido para roles de campo**: el vendedor ahora gestiona su cartera de punta a punta. Seed `FIELD_PERMS` + backfill `20260610110000` activan `COMMERCIAL_ORDERS_CONFIRMAR` / `FULFILL` / `CANCELAR` en `colaborador` / `ejecutivo` / `vendedor` (idempotente, merge guardado por `@>`). Las 3 keys ya estaban mapeadas en `ability.factory`. **Requiere re-login** (el permiso vive en el JWT).

### Fixed — Ventas (comercial): sesión de corrección de bugs
- **Televenta dashboard 100% roto** (`dashboardMetrics`): consultaba columnas inexistentes en `commercial.lead_reservations` (`status`, `user_id` → 500 siempre) y filtraba `call_logs.outcome` por valores en español (`pedido_tomado`…) que el CHECK prohíbe (métricas en 0). Alineado al schema real (`released_at IS NULL`, `reserved_by_user_id`) y al enum canónico (`sale`/`no_answer`/`callback_scheduled`/`no_sale`).
- **`adjustStock` no atómico**: se partía en 3 transacciones (read → recordMovement → overwrite) → saldo corrupto ante crash y lost-update concurrente. Ahora un único `tk.run` con `forUpdate`, valida `new_quantity >= reserved` y registra `quantity_before/after` correctos.
- **`reserveLead` 409 espurio**: no pre-liberaba reservas vencidas antes del INSERT → chocaba el UNIQUE parcial sobre leads que la cola sí ofrece. Ahora pre-libera (`released_reason='expired'`) en el mismo trx.
- **`bulkUpsertPrices` no avanzaba `updated_at`**: el `.merge()` lo referenciaba pero las rows no lo seteaban. Ahora cada row setea `updated_at: now()`.
- **Fechas por defecto en UTC, no MX** (route-tickets + vendor-sales): `toISOString().slice(0,10)` ocultaba capturas de 18:00–23:59 MX. Ahora usan `todayMx()`/`toMxDateKey()`.
- **Desvincular tienda de cliente no persistía**: tanto el `linkStore` inline como el dialog de edición (`save()`) mandaban `store_id: undefined` (backend lo trata como "sin cambio"). Ahora ambos mandan `null`, consistente con `linkRoute`. Quitado de paso el método muerto `onToggleActive()`.
- **KPIs de pedidos sobre la página visible**: hero "Ventas en la ventana" y counts de history reflejaban solo la página. El backend `list` ahora devuelve `total_amount` agregado del filtro y el front usa `statusCounts()` reales.
- **Fugas RxJS**: 25 `.subscribe()` en 6 componentes de `/comercial` sin `takeUntilDestroyed` (incl. streams permanentes `route.data` y `search$`). Todas envueltas.

### Changed — Alertas realtime desactivadas
- **Apagadas todas las alertas realtime del Command Center** (decisión de producto): el scanner cron `AlertsScannerService` (emitía `low_stock_critical` + `vip_inactive` cada 5 min) queda gateado por `ENABLE_COMMERCIAL_ALERTS` (default off); el Command Center ya no abre el socket de alertas ni muestra el feed/toasts en vivo (se limpió el feed, el tag "En vivo" y los helpers huérfanos). Se mantienen el panel informativo "Stock bajo" del dashboard (endpoint analytics) y el resto del dashboard. Reactivable con `ENABLE_COMMERCIAL_ALERTS=true`.

### Added — Cliente comercial: WhatsApp + ruta de venta estructurada
- **Columna `whatsapp`** en `commercial.customers` (normalizada a E.164, índice único parcial por tenant) — migración `20260609140000` idempotente (local+prod). El backend normaliza a `+52…` en create/update y mapea colisiones (23505) a 409; el front la expone en el dialog y en la ficha del cliente, en lugar del viejo selector de tienda.
- **Columna `sales_route`** (ruta de venta): la ruta que el ERP traía como texto en `notes` ("Ruta: RUTA 21") se migró a un campo estructurado. Script `backfill-customer-sales-route.js` pobló **2.859 clientes** (12 rutas). La columna "Ruta" de `/comercial/customers` ahora muestra `sales_route`. (`route_id` sigue apuntando a logística, hoy vacía — son rutas distintas.)

### Changed — /comercial/customers alineado al vínculo tienda↔cliente
- **Vínculo de tienda ahora es de solo lectura**: se quitó el selector inline "Vincular tienda" de la tabla y el campo editable del dialog (cada tienda nace como cliente al alta; el vínculo no se edita a mano). Se muestra como chip read-only. Eliminados los métodos/signals huérfanos (`linkStore`, `linkRoute`, `routeName`, etc.).
- **Backend blindado**: `store_id` es inmutable vía PATCH (no se puede cambiar ni quitar un vínculo existente — `BadRequestException`); violaciones de unicidad devuelven **409** con mensaje claro en vez de 500.
- **Hallazgo (workflow de análisis)**: el modelo NO es 1:1 en los datos — hay **2.941 clientes del ERP** vs **36 tiendas** de Trade. Los 19 STR- del bulk previo no duplican clientes ERP (tiendas piloto distintas); quedan 5 homónimos internos del ERP para revisión manual.

### Added — Modelo 1:1 tienda↔cliente (Ventas)
- **Cada tienda de Trade Marketing es un cliente comercial.** `database/scripts/promote-all-stores-to-customers.js` (dry-run default, `--apply` para escribir): promueve en bulk todas las tiendas activas sin cliente a `commercial.customers`, idempotente, reusando la lógica de `createFromStore` (code `STR-…`, name = nombre de la tienda, price_list default). Poblado inicial: **36/36 tiendas activas ↔ clientes**.
- **Auto-provisión al alta**: al crear una tienda en Trade (`StoresService.create`) se crea automáticamente su cliente comercial, vía el nuevo Port `CUSTOMER_PROVISIONING_PORT` (inversión de dependencia trade→commercial en el composition root, `@Optional` para no acoplar la app legacy, best-effort post-commit — si falla no rompe el alta de la tienda).
- Migración `20260609120000`: índice único parcial `commercial.customers (tenant_id, store_id) WHERE store_id IS NOT NULL AND deleted_at IS NULL` — garantiza el 1:1 (un store, un cliente activo).

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
- **Rutas — ruta duplicada por zona del store**: `getRoutesData` sacaba la zona de cada tienda (`stores.zona_id`) y la metía en el `GROUP BY`, fragmentando una ruta en una fila por cada zona distinta de sus tiendas (ej. "RUTA 23 / LA PIEDAD RD" + "RUTA 23 / —" para tiendas sin zona). Ahora la zona viene de la **ruta** (`catalogs.parent_id → zones`) y el filtro de zona usa `c.parent_id` → una fila por ruta. Complemento: el hook `maybeAssignStoreRoute` ahora también alinea `stores.zona_id` a la zona de la ruta en cada captura, y `database/scripts/backfill-store-zone-from-route.js` corrige la data histórica (dry-run por default).
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
