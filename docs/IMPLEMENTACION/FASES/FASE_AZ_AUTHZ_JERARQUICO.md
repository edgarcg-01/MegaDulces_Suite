# Fase AZ — Autorización jerárquica (App → Proyecto → Módulo)

> **Estado:** 🔨 F0+F1+F2+F3 EN CÓDIGO (builds verdes) — F0 diseño ✅ · F1 permisos/guards/manifiesto ✅ · F2 backfill/seed ✅ (dry-run, sin aplicar) · F3 UI árbol tri-estado ✅ (build verde + validación visual OK). Pendiente: **aplicar migración F2 en deploy + re-login**, y F4 (limpieza, diferible).
> **ADR:** ADR-0XX (por crear al aprobar).
> **Origen:** el usuario pidió asignar permisos de un rol **por app, proyecto o módulo** en lugar de la lista plana de ~98 checkboxes actual.

---

## 1. Decisiones tomadas (contexto)

| Decisión | Elección | Implicación |
|---|---|---|
| Modelo de datos | **Bulk-toggle atómico** | El árbol es UI; se guarda como `Record<string,boolean>` atómico. El endpoint `PUT /catalogs/permissions/:role_name` NO cambia. |
| Cobertura | **3 apps unificadas** | Web (view), Vendedor (vendor), Portal B2B (portal). |
| Compartición | **Sin permisos compartidos** | Cada módulo (o app) tiene permisos dedicados. Rompe la compartición actual → hay que partir permisos, reapuntar guards/endpoints y hacer backfill. |
| Granularidad | **Ver + Gestionar por módulo** | 2 permisos por módulo. Acciones finas (crear/confirmar/surtir…) se conservan como sub-acciones bajo "Gestionar". |
| Definición de módulo | **Dominio lógico** | Sub-vistas afines se agrupan (ej. 13 vistas de analítica → 1 módulo "Analítica"). ~34 módulos en Web. |
| Vendedor / Portal | **Acceso general (entras / no entras)** | NO se desglosan por módulo. 1 solo permiso de acceso de app cada una. |

**Principio rector del backfill (nadie pierde acceso):** para cada rol, cada permiso **nuevo** se pone en `true` si el permiso **viejo** que gateaba ese módulo estaba en `true`. Determinista y reversible. Exige **re-login** (el permiso viaja en el JWT).

**Aditivo:** los permisos viejos NO se borran en esta fase; solo se dejan de usar en las rutas/endpoints reapuntados. La limpieza de huérfanos es F4 (diferible).

---

## 2. Taxonomía — APP 1: Plataforma Web (`apps/view`)

Leyenda: 🆕 = permiso nuevo a crear · `sub-acciones` cuelgan de **Gestionar**.

### Proyecto: Administración (`/admin`)

| Módulo | Rutas | Ver | Gestionar | Origen (viejo) |
|---|---|---|---|---|
| **Usuarios** | `/admin/users` | `USUARIOS_VER` | `USUARIOS_GESTIONAR` · `USUARIOS_PASSWORDS` | igual |
| **Roles y permisos** | `/admin/roles`, `/admin/roles/:r/permissions` | `ROLES_VER` 🆕 | `ROLES_CONFIGURAR` | `ROLES_CONFIGURAR` |

### Proyecto: Trade Marketing / Auditoría en ruta (`/dashboard`)

