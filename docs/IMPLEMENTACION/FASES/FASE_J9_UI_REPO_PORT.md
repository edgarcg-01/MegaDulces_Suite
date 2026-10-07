# Fase J.9 — Port de UI completa desde repo `_imported/logistica/`

> **Objetivo**: traer toda la UI del repo origen (12 features) al monorepo. Lo que tenemos en J.0-J.8 cubre backend + UI básica; falta el look-and-feel + features especializadas que existían en la app monolítica.
>
> **Fecha inicio**: 2026-05-27
> **Estado**: 🔨 EN CÓDIGO (incremental, multi-sesión)

---

## Inventario del repo origen

Fuente: `_imported/logistica/apps/logistica-view/src/app/features/`

| # | Feature | Path | LOC .ts | Estado backend monorepo | Estado UI monorepo | Acción J.9 |
|---|---|---|---|---|---|---|
| 1 | shipments + shipment-form | `features/shipments/` | ~350 | ✅ existe | 🟡 versión básica (`logistica-shipments`, `logistica-shipment-detail`) | **J.9.10** — extender form con FormArray labor-assignment |
| 2 | guides | `features/guides/` | ~80 | ✅ `logistics-guides` | ❌ no hay page dedicada | **J.9.3** — crear page |
| 3 | fleet (+ check-in/check-out) | `features/fleet/` | ~250 | ✅ `logistics-fleet` | 🟡 básico | **J.9.9** — agregar check-in/out + maintenance |
| 4 | staff | `features/staff/` | ~80 | ✅ `logistics-fleet/drivers` (reuso) | ❌ no hay page dedicada | **J.9.2** — crear page |
| 5 | costs | `features/costs/` | ~70 | ✅ `logistics-expenses` | ❌ no hay page dedicada | **J.9.4** — crear page |
| 6 | reports (jsPDF frontend) | `features/reports/` | ~80 | ✅ `logistics-reports` (backend con jspdf) | 🟡 versión básica (mía) | **J.9.5** — extender con análisis por embarque + unidad |
| 7 | driver-assignments | `features/driver-assignments/` | ~80 | ✅ `logistics-shipments` | ❌ no hay page dedicada | **J.9.7** — crear page mobile-first |
| 8 | dashboard | `features/dashboard/` | ~80 | ✅ `logistics-analytics` | ❌ no hay page dedicada | **J.9.1** — crear page con KPI cards + shimmer |
| 9 | delivery-wizard (shared component) | `shared/components/delivery-wizard/` | ~80 | parcial | ❌ no existe | **J.9.6** — crear componente 7 pasos |
| 10 | admin/users | `features/admin/users/` | ~80 | N/A (admin global ya existe) | ✅ ya cubierto en monorepo | skip |
| 11 | profile/settings/password | varios stubs | — | — | — | skip (stubs en repo) |
| 12 | config | `features/config/` | ~80 | ✅ `logistics-config` | 🟡 básico | **J.9.8** — agregar TabView 5 tabs (Comisiones, Factores, Costos, Viáticos, Tarifas) |
| 13 | auth/login | `features/auth/login/` | ~73 | ✅ `auth-mt` | ✅ ya existe | skip |
| 14 | projects | `features/projects/` | ~80 | N/A | ✅ ya existe en `/projects` | skip |

---

## Patrones globales a portar

Del análisis del repo:

