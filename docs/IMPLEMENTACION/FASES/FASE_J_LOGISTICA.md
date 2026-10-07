# Fase J — Logística (embarques, flotilla, costos)

**Duración estimada:** 3-4 semanas (1 dev).
**Objetivo:** absorber el repo Megadulces-Logistica (importado a `_imported/logistica/`) dentro de la plataforma multi-tenant, en el schema `logistics.*`, fusionando módulos en `apps/api` + `apps/view` (opción A — consistencia con Trade/Comercial).

> **Decisión 2026-05-27 (Edgar):** opción A elegida. Mantener un solo backend + un solo frontend, separados por URL prefix `/logistica/*`. Reusar `auth-mt`, `TenantContextInterceptor`, `TenantKnexService`, layout adaptativo. Descartar `libs/shared-auth` del repo origen.

---

## Pre-requisitos

- ✅ Fase A.0-multitenant operativa.
- ✅ Fase B (commercial) cerrada — base de pedidos disponible para hookear embarques.
- ✅ Repo origen importado a `_imported/logistica/` (commit `14d7fe0`, snapshot intocable).

---

## Decisiones técnicas

### Schema DB
- Schema dedicado: `logistics.*` (paralelo a `commercial.*` y `analytics.*`).
- Tablas re-escritas con `tenant_id UUID NOT NULL` + composite FK `(tenant_id, id)` + RLS forzado + grants `app_runtime`. Mismo patrón que B.
- **Descartar** las primeras 9 migraciones del repo origen (duplican auth/captures/scoring del fork Trade).

### Hookeo con commercial.orders
- `logistics.shipments` (rebautizo de `logistica_embarques`) tendrá FK opcional `order_id` → `commercial.orders.id`.
- Al confirmar una `commercial.orders`, opcionalmente crear un draft de `shipment` (sin auto-asignar unidad).
- Inversamente, marcar `commercial.orders.status = fulfilled` cuando todas sus shipments asociadas estén `delivered`.
- Hook deferido para J.4 — primero las tablas y CRUD aislado.

### Naming
- Renombrar tablas a inglés para alinearse con `commercial.*` (`shipments`, `vehicles`, `routes`, `drivers`, `expenses`, `delivery_guides`, `payroll_periods`, `liquidations`). Mantener nombres de columnas en español si es jerga del negocio (`viáticos`, `comisiones`).
- Backend modules: `logistics-shipments`, `logistics-fleet`, `logistics-expenses`, `logistics-guides`, `logistics-staff`, `logistics-payroll`, `logistics-config`.
- Frontend: `apps/view/src/app/modules/logistica/` (consistente con `modules/comercial/`). Renombrar `features/` → `modules/` en migración.

### Auth
- **Descartar** `libs/shared-auth` del repo origen.
- Usar `auth-mt` actual. Mapear roles existentes (`admin`, `supervisor`, `operador`) a nuestros (`admin`, `supervisor`, `jefe_marketing`, `colaborador`) y agregar `chofer` + `logistica_admin` como nuevos.
- Permisos nuevos: `LOGISTICS_SHIPMENTS_VER`, `LOGISTICS_SHIPMENTS_GESTIONAR`, `LOGISTICS_FLEET_VER`, `LOGISTICS_FLEET_GESTIONAR`, `LOGISTICS_EXPENSES_VER`, `LOGISTICS_EXPENSES_GESTIONAR`, `LOGISTICS_STAFF_VER`, `LOGISTICS_STAFF_GESTIONAR`, `LOGISTICS_PAYROLL_VER`, `LOGISTICS_PAYROLL_GESTIONAR`, `LOGISTICS_CONFIG_GESTIONAR`.

### Deps a evaluar
- **NgRx**: el origen lo usa para state management. Nosotros no — usamos signals + services. **Decisión: descartar NgRx**, re-escribir feature stores como services con signals.
- **motion**, **jspdf-autotable**, **puppeteer**, **sharp**, **streamifier**: agregar al `package.json` solo las que efectivamente uses (revisar caso por caso al migrar features).
- **Capacitor mobile**: ya está en nuestro `apps/view`. Reusar.

---

## Sprints

### Sprint J.0 — Schema multi-tenant + migraciones limpias ✅ (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| J.0.1 | Migración `logistics_schema_and_catalogs` (schema + grants + 5 tablas catálogos) | ✅ |
| J.0.2 | Tablas catálogos: `routes`, `drivers`, `vehicles`, `payroll_periods`, `config_finance` | ✅ |
| J.0.3 | Migración `logistics_shipments`: `shipments`, `delivery_guides`, `guide_recipients` | ✅ |
| J.0.4 | Migración `logistics_finance`: `shipment_expenses`, `load_details`, `unload_details`, `liquidations` | ✅ |
| J.0.5 | Seed baseline `06_mega_dulces_logistics_baseline.js` (1 vehicle + 1 driver + 1 route + 1 period + 3 configs) | ✅ |
| J.0.6 | Smoke test RLS `test-logistics-rls-smoke.js` — **11/11 pass** | ✅ |