| Módulo | Rutas | Ver | Gestionar | Origen (viejo) |
|---|---|---|---|---|
| **Captura y visitas** | `captures`, `visits`, `exhibitions`, `home` | `VISITAS_VER` | `VISITAS_REGISTRAR` · `VISITAS_AUDITAR` | igual |
| **Reportes operativos** | `reports`, `dashboard` | `REPORTES_VER_PROPIO` · `REPORTES_VER_EQUIPO` · `REPORTES_VER_GLOBAL` ⚠️ | `REPORTES_EXPORTAR` · `REPORTES_GESTIONAR` | igual |
| **Seguimiento en ruta** | `seguimiento` | `VER_SEGUIMIENTO` | — | igual |
| **Análisis de rutas** | `routes`, `live-map`, `vendor-history`, `field-map` | `RUTAS_VER` | — | igual |
| **Mapa comercial y prospección** | `commercial-map`, `field-map` | `COMMERCIAL_MAP_VER` · `COMMERCIAL_MAP_PROSPECTS_VER` | `COMMERCIAL_MAP_PROSPECTS_GESTIONAR` | igual |
| **Supervisor AI (Horus)** | `supervisor-ai` | `SUPERVISOR_AI_VER` | `SUPERVISOR_AI_APROBAR` | igual |
| **Tiendas** | `stores` | `TIENDAS_VER` | `TIENDAS_CREAR` | igual |
| **Catálogos de captura** | `admin/catalogs/:type` | — | `CATALOGO_GESTIONAR` | `CATALOGO_GESTIONAR` (se parte de Productos) |
| **Scoring** | `admin/scoring` | `SCORING_CONFIG_VER` | `SCORING_CONFIG_GESTIONAR` | igual |
| **Planogramas** | `admin/planograma` | — | `PLANOGRAMAS_GESTIONAR` | igual |
| **Agenda de rutas** | `daily-assignments` | `TRADE_ROUTE_PLAN_VER` 🆕 | `TRADE_ROUTE_PLAN_GESTIONAR` 🆕 | `USUARIOS_ASIGNAR_RUTA` (se parte de Cartera) |

> ⚠️ `REPORTES_VER_GLOBAL` concede `manage:all` (god-mode) en la ability factory. Se mantiene como sub-opción marcada CRÍTICA; no es un simple "ver".

### Proyecto: Comercial / Ventas (`/comercial`)

| Módulo | Rutas | Ver | Gestionar | Origen (viejo) |
|---|---|---|---|---|
| **Pedidos** | `command-center`, `orders`, `orders/history`, `orders/:id` | `COMMERCIAL_ORDERS_VER` | `COMMERCIAL_ORDERS_CREAR` · `_CONFIRMAR` · `_CANCELAR` · `_FULFILL` · `COMMERCIAL_PAYMENTS_REGISTRAR` | igual |
| **Analítica comercial** | `dead-stock`, `inventory-health`, `customers-360`, `sell-out`, `salidas`, `ventas-por-ruta`, `historical` | `COMMERCIAL_ANALYTICS_VER` 🆕 | — | se parte de `COMMERCIAL_ORDERS_VER` |
| **Clientes** | `customers` | `COMMERCIAL_CUSTOMERS_VER` | `COMMERCIAL_CUSTOMERS_GESTIONAR` | igual |
| **Cartera / asignación** | `cartera` | `COMMERCIAL_CARTERA_VER` 🆕 | `COMMERCIAL_CARTERA_GESTIONAR` 🆕 | se parte de `USUARIOS_ASIGNAR_RUTA` |
| **Inventario** | `inventory`, `inventory/expiring` | `COMMERCIAL_INVENTORY_VER` | `COMMERCIAL_INVENTORY_AJUSTAR` | igual |
| **Almacenes** | `warehouses` | `COMMERCIAL_WAREHOUSES_VER` | `COMMERCIAL_WAREHOUSES_GESTIONAR` | igual |
| **Inventario físico** | `inventory/count`, `inventory/sessions*`, `inventory/ira`, `inventory/abc`, `inventory/aisles`, `.../teams` | `COMMERCIAL_INVENTORY_SUPERVISAR` | `COMMERCIAL_INVENTORY_CONTAR` · `_RECONCILIAR` · `_ASIGNAR` | igual |
| **Precios** | `pricing` | `COMMERCIAL_PRICING_VER` | `COMMERCIAL_PRICING_GESTIONAR` | igual |
| **Promociones** | `promotions`, `empuje`, `erp-promos` | `COMMERCIAL_PROMOTIONS_VER` | `COMMERCIAL_PROMOTIONS_GESTIONAR` | igual (`erp-promos` deja `ORDERS_VER`) |
| **Productos** | `products` | `COMMERCIAL_PRODUCTS_VER` 🆕 | `COMMERCIAL_PRODUCTS_GESTIONAR` 🆕 | se parte de `CATALOGO_GESTIONAR` |
| **Thot / IA comercial** | `thot-chat`, `thot-curation` | `COMMERCIAL_THOT_VER` 🆕 | `COMMERCIAL_THOT_GESTIONAR` 🆕 | `chat`←`ORDERS_VER`, `curation`←`CUSTOMERS_GESTIONAR` |
| **Control de ruta / tickets** | `route-tickets`, `vendor-sales` | `ROUTE_CONTROL_VER` | — | igual |