- **CSS variables custom**: `--logistics-surface`, `--logistics-border`, `--logistics-text`, `--brand` (orange #f5a623), `--kpi-purple|green|orange|blue|red`.
- **KPI cards** con `animate-shimmer` para loading.
- **Topbar + Sidebar** específicos del módulo logística (vs el layout default del monorepo). DECISIÓN: mantener el layout actual del monorepo (sidebar con permission-gated nav) en lugar de portar el del repo. Los colores los podemos adoptar.
- **Shared components** del repo: `FormFieldComponent`, `LaborAssignmentComponent`, `PhotoUploadComponent`, `ChecklistComponent`, `PageHeaderComponent`, `FilterBarComponent`, `DeliveryWizardComponent`. La mayoría reusable, algunos hay que reescribir.

---

## Sub-items (incremental)

| Item | Descripción | Prioridad | Estado |
|---|---|---|---|
| J.9.0 | Plan doc (este archivo) | — | ✅ |
| J.9.1 | Dashboard logística operacional (4 KPI cards + shimmer + Top embarques + Fleet utilization) | Alta | ✅ |
| J.9.2 | Staff/Personal page (CRUD drivers, KPIs Total/Activos/Suspendidos, MultiSelect roles, avatar circular) | Alta | ✅ |
| J.9.3 | Guides page dedicada (5 KPIs por estado, filtros search+status+driver con computed signal, drill-down al shipment) | Alta | ✅ |
| J.9.4 | Costs page (5 KPIs agregados + tabla 14 cols + edit dialog 10 categorías de costos, endpoint findAll nuevo) | Alta | ✅ |
| J.9.5 | Reports avanzado (análisis por embarque + por unidad + jsPDF frontend) | Media | ⬜ (deferred) |
| J.9.6 | DeliveryWizard component (7 pasos shared) | Media | ⬜ (deferred) |
| J.9.7 | Driver Assignments page (mobile-first con cards + wizard) | Media | ⬜ (deferred) |
| J.9.8 | Config TabView con 5 tabs (Comisiones, Factores, Costos, Viáticos, Tarifas) | Media | ⬜ (deferred) |
| J.9.9 | Fleet con check-in/check-out + maintenance log | Media | ⬜ (deferred) |
| J.9.10 | Shipment Form con FormArray labor-assignment | Media | ⬜ (deferred) |
| J.9.11 | Theme: adoptar CSS variables del repo (brand orange, KPI colors) | Baja | ⬜ (deferred) |

**Sesión actual (2026-05-27)**: J.9.0–J.9.4 ✅ cerrados.

## Resumen sesión 2026-05-27

**4 páginas standalone nuevas** (~1100 LOC frontend) + 1 endpoint backend nuevo (`GET /logistics/expenses` list all):

- `/logistica/dashboard` → KPI cards (volumen, ingreso, costo, margen) con shimmer loading + Top 10 embarques por margen + Utilización por unidad. Consume `analytics/overview`, `analytics/shipment-profitability`, `analytics/fleet-utilization` con `forkJoin`.
- `/logistica/staff` → CRUD personal con KPIs (Total/Activos/Suspendidos/Inactivos), avatares circulares con color hash por nombre, MultiSelect de roles `chofer|ayudante|cargador`, filtros search + role. Reusa `/logistics/fleet/drivers`.
- `/logistica/guides` → Lista global de guías (sin necesidad de abrir shipment), 5 KPIs por estado + total comisiones acumuladas, filtros search/status/driver con `computed` signal, drill-down al shipment.
- `/logistica/costs` → 5 KPIs (count + total + combustible + casetas + viáticos), tabla con 14 columnas (folio, fecha, destino, placa, km, 5 categorías costos, operativo, costo/km, TOTAL, estado), edit dialog con 10 categorías + `apply_config_km`.

**Backend**: `LogisticsExpensesService.findAll({ from, to, limit })` + `GET /logistics/expenses` controller endpoint. JOIN con shipments + vehicles, ordena por shipment_date DESC.

**Service frontend**: 4 nuevos métodos en `LogisticaService` (`analyticsOverview`, `shipmentProfitability`, `fleetUtilization`, `listExpenses`, `expensesSummary`) + 5 interfaces nuevas (`AnalyticsOverview`, `ShipmentProfitabilityRow`, `FleetUtilizationRow`, `ExpenseRow`, `ExpenseSummary`).

**Nav menu**: extendido a 9 items (Dashboard | Embarques | Guías | Costos | Reportes | Flotilla | Personal | Liquidaciones | Configuración). Default redirect cambió de `shipments` → `dashboard`.

**Build OK**: `nx build view` + `nx build api` ambos exitosos.

## Pendiente sesiones futuras (J.9.5–J.9.11)

- **J.9.5** — Reports avanzado con análisis por embarque + por unidad + jsPDF frontend. ~150 LOC.
- **J.9.6** — DeliveryWizard component compartido (7 pasos con `p-steps`, modal 900px, integra checklist+photos+status). ~250 LOC.
- **J.9.7** — Driver Assignments page mobile-first responsive (cards en móvil, tabla en desktop, integra wizard). ~200 LOC.
- **J.9.8** — Config con `p-tabs` y 5 tabs (Comisiones por ruta, Factores por región, Costos por unidad, Viáticos, Tarifas maniobra). ~300 LOC.
- **J.9.9** — Fleet con check-in/check-out de unidades + history de uso + maintenance log. ~300 LOC.
- **J.9.10** — Shipment Form rico con FormArray para labor-assignment, auto-folio, dialog 800px. ~400 LOC.
- **J.9.11** — Theme adoptar CSS variables del repo origen (brand orange + KPI colors purple/green/orange).