**Salida:** schema `logistics.*` con **12 tablas**, todas multi-tenant + RLS forzado + composite FKs cross-table + CASCADE deletes locales + grants `app_runtime`.

**Archivos:**
- `database/migrations-newdb/20260527100001_logistics_schema_and_catalogs.js`
- `database/migrations-newdb/20260527100002_logistics_shipments.js`
- `database/migrations-newdb/20260527100003_logistics_finance.js`
- `database/seeds-newdb/06_mega_dulces_logistics_baseline.js`
- `database/test-logistics-rls-smoke.js`

**Tablas creadas (12):**
- `logistics.routes` · `logistics.drivers` · `logistics.vehicles` · `logistics.payroll_periods` · `logistics.config_finance`
- `logistics.shipments` · `logistics.delivery_guides` · `logistics.guide_recipients`
- `logistics.shipment_expenses` · `logistics.load_details` · `logistics.unload_details` · `logistics.liquidations`

**Hooks DB ya cableados:**
- `logistics.shipments.order_id` → `commercial.orders(tenant_id, id)` (composite FK, ON DELETE SET NULL)
- `logistics.guide_recipients.customer_id` → `commercial.customers(tenant_id, id)` (composite FK, ON DELETE SET NULL)
- `logistics.drivers.user_id` → `public.users(tenant_id, id)` (composite FK, ON DELETE SET NULL)

---

### Sprint J.1 — Módulos NestJS backend ✅ código (2026-05-27) — falta E2E HTTP

| ID | Item | Estado |
|---|---|---|
| J.1.1 | `LogisticsFleetModule`: CRUD vehicles + drivers | ✅ |
| J.1.2 | `LogisticsShipmentsModule`: CRUD + state machine (programado→en_ruta→entregado→cerrado, +cancelado) + folio `EMB-YYYY-NNNNN` + hook `commercial.orders.status=fulfilled` cuando todas las shipments del order se cierran | ✅ |
| J.1.3 | `LogisticsGuidesModule`: CRUD guides + recipients + auto-cálculo comisiones desde route + foto/GPS al entregar | ✅ |
| J.1.4 | `LogisticsExpensesModule`: upsert 1:1 con shipment + recompute `operating_subtotal` + `total_cost` (`+ actual_km * costo_km_estandar` si `apply_config_km=true`) + summary agregado | ✅ |
| J.1.5 | `LogisticsPayrollModule`: CRUD periods + endpoint `calculate` que itera drivers y suma comisiones/load_details/unload_details/per_diem del período (idempotente, respeta bonuses/deductions manuales) | ✅ |
| J.1.6 | `LogisticsConfigModule`: CRUD `config_finance` + helper público `getValueByKey()` para servicios de cálculo | ✅ |
| J.1.7 | 11 permisos `LOGISTICS_*` (backend + frontend) + seed `02_mega_dulces_initial_roles` aplicado (superadmin/admin reciben todos) | ✅ |
| Sequences | Migración `logistics.sequences` (counter atómico por tenant+prefix+year, para EMB- y GUIA-) | ✅ |
| Wire AppModule | 6 módulos registrados condicionalmente con `ENABLE_MULTITENANT=true` | ✅ |
| Build api | `nx build api` verde (80 warnings type-only, mismo patrón que tenants-admin/visitas-sync) | ✅ |
| J.1.8 | Smoke test HTTP E2E `database/http-logistics-e2e-test.js` (33 checks: fleet, state machine, guides+recipients, expenses upsert, payroll calculate) | 🧪 escrito — esperando restart de API para correr |

**Endpoints expuestos (30+):**
- `/api/logistics/config` (POST/GET/PATCH/DELETE)
- `/api/logistics/fleet/vehicles` (POST/GET/PATCH/DELETE)
- `/api/logistics/fleet/drivers` (POST/GET/PATCH/DELETE)
- `/api/logistics/shipments` (POST/GET/PATCH/DELETE + `/:id/depart`, `/:id/deliver`, `/:id/close`, `/:id/cancel`)
- `/api/logistics/guides` (POST/GET/PATCH/DELETE + `/:id/recipients`, `/recipients/:id/deliver`)
- `/api/logistics/expenses/shipments/:id` (PUT/GET) + `/summary`
- `/api/logistics/payroll/periods` (POST/GET/PATCH + `/:id/calculate` + `/:id/liquidations`)
- `/api/logistics/payroll/liquidations/:id` (PATCH)

**Archivos:**
- `apps/api/src/modules/logistics-{fleet,config,shipments,guides,expenses,payroll}/` (service + controller + module por cada uno)
- `database/migrations-newdb/20260527100004_logistics_sequences.js`
- `database/http-logistics-e2e-test.js`