### Proyecto: Logística (`/logistica`)

| Módulo | Rutas | Ver | Gestionar | Origen (viejo) |
|---|---|---|---|---|
| **Embarques** | `dashboard`, `shipments`, `shipments/:id`, `checklists`, `photos`, `planner`, `my-assignments`, `reports` | `LOGISTICS_SHIPMENTS_VER` | `LOGISTICS_SHIPMENTS_GESTIONAR` | igual |
| **Guías** | `guides` | `LOGISTICS_GUIDES_VER` | `LOGISTICS_GUIDES_GESTIONAR` | igual |
| **Flotilla y personal** | `fleet`, `staff`, `live` | `LOGISTICS_FLEET_VER` | `LOGISTICS_FLEET_GESTIONAR` | igual |
| **Costos** | `costs` | `LOGISTICS_EXPENSES_VER` | `LOGISTICS_EXPENSES_GESTIONAR` | igual |
| **Liquidaciones / nómina** | `payroll` | `LOGISTICS_PAYROLL_VER` | `LOGISTICS_PAYROLL_GESTIONAR` | igual |
| **Carta Porte** | *(acción en embarques)* | `LOGISTICS_CARTAPORTE_VER` | `LOGISTICS_CARTAPORTE_GESTIONAR` | igual |
| **Traspasos** | `traspasos` | `LOGISTICS_TRANSFERS_VER` 🆕 | — | se parte de `COMMERCIAL_ORDERS_VER` |
| **Configuración** | `config` | — | `LOGISTICS_CONFIG_GESTIONAR` | igual |

### Proyecto: Televenta (`/televenta`)

| Módulo | Rutas | Ver | Gestionar | Origen (viejo) |
|---|---|---|---|---|
| **Televenta** | `dashboard`, `queue`, `my`, `lead/:id`, `take-order` | `COMMERCIAL_TELEVENTA_VER` | `COMMERCIAL_TELEVENTA_OPERATE` | igual |

---

## 3. Taxonomía — APP 2: Vendedor (`apps/vendor`) — acceso general

**1 solo permiso:** `VENDOR_APP_ACCESS` (entras / no entras).

- El árbol muestra la app Vendedor como un **toggle único**, sin desglose de módulos.
- Los permisos operativos que la app consume internamente (`CAPTURE_TICKET_USE`, `ROUTE_TICKET_CAPTURE` y los comerciales de pedidos) **se otorgan al rol `vendedor` por seed**, no se togglean por módulo aquí. El árbol controla el **acceso**; las capacidades internas del vendedor son fijas del rol.
- Esto evita reintroducir compartición: `COMMERCIAL_ORDERS_CREAR` etc. tienen su hogar en Comercial → Pedidos; el rol vendedor simplemente los posee además de `VENDOR_APP_ACCESS`.

---

## 4. Taxonomía — APP 3: Portal B2B (`apps/portal`) — acceso general

**1 solo permiso:** `PORTAL_B2B_ACCESS` 🆕 (entras / no entras).

- Hoy el portal gatea **por rol** (`customer_b2b`), no por permiso. Se crea `PORTAL_B2B_ACCESS` para uniformar bajo el mismo modelo.
- `customerB2bGuard` se actualiza para aceptar el permiso **además** del rol (compat), en F1.
- Igual que Vendedor: toggle único, sin desglose.

---

## 5. Permisos NUEVOS a crear (🆕)

| Permiso | Reemplaza el uso de | En |
|---|---|---|
| `ROLES_VER` | (lectura de `ROLES_CONFIGURAR`) | Admin → Roles |
| `COMMERCIAL_ANALYTICS_VER` | `COMMERCIAL_ORDERS_VER` (7 vistas) | Comercial → Analítica |
| `COMMERCIAL_CARTERA_VER` / `_GESTIONAR` | `USUARIOS_ASIGNAR_RUTA` (cartera) | Comercial → Cartera |
| `COMMERCIAL_PRODUCTS_VER` / `_GESTIONAR` | `CATALOGO_GESTIONAR` (products) | Comercial → Productos |
| `COMMERCIAL_THOT_VER` / `_GESTIONAR` | `COMMERCIAL_CUSTOMERS_GESTIONAR` (chat admin + curación; NO de ORDERS_VER, para no abrir Thot a vendedores) | Comercial → Thot |
| `TRADE_ROUTE_PLAN_VER` / `_GESTIONAR` | `USUARIOS_ASIGNAR_RUTA` (daily-assignments) | Trade → Agenda de rutas |
| `LOGISTICS_TRANSFERS_VER` | `COMMERCIAL_ORDERS_VER` (traspasos) | Logística → Traspasos |
| `PORTAL_B2B_ACCESS` | rol `customer_b2b` | App Portal |

**Total permisos web:** ~34 módulos → ~72 permisos ver/gestionar (vs 98 planos actuales, mejor organizados).

---

## 6. Mapeo viejo → nuevo (tabla de backfill)

Reglas para la migración de `role_permissions.permissions` por rol. `X → {A, B}` significa: si el rol tenía `X=true`, ahora recibe `A=true` y `B=true`.

| Permiso viejo | Deriva a (nuevos que hay que sembrar si estaba en true) |
|---|---|
| `COMMERCIAL_ORDERS_VER` | `COMMERCIAL_ORDERS_VER` (se conserva, ahora solo Pedidos) **+** `COMMERCIAL_ANALYTICS_VER` 🆕 **+** `LOGISTICS_TRANSFERS_VER` 🆕 |
| `USUARIOS_ASIGNAR_RUTA` | `COMMERCIAL_CARTERA_VER` + `_GESTIONAR` 🆕 **+** `TRADE_ROUTE_PLAN_VER` + `_GESTIONAR` 🆕 |
| `CATALOGO_GESTIONAR` | `CATALOGO_GESTIONAR` (se conserva, catálogos captura) **+** `COMMERCIAL_PRODUCTS_VER` + `_GESTIONAR` 🆕 |
| `COMMERCIAL_CUSTOMERS_GESTIONAR` | `COMMERCIAL_CUSTOMERS_GESTIONAR` (se conserva) **+** `COMMERCIAL_THOT_VER` + `COMMERCIAL_THOT_GESTIONAR` 🆕 |
| `ROLES_CONFIGURAR` | `ROLES_CONFIGURAR` (se conserva) **+** `ROLES_VER` 🆕 |
| *rol `customer_b2b`* | `PORTAL_B2B_ACCESS` 🆕 |
| *(todos los demás)* | sin cambios (1:1) |

Todo lo no listado mapea 1:1 (mismo nombre, mismo valor).

### Nota: `commercial-intelligence` es infraestructura transversal, no un módulo

El controller `commercial-intelligence` (motor Thot: `suggest`, `nba`, `signals`, `customer-360`, `findings`, `diagnoses`, `actions`, `learning`, `autonomy`, `directives`, chats de portal/vendedor) lo consumen **admin + portal + vendedor** con permisos que esos roles ya tienen (`ORDERS_VER`, `ORDERS_CREAR`, `CUSTOMERS_VER`, `CUSTOMERS_GESTIONAR`, `PROMOTIONS_*`). Reapuntarlo entero rompería portal/vendedor. Por eso **solo se reapuntó lo que es la UI admin de Thot**: `thot/chat` → `COMMERCIAL_THOT_VER` y `thot/examples*` (curación) → `COMMERCIAL_THOT_GESTIONAR`. El resto del motor conserva sus permisos base a propósito (deuda consciente, revisable por endpoint en una sub-fase si se quisiera aislar más).

---

## 7. Plan de fases