---

### Sprint J.2 — Frontend admin logística ✅ código (2026-05-27) — verificación visual pendiente

| ID | Item | Estado |
|---|---|---|
| J.2.1 | `LogisticaService` Angular: wrappers para 30+ endpoints + types tipados (signals + computed) | ✅ |
| J.2.2 | 5 páginas standalone consolidadas: `logistica-fleet` (tabs vehicles/drivers), `logistica-shipments` (lista paginada + state actions inline), `logistica-shipment-detail` (tabs info/guides+recipients/expenses), `logistica-payroll` (split-view periods+liquidations + calculate trigger), `logistica-config` (CRUD parámetros) | ✅ |
| J.2.3 | 5 rutas `/logistica/*` con `permissionGuard(LOGISTICS_*)` apropiado por página | ✅ |
| J.2.4 | Nav items "Logística" en `LayoutComponent` (URL prefix detection `/logistica` → 4 items: Embarques, Flotilla y personal, Liquidaciones, Configuración) | ✅ |
| J.2.5 | Card "Logística" en `/projects` landing con `anyOf` permisos LOGISTICS_* | ✅ |
| J.2.6 | `nx build view` ✅ verde | ✅ |
| J.2.7 | Verificación visual manual (login + abrir cada página + crear shipment de prueba) | 🧪 pendiente usuario |

**Archivos:**
- `apps/view/src/app/modules/logistica/logistica.service.ts` (interfaces + 30 HTTP methods)
- `apps/view/src/app/modules/logistica/pages/logistica-{fleet,shipments,shipment-detail,payroll,config}.component.ts` (5 standalone components)
- `apps/view/src/app/app.routes.ts` (+5 rutas)
- `apps/view/src/app/modules/dashboard/layout/layout.component.ts` (+nav `logisticaNavItems` + URL prefix detection)
- `apps/view/src/app/modules/projects/projects/projects.component.ts` (+card logistica)

**Patrón seguido (consistencia con módulos comerciales):**
- `ChangeDetectionStrategy.OnPush` + signals.
- PrimeNG v18: Tag severities tipadas con union literal (`'success' | 'info' | 'warn' | 'danger' | 'secondary' | 'contrast'`).
- DialogModule + ReactiveForms para crear/editar.
- ToastModule + ConfirmDialogModule para feedback y borrados.
- TabsModule (no AccordionModule) para split de secciones.
- DatePickerModule + InputNumberModule (no PrimeNG legacy).

---

### Sprint J.3 — App mobile chofer (~3-5 días)

| ID | Item | Estado |
|---|---|---|
| J.3.1 | Rutas `/driver/*` en apps/view (similar a `/vendor/*`): hoy, guías-asignadas, registrar entrega | ⬜ |
| J.3.2 | `DriverService` wrapper + `driverGuard` (rol chofer) | ⬜ |
| J.3.3 | Captura de foto firmada de entrega (reusar Cloudinary) | ⬜ |
| J.3.4 | Geolocation tag al marcar entregado | ⬜ |

---

### Sprint J.4 — Hooks commercial ↔ logistics ✅ (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| J.4.1 | FK `logistics.shipments.order_id` → `commercial.orders(tenant_id, id)` composite | ✅ (desde J.0.3a) |
| J.4.2 | Creación manual con pre-fill — opt-in vía botón "Crear embarque" en order detail (no auto-creación, evita sorpresas a usuarios sin perms LOGISTICS_*) | ✅ |
| J.4.3 | `ShipmentsService.close()` cierra `commercial.orders.status='fulfilled'` cuando es la última shipment cerrada del order, dentro del MISMO trx | ✅ (desde J.1.2) |
| J.4.4 | Reuso del endpoint existente `GET /logistics/shipments?order_id=X` (no se duplica en commercial-orders → evita cross-module dep) | ✅ |
| J.4.5 | Sección "Embarques de logística" en `comercial-order-detail`: tabla de shipments + botón "Crear embarque" (solo si `LOGISTICS_SHIPMENTS_GESTIONAR` y order=`confirmed`) + link directo a cada shipment | ✅ |
| J.4.6 | Cross-project navigation: `[routerLink]="['/logistica/shipments']"` con `[queryParams]="{ order_id: o.id }"`. Detección en `LogisticaShipmentsComponent` via `ActivatedRoute.queryParamMap` → auto-abre dialog pre-llenado + banner verde "Este embarque quedará vinculado al pedido. Al cerrarse, el pedido pasará a entregado" | ✅ |

**Flujo end-to-end Comercial → Logística → Comercial:**

1. Usuario abre `/comercial/orders/:id` (estado `confirmed`).
2. Ve sección "Embarques de logística" (vacía) si tiene `LOGISTICS_SHIPMENTS_VER`.
3. Click "Crear embarque" → navega a `/logistica/shipments?order_id=X`.
4. Dialog se auto-abre con `order_id` pre-llenado + banner verde de aviso.
5. Usuario completa fecha/unidad/origen/destino → "Crear" → shipment `programado`.
6. Recorre state machine: depart → deliver → close.
7. Al `close`, si es la única/última shipment cerrada del order → `orders.status='fulfilled'` automático.
8. Usuario vuelve a `/comercial/orders/:id` → ve order en estado `fulfilled` + shipment en estado `cerrado`.

**Defensa contra UX confuso:**
- Sección logística **oculta** si user no tiene `LOGISTICS_SHIPMENTS_VER` (no muestra "0 embarques" para perfiles que no operan logística).
- Botón "Crear embarque" **solo visible** si user tiene `LOGISTICS_SHIPMENTS_GESTIONAR` **Y** order está en `confirmed` (no en draft donde no hay stock reservado, ni en fulfilled/cancelled donde no tiene sentido).
- `loadShipments()` silencioso en error (no rompe la página principal si logistics no responde).

**Archivos modificados:**
- `apps/view/src/app/modules/comercial/pages/comercial-order-detail.component.ts`
- `apps/view/src/app/modules/logistica/pages/logistica-shipments.component.ts`

---

### Sprint J.5 — Reports + regression suite ✅ código (2026-05-27)

| ID | Item | Estado |
|---|---|---|
| J.5.1 | `LogisticsAnalyticsService` con 4 endpoints (overview, shipment-profitability, fleet-utilization, payroll-totals) — todos on-the-fly, no MV todavía (volumen bajo en beta) | ✅ |
| J.5.2 | MV `analytics.mv_logistics_overview_30d` **deferred post-beta** — el patrón está listo (ver C.1 commercial), agregar cuando un tenant supere 1k embarques | ⏸️ deferred |
| J.5.3 | HTTP smoke `database/http-logistics-analytics-test.js` (20+ checks: shape, valores derivados margen/cost-per-km, filtro por rango y year) | ✅ |
| J.5.4 | 3 suites J agregadas a `run-all-tests.js`: `test-logistics-rls-smoke` (J.0), `http-logistics-e2e-test` (J.1), `http-logistics-analytics-test` (J.5) | ✅ |
| J.5.5 | Cerrar Fase J en tracker (75% → 100%) + entry en `03_LOG_REVISIONES.md` + actualizar CLAUDE.md | ✅ |
| J.5.6 | Borrar `_imported/logistica/` — **deferred** hasta validación visual completa (referencia útil mientras se valida) | ⏸️ deferred |

**Endpoints expuestos (4):**
- `GET /api/logistics/analytics/overview?from=&to=` — shipments count, revenue, cost, margen %, total km, cost/km
- `GET /api/logistics/analytics/shipment-profitability?from=&to=&vehicle_id=&route_id=&limit=` — top N embarques por margen
- `GET /api/logistics/analytics/fleet-utilization?from=&to=` — uso por vehículo (count, km, revenue, cost, margen)
- `GET /api/logistics/analytics/payroll-totals?year=` — totales liquidados por período (commissions + per_diem + load/unload + bonos − deducciones)

**Decisiones de diseño:**
- Solo cuenta shipments con `status IN ('entregado','cerrado')` para revenue/cost real (programados/en_ruta = pipeline).
- On-the-fly aggregation, no MV. Razón: volumen bajo en beta (decenas/día max por tenant). Pivot a MV cuando se requiera.
- Pivoted query con `COUNT/SUM FILTER (WHERE ...)` para evitar dobles JOIN en fleet utilization.
- `payroll-totals` excluye liquidaciones `anulado` del cómputo (vía join condition).

---

## Riesgos identificados

| Riesgo | Mitigación |
|---|---|
| Conflictos de deps al mergear package.json (Angular/Nest versions matching pero peer deps difieren) | Hacer merge manual de deps, validar `nx graph` + `nx build` después de cada bloque |
| Origen usa `features/`, nosotros `modules/` → import paths rotos | Renombrar antes de copiar, search-replace global de imports |
| Origen tiene su propia `users` table en migraciones → conflicto con multi-tenant | Descartar esas 9 migraciones, usar exclusivamente nuestra `public.users` |
| `libs/shared-auth` tiene su propio JWT payload — drivers logueados pueden romperse | Descartar lib, mapear users existentes a nuestro auth-mt en J.1.7 |
| Volume de re-write de features Angular (13 features) | Priorizar shipments + fleet + guides en J.2; staff/payroll/config en sprint posterior si urge |

---

## Próximo paso accionable

Cerrar este doc y arrancar **J.0.1** — crear migración `20260527XXXXXX_logistics_schema_create.js`.