- **F0 — Taxonomía + mapeo** *(este documento)* — ✅
- **F1 — Permisos + guards + manifiesto** — ✅
  - ✅ 12 permisos 🆕 en el enum `Permission` (backend [libs/platform-core](../../../libs/platform-core/src/lib/constants/permissions.ts) + frontend [apps/view](../../../apps/view/src/app/core/constants/permissions.ts)). `shared-auth` es legacy reducido → **no se toca**. Se integraron además los 3 permisos de Fase LM que aparecieron en el enum.
  - ✅ metadata en `permission-meta.ts` (labels/descripciones/categorías).
  - ✅ manifiesto [`AUTHZ_TREE`](../../../apps/view/src/app/core/constants/authz-tree.ts) — fuente de verdad, 3 apps, ~34 módulos, 80/80 permisos cubiertos.
  - ✅ `permissionGuard(...)` de rutas reapuntadas (analítica, promos, thot, cartera, products, agenda de rutas, traspasos, roles-ver).
  - ✅ `@RequirePermissions(...)` backend: `commercial-analytics`→ANALYTICS, `commercial-products`→PRODUCTS, `daily-assignments`→TRADE_ROUTE_PLAN, `commercial-vendor-routes`(cartera)→CARTERA, `catalogs`(GET perms)→ROLES_VER, `commercial-intelligence`(chat/curación admin)→THOT. Endpoints de vendedor/portal NO tocados.
  - ✅ Guard de completitud: [`scripts/check-authz-tree.js`](../../../scripts/check-authz-tree.js) (apps/view no tiene runner de tests → script, no `.spec`).
- **F2 — Backfill + seed** — ✅ (código listo, migración NO aplicada aún)
  - ✅ Migración idempotente [`20260702190000_az_backfill_hierarchical_perms.js`](../../../database/migrations-newdb/20260702190000_az_backfill_hierarchical_perms.js): deriva cada permiso nuevo del origen por rol (`permissions -> 'KEY' IS NULL` + `jsonb_build_object`). **Excluye `customer_b2b`** de `ANALYTICS_VER`/`TRANSFERS_VER` (rol externo con ORDERS_VER scoped, no debe ver analítica interna).
  - ✅ Seed newdb [`02_mega_dulces_initial_roles.js`](../../../database/seeds-newdb/02_mega_dulces_initial_roles.js) con helper `withDerivedAz` (seed == migración).
  - ✅ Dry-run verificado contra `.245` (transacción + ROLLBACK): derivación correcta por rol, `customer_b2b` solo `PORTAL_B2B_ACCESS`.
  - ⏳ **Pendiente operacional:** aplicar `migrate:latest` en deploy + **re-login obligatorio** (los permisos viajan en el JWT). No aplicada localmente para no arrastrar migraciones pendientes de otros threads.
  - Seed legacy (`database/seeds/00_roles.js`) sin tocar — el sistema activo es newdb (post-cutover).
- **F3 — UI de árbol tri-estado** — ✅ (build verde; validación visual manual pendiente)
  - ✅ [admin-roles-permissions.component.ts](../../../apps/view/src/app/modules/dashboard/admin-roles/admin-roles-permissions.component.ts) reescrito como árbol App → Proyecto → Módulo → acción, con checkbox tri-estado (all/some/none) y cascada. Árbol **custom** (signals) en vez de `p-tree`: da control sobre disabled-por-hoja (anti-escalation), marcado de críticos y colapso por proyecto. Apps Vendedor/Portal = un solo toggle de acceso.
  - ✅ Conserva **anti-escalation** (hoja bloqueada si el editor no puede otorgarla; cascada solo otorga lo permitido), **críticos** (confirm dialog + marca visual), **dirty tracking**, y guardado que **colapsa al mismo `Record<string,boolean>`** (endpoint sin cambios).
  - Vista resumen `admin-roles-grid` NO tocada: sigue agrupando por categoría de `permission-meta` (los permisos nuevos ya tienen meta) — reagruparla por app/proyecto queda para F4.
- **F4 — Limpieza** *(diferible)*
  - `/projects` deriva del manifiesto.
  - Retiro de permisos viejos ya huérfanos (con confirmación).

---

## 7bis. Continuación — Independencia total de módulos (2026-07-17)

> **Origen:** el usuario pidió que *cada módulo/submódulo sea autosuficiente* — p.ej. "para asignar en reparto solo necesito el permiso de reparto, no ver pedidos ni productos". Auditoría de los 68 controllers + frontend (4 agentes). Decisiones: **una permission por feature** + **OR de permisos** para utilitarios compartidos. Termina la "deuda consciente" que AZ dejó (reparto/carga/movimientos + fugas sueltas).

**Infra nueva:** decorador `@RequireAnyPermission(...)` (OR) + soporte en `RolesGuard` (antes solo AND). Para utilitarios que consumen varios módulos (ej. `store/ticket-lookup` lo usan Tienda y Reparto).

**Clusters resueltos (todos con build api+view+vendor verde + migración backfill idempotente/aditiva):**

| Cluster | Antes | Ahora | Migración |
|---|---|---|---|
| **Reparto** (proyecto propio `REPARTO_*`) | ORDERS_FULFILL+PAYMENTS_REGISTRAR+SHIPMENTS_VER+HOME_DISPATCH | `REPARTO_DESPACHAR` (tienda) + `REPARTO_ENTREGAR` (repartidor) | `20260717120000` |
| Fugas sueltas | stores·delete=CATALOGO / captures·delete=REPORTES_GESTIONAR / visits·list=REPORTES_VER_PROPIO | TIENDAS_CREAR / VISITAS_AUDITAR / VISITAS_VER | `20260717121000` |
| **Carga** | ORDERS_VER/FULFILL | `COMMERCIAL_CARGA_VER/GESTIONAR` | `20260717122000` |
| **Movimientos** | INVENTORY_VER/SUPERVISAR | `COMMERCIAL_MOVEMENTS_VER/GESTIONAR` | `20260717122000` |
| **vendor-routes** | CUSTOMERS_VER+VISITAS_REGISTRAR+ORDERS_CREAR | todo el flujo del vendedor → `COMMERCIAL_CARTERA_VER` (admin sigue en `_GESTIONAR`; el vendedor NO reasigna) | `20260717123000` (upgrade-safe vs AZ) |
| **Telemetry** portal/summary | `REPORTES_VER_GLOBAL` (⚠️ god-mode) | `COMMERCIAL_ANALYTICS_VER` | — (reusa) |
| **Fiscal** impuestos/materialidad | FISCAL_DIOT_VER / FISCAL_LISTAS_VER | `FISCAL_IMPUESTOS_VER` / `FISCAL_MATERIALIDAD_VER` | `20260717124000` |

`LOGISTICS_HOME_DISPATCH` → LEGACY (no se borra; retiro en F4). `rider.guard` (vendor) pasó a `REPARTO_ENTREGAR` — corrige de paso un bug latente (`jefe_de_tienda` se clasificaba como repartidor). `check-authz-tree`: enum↔tree completos (122/122, sin missing/orphan).

**Dejado como está (con rationale):**
- `estatus/check` = `FISCAL_CFDI_VER` — consultar estatus SAT de un CFDI ES operación del módulo CFDI, no un módulo aparte.
- **commercial-intelligence** (nba/signals/customer-360/findings/…) = ORDERS_VER/CUSTOMERS_* — infra transversal que consumen portal+vendedor+admin (deuda consciente, decisión del usuario).
- **Maat/Hallazgos** comparten `FINANCE_AI_CHAT`/`FINANCE_FINDINGS_GESTIONAR` — dos superficies de la misma capacidad Finanzas-AI (mismo criterio que intelligence).
- `ai-product-matcher` (utilitario, gateado por el contexto que lo usa), `push/ticket-reminders` (dominio route-control), `vendor-sales·crear` (familia capture), `daily-assignments/me` (self-service documentado).

**Finding nuevo (fuera de scope):** `LogisticsFleetController` no tiene `@RequirePermissions` en ningún endpoint → CRUD de flota abierto a cualquier autenticado. Registrar en auditoría.

**⏳ Pendiente operacional:** aplicar las 5 migraciones nuevas (`20260717120000`–`124000`) + la de AZ `20260702190000` (aún sin aplicar) + **re-login** (los permisos viajan en el JWT; la autz backend es fresca con cache 30s).

---

## 8. Decisiones abiertas para validar

1. **Nombres de los 🆕** — ¿OK el estilo `COMMERCIAL_*` / `TRADE_*` / `LOGISTICS_*` de §5?
2. **`REPORTES_VER_GLOBAL` = god-mode** — hoy concede `manage:all`. ¿Se queda como está (marcado crítico) o se desacopla del god-mode en esta fase?
3. **Vendedor internos** — ¿confirmas que las capacidades del vendedor (crear pedido, capturar) quedan fijas del rol `vendedor` por seed y NO como toggles del árbol?
4. **Portal guard** — ¿migro `customerB2bGuard` a aceptar `PORTAL_B2B_ACCESS` (además del rol), o lo dejo rol-only y `PORTAL_B2B_ACCESS` queda informativo?
5. **Control de ruta / Carta Porte** — ¿les agrego "Gestionar" o se quedan solo-lectura por ahora?
