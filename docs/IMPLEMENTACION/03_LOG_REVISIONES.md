# Log de Revisiones

> Audit log: cada vez que se revisa código, se cierra un checkpoint, o se valida una fase completa, queda registrado aquí.
>
> Útil para: recordar qué se validó, cuándo, qué problemas se encontraron, qué decisiones se tomaron en review.

---

## 2026-05-27 — Sprint UX/UI paso 3 + paso 3.5 (codemod inline TS styles)

**Item revisado:** continuación del Sprint UX/UI después de paso 2.

**Paso 3 — Charts dinámicos**: cuando fui a refactorizar, descubrí que **ya estaba implementado**. `apps/view/src/app/shared/theme/chart-theme.ts` expone `getChartTokens()` que resuelve 27 tokens (`--chart-1..8`, `--ok-fg`, `--warn-fg`, `--bad-fg`, `--info-fg`, surfaces, brand) via `getComputedStyle(document.documentElement)` con fallback SSR (light). 7 componentes ya lo consumen: `home`, `reports`, `seguimiento`, `reports/graphics/reports`, `reports/graphics/dashboard`, `routes-tab`. Grep de hex hardcoded en estos archivos: **0**. Dark mode en charts funciona automáticamente.

**Paso 3.5 (sin numerar en el plan original) — Inline `styles: [...]` cleanup**: al validar paso 3, un grep global mostró 98 hex literales en 20 TS files. La mayoría no son chart configs sino estilos de componentes inline. Refactor de los top offenders:

- **`logistica-dashboard.component.ts`** (12 hex en `.kpi-purple/.kpi-green/.kpi-orange/.kpi-positive/.kpi-negative` + `.pos/.neg` para deltas): reemplazos a `var(--chart-3)` (purple), `var(--ok-fg)`, `var(--warn-fg)`, `var(--bad-fg)`.
- **`comercial-promotions.component.ts`** (10 hex en theme-monochrome overrides + form em + hint): los `.type-card` monochrome ahora usan `var(--card-bg|border-color|text-main|text-muted)` (theme-aware solo), borde hover usa `var(--brand-400)`. Las `.hint` ahora usan `var(--info-soft-bg)` + `var(--info-soft-fg)` (semantic) eliminando el override `:host ::ng-deep .theme-monochrome .hint` que ya no hace falta.
- **`comercial-customers/warehouses/pricing/inventory`** + **`logistica-staff/shipments/shipment-detail`**: patrón uniforme `.form em #ef4444` → `var(--bad-fg)`, `.warn-banner #fef3c7/#92400e` → `var(--warn-soft-bg)/var(--warn-soft-fg)`, `.link-banner rgba(34,197,94,.1)/#166534` → `var(--ok-soft-bg)/var(--ok-soft-fg)`, `.hint rgba(59,130,246,.08)/#1e3a8a` → `var(--info-soft-bg)/var(--info-soft-fg)`, `.kpi-green #16a34a` → `var(--ok-fg)`, `.kpi-orange #f5a623` → `var(--warn-fg)`, `.delta-preview .up #16a34a / .down #dc2626` → semantic.

**Reducción**: ~30 hex literales eliminados de inline styles. Quedan ~64 en archivos secundarios (vendor shells, televenta pages, portal login, promotions-meta, logistica-fleet/payroll/guides/reports/costs) — siguiente iteración.

**Build view fresh**: pasó (`nx build view --skip-nx-cache`). Durante el build descubrí que `logistica-fleet.component.ts` (untracked, J.9.9 incompleto) tenía el template referenciando métodos no declarados; Edgar agregó los handlers en paralelo durante la sesión y el build pasó.

**Regression suite**: 19/19 verde, ~26s.

**Pendientes del Sprint UX/UI**: paso 4 (tema PrimeNG custom → bajar 347 `!important`), paso 5 (eliminar aliases legacy `--brand-primary`/`--status-*`), paso 6 (lint rule CI), paso 3.5 fase 2 (~64 hex restantes en TS files no atacados aún).

**Próximo:** continuar con paso 3.5 fase 2 (terminar inline TS styles) o atacar paso 4 (PrimeNG theme — más ambicioso).

---

## 2026-05-27 — Sprint UX/UI paso 2 + cleanup scoring legacy

**Item revisado:** post K-debt, dos tracks paralelos.

**Track A — Cleanup scoring legacy** (deuda menor descubierta durante audit K-debt):

- Renombré todas las referencias `scoring_pesos` → `scoring_weights` en `catalogs.service.ts` (5 refs) y `scoring-v2.service.ts` (3 refs). La tabla `scoring_weights` existe en multi-tenant con mismas columnas (`tipo`/`nombre`/`valor`); solo cambió el nombre.
- Wrappé las queries a `combinaciones_validas` con guard defensivo (catch `42P01` "relation does not exist"). Sin la tabla, `isReferenced` no bloquea hard-delete de scoring items (returns false) y `validarCombinacion` permite siempre (returns true). Si en el futuro restauramos la tabla, el código vuelve al comportamiento de validación original sin más cambios.
- Build api + regression suite: 19/19 verde.

**Track B — Sprint UX/UI paso 2** (codemod HTMLs):

- Auditoría real: 18 hits hardcoded de clases Tailwind (`text-red-500`, `bg-blue-500`, etc.) en 6 HTMLs, no 200+ como anticipaba el plan inicial. Probable que los hits adicionales estuvieran en .ts/.scss/inline styles, no HTMLs.
- Files refactorizados: `offline-status.component.html` (6), `login.component.html` (5), `stores-tab.component.html` (4), `daily-assignments.component.html` (1), `visits.component.html` (1). `layout.component.html` tenía un hit en un comentario histórico — no se tocó.
- Mapeos aplicados:
  - `text-red-{500,600}` → `text-bad-fg`
  - `text-green-{500,600}` → `text-ok-fg`
  - `text-blue-500` → `text-info-fg`
  - `text-amber-500` / `text-orange-500` (warning context) → `text-warn-fg`
  - `text-purple-500` (decorativo, no semántico) → `text-chart-3`
  - `bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400` (error box) → `bg-bad-soft-bg border-bad-border text-bad-soft-fg`
  - `border-red-400 focus:border-red-400` (form invalid) → `border-bad-fg focus:border-bad-fg`
- Verificación: grep posterior devuelve 0 hits hardcoded en HTMLs. `nx build view` OK (sólo warnings pre-existentes de jspdf/html2canvas, unrelated).

**Pendientes del Sprint UX/UI:** paso 3 (charts dinámicos en `reports.component.ts` + `home.component.ts`), paso 4 (tema PrimeNG custom para reducir 347 `!important`), paso 5 (eliminar aliases legacy `--brand-primary`/`--status-*`), paso 6 (lint rule CI). Validación visual (light + dark) pendiente — requiere levantar dev server, Edgar controla.

**Próximo:** continuar con paso 3 del sprint UX/UI (charts dinámicos) o cualquier otra prioridad que Edgar elija.

---

## 2026-05-27 — K-debt cerrado: refactor servicios legacy (activo → deleted_at)

**Item revisado:** post Fase K, eliminar las escrituras a la columna virtual `activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED` que el shim había agregado a 12 tablas multi-tenant.

**Bug raíz detectado durante audit:** `CatalogsService` y `StoresService` hacían `insert({ activo: true, ... })` e `update({ activo: false, ... })` sobre `zones` y `catalogs`. Postgres rechaza writes a columnas GENERATED ALWAYS → cualquier intento de crear una zona nueva (admin → Catálogos → +Zona) o de soft-delete una zona referenciada por capturas tiraba error. Caso no exercised por smoke suite hasta ahora — descubrimiento durante mapeo K-debt.

**Refactor aplicado:**

- `apps/api/src/modules/catalogs/catalogs.service.ts`
  - Insert de zonas: removido `activo: true` (default es `deleted_at NULL`).
  - Soft-delete de zonas referenciadas (líneas 232-236): `activo: false` → `deleted_at: knex.fn.now()`.
  - Soft-delete de items de scoring (líneas 310-316): mismo cambio.
  - Update DTO `data.activo` (líneas 487-489 y 605-621): traducido a `deleted_at: data.activo ? null : knex.fn.now()` — preserva semántica reactivate/deactivate.
  - SELECTs/RETURNINGs que devolvían `'activo'` ahora usan `knex.raw('(deleted_at IS NULL) as activo')` — la respuesta al frontend mantiene el shape boolean.
  - WHEREs `{ activo: true }` reemplazados por `.whereNull('deleted_at')` para consistencia.
- `apps/api/src/modules/daily-assignments/daily-assignments.service.ts`: `route.activo === false` → `route.deleted_at !== null` en validación de ruta activa.
- `apps/api/src/modules/stores/stores.service.ts`: misma sustitución que arriba.

**Reclasificación de shims** (decisión arquitectónica): tras audit, los 3 "shims" se promueven a **columnas canónicas**, no debt:

| Columna | Estado original | Nueva clasificación | Razón |
|---|---|---|---|
| `activo` GENERATED en 12 tablas | shim K-debt | **helper de lectura permanente** | Útil para WHERE/JOIN boolean sin envolver `IS NULL`. Read-only, zero maintenance. |
| `daily_captures.captured_by_username` | shim K-debt | **snapshot denormalizado de audit** | Mejor diseño que JOIN: preserva el nombre del usuario al momento de captura (si user se renombra, históricos no cambian). |
| `zones.is_system` | shim K-debt | **flag system-zone reservado** | Default `false` en seed; se setea manualmente cuando Mega Dulces designa una zona crítica. `CatalogsService.update/delete` ya lo respetan. |

Comments en las migraciones `20260527130000` y `20260527140000` reescritos para reflejar el nuevo status canónico (no más "compatibility shim" — ahora "helper canónico").

**Verificación:**
- Build api OK (warnings pre-existentes solamente, unrelated).
- Regression suite: **19/19 verde** (~26s total). Sin nuevos fallos.
- No requirió nuevas migraciones — el refactor es puro código TS.

**Lecciones:**
- **Columnas GENERATED ALWAYS son trampa silenciosa** si el código original asumía columnas regulares: writes con la columna en la payload tiran error solo cuando se ejecuta la operación, no a build time ni en typecheck. El smoke suite tiene que ejercitar el CRUD admin completo para detectarlo.
- **No todo lo etiquetado "shim" debe eliminarse**: `captured_by_username` (snapshot) y `is_system` (flag de negocio) son ejemplos donde el diseño "shim" resulta superior al ortodoxo (JOIN). El audit K-debt sirve para distinguir entre debt real (writes a GENERATED) y diseño legítimo.
- **`deleted_at NULL == activo`** es la convención uniforme ahora en todo el código multi-tenant — más alineada con Knex/PG patterns que un boolean explícito.

**Pendientes derivados (deferred):**
- `combinaciones_validas` table no existe en multi-tenant pero `scoring-v2.service.ts:236` y `catalogs.service.ts:414` la referencian. Dead code paths; no breaking pero conviene limpiar en próximo refactor de scoring.
- `reports.service.ts` mantiene 15 referencias a `captured_by_username` — ahora consideradas canónicas (no refactor pendiente).

**Próximo:** validación visual E.3.2 o arrancar Fase F (WhatsApp Bot).

---

## 2026-05-27 — Fase E cerrada (beta scope) — Remote Manager (Televenta)

**Item revisado:** Sprints E.0 → E.1 → E.2 (Fase E MVP completa).

**Scope MVP definido por Edgar 2026-05-27:**
- Solo workflow (sin Twilio/Vonage). Operador usa su teléfono físico.
- Pool compartido autoservicio.
- MVP NO incluye dashboard de métricas (deferred E.4).
- Cartera scoped: operador ve solo sus reservas + pool sin reservar.

**Entregables:**

- **E.0 — Schema + permisos + rol** ✅
  - Migración `20260527160000_commercial_televenta_schema.js`: tablas `commercial.lead_reservations` (UNIQUE PARTIAL anti-race en (tenant_id, customer_id) WHERE released_at IS NULL) + `commercial.call_logs` (6 outcomes + FK opcional a order_id + CHECK constraint validation). Composite FK + RLS forzado + grants `app_runtime`.
  - Permisos nuevos: `COMMERCIAL_TELEVENTA_VER` + `COMMERCIAL_TELEVENTA_OPERATE` (back + front).
  - Rol `tele_operator` upserted via seed `02_mega_dulces_initial_roles.js` con permisos scoped (CUSTOMERS_VER + PRICING_VER + INVENTORY_VER + ORDERS_VER/CREAR/CONFIRMAR + PROMOTIONS_VER).
  - Smoke RLS isolation: ✅ aislamiento entre tenants + UNIQUE PARTIAL bloquea doble reserva (23505 → 409).

- **E.1 — Backend `commercial-televenta`** ✅
  - `CommercialTeleventaService` con 7 métodos. Usa `TenantKnexService.run()` para envolver cada query en transacción con `SET LOCAL app.tenant_id` (lección crítica — sin esto el `app_runtime` user no ve nada por RLS forzado).
  - `CommercialTeleventaController`: 7 endpoints REST (queue, my-reservations, reserve, release, snapshot, customer-calls, calls).
  - `TeleventaCronService` con `@Cron('0 */5 * * * *')` libera reservas expiradas. Usa `KNEX_NEW_DB_ADMIN` (postgres user, bypass RLS) para cross-tenant UPDATE.
  - Module wireado en AppModule dentro del toggle `ENABLE_MULTITENANT`.
  - **Smoke HTTP `database/http-televenta-test.js`: 29/29 OK** — login + queue + reserve + 409 conflict + my-reservations + snapshot + 400 validation + 201 log + release verify + history + callback + 404 fake.
  - Agregado a `database/run-all-tests.js` para regression.

- **E.2 — Frontend `/televenta` (4 páginas standalone)** ✅
  - `TeleventaService` (Angular) wrapper HTTP tipado.
  - `televentaGuard` enforce auth + permiso `COMMERCIAL_TELEVENTA_OPERATE`.
  - `TeleventaShellComponent` header propio con nav (Cola / Mis activos), no usa shell de admin.
  - `TeleventaQueueComponent`: cola priorizada con tags de razón (inactive_critical/callback_due/inactive_normal/never_ordered/general) + sección "Mis reservas activas" con TTL.
  - `TeleventaLeadComponent`: snapshot (contacto + datos comerciales + últimos 5 pedidos + historial llamadas + reserva activa) + modal de log call (6 outcomes, callback con datepicker, release_reservation toggle).
  - `TeleventaTakeOrderComponent`: catálogo del cliente + sticky footer con total + confirm crea draft+addLines+confirm+autoLogCall(outcome=sale, order_id, release_reservation=true). Reusa `VendorService`.
  - Card "Televenta" en `/projects`.
  - Routes lazy-loaded. `nx build view` OK.

**Decisiones técnicas clave:**

1. **Patrón TenantKnexService obligatorio**: el primer smoke devolvió queue vacía aunque había 37 customers. Causa: `KNEX_NEW_DB` es `app_runtime` user con RLS forzado. Sin `SET LOCAL app.tenant_id`, los policies devuelven 0 rows aunque el query tenga `tenant_id = ?` explícito. Fix: refactor service para usar `TenantKnexService.run(async (trx) => ...)` que envuelve cada operación en transacción con tenant_id seteado. **Lesson general**: cualquier service que toque tablas con RLS forzado desde un request handler debe usar `TenantKnexService.run()`, NO inyectar `KNEX_NEW_DB` directamente.

2. **Cron sin tenant context usa `KNEX_NEW_DB_ADMIN`**: el cron de release expired corre cross-tenant. Originalmente con `KNEX_NEW_DB` (runtime) — fail silencioso. Fix con `KNEX_NEW_DB_ADMIN` (postgres user, bypass RLS). Reservar este token para jobs admin internos.

3. **UNIQUE PARTIAL anti-race**: `CREATE UNIQUE INDEX (tenant_id, customer_id) WHERE released_at IS NULL` garantiza una sola reserva activa por cliente. Segundo operador recibe `23505` → traduce a `409 Conflict`.

4. **Cola priorizada con CTE Postgres**: agrupar (last_order_at, total_orders, last_call_at, callback_due_at) en una CTE evita N+1. Ordenamiento de prioridad final hecho en JS (Map<reason, weight>) para flexibilidad futura.

5. **Reusar `VendorService` desde Televenta**: take-order copia el patrón vendor (ensureDraftForCustomer + addLine + confirm) en vez de duplicar. Coupling aceptable porque vendor.service.ts es `providedIn: 'root'`.

**Estado al cierre:** 🟢 Fase E MVP cerrada (beta scope). Smoke E2E 29/29 verde.

**Pendiente Edgar (E.3.2):** validación visual manual abriendo `/televenta` con un usuario que tenga rol `tele_operator` (o superadmin). Probar cola → reserve → snapshot → log call → take-order → confirm + auto-log + release.

**Deferred post-MVP:**
- E.4 — Dashboard de métricas por operador.
- E.5 — Telefonía Twilio Voice integrada.
- E.6 — Asignación inteligente (round-robin / ML).
- E.7 — Handoff WhatsApp (post Fase F).
- E.8 — Recordatorios callback (cron + Socket.IO `/alerts`).

---

## 2026-05-27 — Sprint J.8 cerrado: Migración desde repo `_imported/logistica/`

**Item revisado:** Fase J.8 (sub-items J.8.0–J.8.7)
**Estado al inicio:** Pivot: usuario solicitó traer features reales del repo origen sin reinventar
**Estado al cierre:** 🟢 CERRADA (beta scope)

**Contexto y decisión de estrategia:**
Tras cerrar J.6/J.7 (hook close+fulfill, promote store, portal access, delivery_type, stock visibility, pending orders), el usuario importó el repo monolítico de logística en `_imported/logistica/` y pidió migrar features reales en lugar de seguir construyendo desde cero. Tras evaluar 3 estrategias (A: reemplazo total, B: híbrido aditivo, C: parcial), se decidió **Estrategia B** porque A rompía multi-tenant + RLS + hook commercial ya verificados. Auto mode confirmó: Capacitor camera+geo, signals (NO NgRx), jspdf (NO Puppeteer), importar 96 destinos reales.

**Qué se revisó del repo origen (`_imported/logistica/`):**
- 10 backend modules (NestJS): shipments, costs, fleet, staff, guides, checklists, fotos, config, reports, cron.
- 12 frontend features (Angular standalone, sin NgRx pese a estar en package.json).
- 10 tablas core en schema `public` (`logistica_*`), sin tenant_id ni RLS.
- State machine de 7 estados con side effects (GPS, fotos, reports).
- Seeds reales: 105 destinos, 26 períodos catorcenales 2026, 22 parámetros financieros.
- Dependencias: Capacitor camera/geo, Cloudinary, jspdf, Puppeteer (no usado).

**Delta real vs lo que J.0-J.7 ya cubría (80%):**
Schema preexistente ya incluía: shipments, delivery_guides con comisiones+viáticos, guide_recipients con proof_photo_url+GPS, routes, drivers (roles[]), vehicles, payroll_periods, config_finance, shipment_expenses, load_details, unload_details, liquidations, hook close→fulfill. Gap real:
- 3 estados extra: `checklist_salida`, `checklist_llegada`, `costos_pendientes`.
- Tabla `shipment_checklists` (templates JSONB + responses validados).
- Tabla `shipment_photos` (general purpose: categoría + Cloudinary + GPS + soft-delete).
- Importer real con data Mega Dulces.
- Backend reports con jspdf.
- Frontend con Capacitor camera+geo dynamic import.

**Implementación (commits J.8.0-J.8.7):**

**J.8.1 — Schema delta** ([20260527110001_logistics_j8_checklists_photos_states.js](../../database/migrations-newdb/20260527110001_logistics_j8_checklists_photos_states.js)):
- CHECK constraint `logistics.shipments.status` expandido de 5 → 8 valores.
- `logistics.shipment_checklists` con UNIQUE (tenant, shipment, type), composite FK a `(tenant_id, shipment_id)`, RLS forzado, grants `app_runtime`.
- `logistics.shipment_photos` con `cloudinary_public_id` (para borrar en soft-delete), `gps_lat/lng` (precision 7), `captured_at` separado de `uploaded_at`, categorías enum: `loading|transit|delivery|incident|checklist|other`.
- Migración suplementaria [20260527110002_logistics_routes_km_decimal.js](../../database/migrations-newdb/20260527110002_logistics_routes_km_decimal.js): `routes.estimated_km` de integer → numeric(10,2) (data real tiene decimales).

**J.8.2 — Importer real** ([logistics_baseline.js](../../database/importers/logistics_baseline.js)):
- 96 destinos con `driver_commission/helper_commission/estimated_km` (UPSERT por `tenant_id, name`).
- 26 períodos catorcenales 2026 (UPSERT por `tenant_id, year, number`).
- 23 parámetros `config_finance` (factores por zona + costos km por vehículo + tarifas maniobra).
- Idempotente. Run: `node database/importers/logistics_baseline.js --tenant-slug=mega_dulces`. Resultado verificado: `{ routes: 96, periods: 26, config: 23 }`.

**J.8.3 — State machine extendido** ([logistics-shipments.service.ts:50-71](../../apps/api/src/modules/logistics-shipments/logistics-shipments.service.ts)):
- `VALID_TRANSITIONS` actualizado para 8 estados con dos flujos: simple (4 saltos) y formal (7 saltos).
- 3 métodos nuevos: `startSalidaChecklist()`, `startLlegadaChecklist()`, `markCostsPending()`.
- `close()` ahora acepta entrada desde `entregado | checklist_llegada | costos_pendientes` (todos llegan a `cerrado` y disparan el mismo hook commercial `fulfillInTransaction`).
- 3 endpoints REST nuevos en controller.

**J.8.4 — 3 backend modules nuevos:**
- `logistics-checklists`: templates default por tipo (8 items salida + 8 items llegada con `required/group`), CREATE valida shipment+driver, COMPLETE valida que todos los items required tengan respuesta, UNIQUE constraint por (shipment, type).
- `logistics-photos`: 2 modos: subir base64 → Cloudinary auto-upload con folder `logistics/{tenant}/{shipment}`, o registrar `external_url`+`cloudinary_public_id` directo. Soft-delete intenta `Cloudinary.deleteImage()` y no aborta si falla (loggea warning).
- `logistics-reports`: `shipmentSummaryPdf(id)` con jspdf+autoTable (header + datos + guías + destinatarios + costos), `kpiSummary(from,to)` con JOINs a expenses+guides, `kpiSummaryPdf(from,to)`. Content-Type `application/pdf`, Buffer retornado.

**J.8.5 — Frontend (3 páginas standalone nuevas):**
- `logistica-reports.component.ts`: KPI cards (revenue/margen/cost/km) + detail grid + download PDF button.
- `logistica-checklist.component.ts`: lista checklists del shipment + crear nuevo (selector type + autocarga template) + editor de respuestas con SelectButton ok/issue + completar con validación.
- `logistica-photos.component.ts`: upload con `import('@capacitor/camera')` y `import('@capacitor/geolocation')` dynamic (no romper build web), preview base64, file picker fallback, grid de fotos con filtro por categoría, soft-delete confirmado.
- Rutas: `/logistica/shipments/:shipmentId/checklists`, `/photos`, `/logistica/reports`.
- Nav menu: agregado "Reportes" entre "Embarques" y "Flotilla".
- Quick links en `shipment-detail` header: Checklists | Fotos | PDF.
- `logistica.service.ts`: 14 métodos nuevos + 5 interfaces nuevas (Checklist, ShipmentPhoto, KpiSummary, etc.).
- ShipmentStatus type extendido a 8 valores en frontend (alineado con backend).
- `severityForStatus()` cubre los 8 estados.
- Build view OK con warnings preexistentes (html2canvas CJS dep).

**J.8.6 — HTTP E2E test** ([http-logistics-j8-test.js](../../database/http-logistics-j8-test.js)):
- ~40 checks: login → setup → order draft+confirm → shipment + state machine formal 6 transitions → checklists module (template, create, complete validation, duplicate rejection) → photos module (upload external_url, list, filter by category, soft-delete) → reports module (KPI JSON + 2 PDFs con verificación Content-Type) → close shipment con hook commercial verificando order.status='fulfilled' al final.
- Agregado a `run-all-tests.js` regression suite.
- **Pendiente**: re-correr post-restart API (los 3 módulos nuevos + 3 endpoints nuevos requieren restart para registro).

**Lessons learned:**
- Al heredar un repo, el primer paso es **medir el delta**, no asumir reemplazo total. 80% del repo origen ya estaba implementado mejor en multi-tenant.
- `estimated_km` integer fue un error de la migración J.0.1 — datos reales tienen decimales. Migración correctiva.
- Capacitor camera/geo con dynamic import via `import('@capacitor/X')` permite que el bundle web funcione sin error (los plugins se cargan solo en runtime mobile o si están disponibles).
- jspdf+jspdf-autotable funcionan perfectamente en backend Node (sin html2canvas), output `arraybuffer` → `Buffer.from()`.
- jspdf agrega warning sobre `html2canvas` CommonJS dep al build view pero NO afecta funcionalidad (solo se carga si hace `html2canvas` mode).

**Estado final Fase J:**
🟢 CERRADA (beta) — J.0+J.1+J.2+J.4+J.5+J.6+J.7+J.8.
Deferred:
- J.3 — driver mobile app (app standalone para chofer con Dexie offline + Capacitor camera+geo dedicados).
- Validación visual manual del nuevo UI J.8.
- Re-correr `node database/http-logistics-j8-test.js` después de restart API.

**Siguiente:** decisión del usuario sobre próxima fase. Opciones beta-ready: Fase E (Remote Manager televenta), Fase F (WhatsApp Bot), Fase G (Growth campañas), Fase H (Fintech wallet), o trabajos diferidos (Railway cutover, JwtAuthGuard formal, refactor god services, J.3 driver mobile).

---

## Plantilla de entrada

```markdown
## YYYY-MM-DD — <Tipo: PR review / Sprint review / Phase checkpoint / Bug postmortem>

**Item revisado:** <código del item del tracker o link a PR>
**Estado al inicio:** <En progreso / En revisión>
**Estado al cierre:** <En revisión / Hecho / Devuelto a En progreso>

**Qué se revisó:**
- (lista)

**Hallazgos:**
- (lista)

**Acciones tomadas:**
- (lista)

**Siguiente paso:**
- (qué falta)
```

---

## 2026-05-27 — Fase K cerrada (beta scope) — AI product match en captures wizard

**Item revisado:** Sprints K.0 → K.1 → K.2 → K.3 (Fase K completa MVP).

**Entregables (resumen ejecutivo):**

- **K.0** — Schema + pgvector + backfill:
  - Docker container `pgvector-md` (imagen `pgvector/pgvector:pg18`, vector 0.8.2) en `localhost:5433` como espejo de `postgres_platform`.
  - Migración `20260527120000_enable_pgvector_and_products_embedding.js`: `CREATE EXTENSION vector` + 3 columnas en `products` (`embedding vector(1024)`, `embedding_source_text TEXT`, `embedding_updated_at TIMESTAMPTZ`) + HNSW index parcial.
  - Script `database/scripts/backfill-product-embeddings.js`: **1278/1278 products embedded** (voyage-3, 1024 dims) en ~10s, costo ≈$0.02.
  - Provider: Voyage AI `voyage-3` (ADR-011). Anthropic Claude Haiku 4.5 para extracción estructurada con tool_use.

- **K.1** — Backend module `ai-product-matcher`:
  - `EmbeddingsService` (Voyage REST direct, fetch, retry exp 429/5xx, timeout 10s).
  - `LlmExtractorService` (Anthropic Messages API direct, tool_use `extract_products`, fallback heurístico split por `,;/|\n` + ` y `).
  - `AiProductMatcherService.match()`: sanity → LLM extract → Voyage embed batch (`input_type=query`) → pgvector KNN top-3 paralelo. Threshold autoConfirm **0.40** (calibrado post-smoke real, no 0.80 del plan original).
  - `AiProductMatcherController` con `POST /api/ai/products/match-ai` (path movido de `planograms/products/match-ai` por conflicto con `PlanogramsProductsController`). Guard `RequireAuthGuard + RolesGuard + RequirePermissions(VISITAS_REGISTRAR)`. `@Throttle({ long: { ttl: 60_000, limit: 10 } })`.
  - Hook re-embed en `planograms.service.ts` add/update product (no-blocking).

- **K.2** — Frontend modal en captures wizard:
  - `AiProductMatcherService` (Angular) wrapper HTTP tipado.
  - `<app-ai-product-picker>` standalone con states signal-based (idle/loading/preview/error), textarea 5000 chars, preview UI con severity colors (verde autoConfirm / amarillo ≥0.30 / rojo <0.30), alternativas top-2, detección dedupe.
  - Integración en captures step 5 con botón gradient "Agregar varios con AI", `<p-dialog>` adaptador, network guard `isOnline` (oculta botón offline).

- **K.3** — Verificación + cierre:
  - **Smoke HTTP 29/29 OK** (`database/http-ai-match-test.js`): login + match real + typos + empty→400 + sin token→401 + throttle 429.
  - Agregado a `database/run-all-tests.js` para regression.
  - **Validación visual confirmada por Edgar**.

**Decisiones técnicas (ADRs nuevos):**
- **ADR-011** ✅ Embeddings provider: Voyage AI `voyage-3` (1024 dims, multilingual ES-MX).
- **ADR-012** ✅ pgvector instalado en DB Docker local; cuando se migre TM a multi-tenant real, la columna `embedding` viaja con la tabla.

**Lessons learned críticos:**

1. **pgvector en Windows nativo no es viable** — el SO no tiene binarios precompilados de `vector.dll` y compilar con nmake es no-trivial. Solución: Docker `pgvector/pgvector:pg18` con port mapping. En Railway prod es trivial (cambio de imagen Docker del servicio Postgres a `pgvector/pgvector:pgXX`).

2. **PG18 cambió la convención de mount path Docker** — error si usás `/var/lib/postgresql/data` (lo viejo). Correcto: `/var/lib/postgresql` (sin `/data`). Postgres ahora gestiona subdirectorios por major version internamente.

3. **`pg_dump` mismatch de versión es brutal** — `pg_dump 17 vs server 18` da error immediato. Solución: usar el `pg_dump.exe` nativo Windows 18 en lugar del del container.

4. **MSYS path conversion en Git Bash + docker cp es un infierno** — `/tmp/x` se convierte a Windows path. Workaround: usar `//tmp/x` (doble slash) o stream via `cat | docker exec -i ... sh -c 'cat > //tmp/x'`.

5. **Voyage free tier = 3 RPM / 10k TPM** hasta agregar payment method. Para el backfill inicial es bloqueante. Tras agregar tarjeta: ~300 RPM, los 800 SKUs restantes terminaron en 9.8s.

6. **Threshold de embeddings es SENSIBLE al input_type** — voyage-3 con `input_type=query` sobre texto crudo + Haiku extract da scores **bajos vs lo que sugería K.0 smoke** (0.38-0.49 para matches obvios). Threshold 0.80 era irreal; 0.40 captura los matches buenos sin false positives. **Lesson: nunca asumir threshold sin smoke contra el flow REAL del usuario**.

7. **`@Throttle` keys deben coincidir con los tiers globales de `ThrottlerModule.forRoot`** — la app tiene `short/medium/long`. Usar `default` (que no existe) hace que el override sea silently no-op. Hay que sobrescribir un tier existente para que aplique.

8. **Path conflicts en NestJS controllers**: dos controllers con `@Controller('planograms/products')` causaron 404 en POST. Aunque técnicamente NestJS permite múltiples controllers en el mismo prefix, el routing puede comportarse inesperadamente. **Regla**: cada controller con prefix único — más limpio semánticamente además.

9. **Schema multi-tenant nuevo vs código legacy** (descubrimiento crítico post-K.1): la migración A.0mt.4 dejó el schema nuevo (`deleted_at IS NULL` para soft-delete) pero el código legacy seguía con `WHERE activo=true`. 12 tablas afectadas + `zones.is_system` + `daily_captures.captured_by_username` faltantes. Fix aplicado con **2 migraciones compatibility shim**:
   - `20260527130000_add_activo_virtual_to_multitenant_tables.js`: columna `activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED` en 12 tablas (read-only, autosync con `deleted_at`).
   - `20260527140000_add_legacy_columns_zones_daily_captures.js`: `zones.is_system BOOLEAN DEFAULT false` + `daily_captures.captured_by_username VARCHAR` con backfill 398/401 rows.
   - **Estas migraciones deben sincronizarse a `.245` para mantener paridad Docker ↔ remote**.

**Estado al cierre:** ✅ Fase K cerrada beta scope. Sistema operativo end-to-end.

**Próximo (post-beta, deferred):**
- K.4 — Bulk import admin (pegar lista SKUs nuevos en admin-catalogs/planograma).
- K.5 — Mismo motor en portal B2B + módulo vendedor.
- K.6 — Telemetry persistida `ai_match_telemetry` para tuning fino de threshold.
- K.7 — AI vision: foto del exhibidor → identifica productos sin texto.

**Item para limpiar deuda técnica (pendiente sprint formal):**
- Auditar todos los services legacy contra el schema multi-tenant — varios endpoints probablemente siguen con queries hardcoded que asumen schema viejo. Las 2 migraciones de compatibility shim aplicadas hoy son band-aids; lo correcto es eventualmente refactorizar `CatalogsService`, `ReportsService`, `VisitsService`, etc., para hablar nativamente con el schema multi-tenant.

---

## 2026-05-27 — Sprint J.7.1 cerrado — Bandeja "pedidos pendientes de programar" + columna delivery_type en admin

**Item revisado:** J.7.1 (GAP-5 del review).

**Entregables:**

- **Backend** `GET /api/logistics/shipments/pending-orders` con NOT EXISTS subquery sobre `logistics.shipments` (excluye los que ya tienen shipment activo, incluye los que solo tienen shipments cancelados). Devuelve array ordenado FIFO por `confirmed_at`.
- **Frontend `/logistica/shipments`** rediseñado con `p-tabs`:
  - Tab 1 "Embarques" — la lista paginada existente con su filtro de status.
  - Tab 2 "Pendientes de programar" — bandeja de pedidos esperando, con badge contador, columnas folio + cliente + almacén + delivery_type + total, botón "Crear embarque" que pre-llena el form con `order_id` + customer name como destination + cargo_value desde el total del order.
- **Bonus J.7.1c:**
  - Columna `Entrega` (Por ruta / Viaje largo) en `/comercial/orders` list.
  - Badge `delivery_type` en hero del order detail con icono pi-truck / pi-globe.

**Decisiones:**
- `pendingOrders` NO paginado: cola operativa rara vez supera decenas de items; complejidad innecesaria.
- "Shipment activo" = cualquiera != `cancelado`. Razón: cuando se cancela un embarque, el order vuelve a la bandeja para reprogramar.
- Refresh automático de la bandeja al crear shipment (el order ya no califica) y manual via botón "Refrescar".
- FIFO por `confirmed_at` (no por `created_at`) — refleja el orden en que logística debería atenderlos.

**Pendiente del Sprint J.7 (deferred):**
- J.7.2 — expandir shipments en order detail con recipients + foto + GPS.
- J.7.3 — timeline de trazabilidad completa (pedido → confirm → shipments → entregas).
- J.7.4 — UI/UX polish end-to-end.
- J.7.5 — test E2E completo del flow.

**Estado global del MVP:** Fases A+B+C+D+J 🟢 CERRADAS (beta scope). Operación de logística ahora tiene una verdadera bandeja de entrada — el operador entra a `/logistica/shipments` y ve inmediatamente qué pedidos esperan ser programados.

---

## 2026-05-27 — Sprint J.6.6 + J.6.7 cerrados — Tipo de entrega + visibilidad de stock al tomar pedido

**Item revisado:** J.6.6 (GAP-11) + J.6.7 (GAP-12) — gaps identificados por Edgar post-J.6.

**Origen:** Edgar señaló que al tomar pedido manual hay que (a) seleccionar si la entrega va por ruta normal o es un viaje largo dedicado, y (b) ver qué productos están en stock vs no.

**Entregables:**

| Sprint | Cambio | Resultado |
|---|---|---|
| **J.6.6** | Columna `commercial.orders.delivery_type` (`'route'` default \| `'long_trip'`) + `PATCH /commercial/orders/:id` solo en draft + toggle `p-selectButton` en header de vendor take-order | Vendor elige tipo al iniciar el pedido; si lo cambia con un draft abierto, hace PATCH inmediato |
| **J.6.7** | `GET /price-lists/:id/prices?warehouse_id=X` con LEFT JOIN a `commercial.stock` devolviendo `stock_available = GREATEST(quantity - reserved, 0)`. Badges `success`/`warn`/`danger` por producto en vendor catalog. Warning (no bloqueo) si qty > stock_available → permite backorder | Vendedor ve stock en vivo por producto, decide si toma backorder o no |

**Decisiones de diseño:**
- `delivery_type` default `'route'` para no migrar data existente.
- PATCH solo en draft — editar post-confirm rompería planificación de logística.
- `stock_available` puede ser `null` cuando el endpoint se llama sin `warehouse_id` → mantiene compatibilidad.
- Backorder permitido: vendedor decide. El reserve fallará en confirm si stock real no alcanza (feedback tardío pero correcto).
- Portal B2B no recibe el toggle (default `'route'` automático — no se espera que el cliente decida esto).

**Pendientes deferred:**
- Badge `delivery_type` en order detail + filtro en order list.
- Pre-fill automático de `shipment.type` desde `order.delivery_type` cuando logística crea el embarque.
- Smoke test HTTP automatizado (requiere testdata con stock conocido).

**Estado global del MVP:** Fases A+B+C+D+J 🟢 CERRADAS (beta scope). Flow Trade→Comercial→Logística→fulfilled ahora incluye selección de tipo de entrega y visibilidad de stock al tomar pedido — la experiencia operativa del vendedor coincide con el flujo descrito por Edgar.

---

## 2026-05-27 — Sprint J.6 cerrado — Fixes flow end-to-end Trade→Comercial→Logística

**Item revisado:** J.6 (3 gaps críticos identificados en review `04_FLUJO_END_TO_END_REVIEW.md`).
**Estado al cierre:** 🟢 J.6 CERRADO. Fase J ahora **100% beta-ready**.

**Origen:** análisis del flujo descrito por Edgar: *"En Trade Marketing se captura el exhibidor y se registra la tienda. Al registrarse la tienda la misma ya puede hacer pedidos..."*. Reveló 3 gaps críticos:

1. Hook `close → fulfilled` hacía UPDATE pelado del status sin consumir stock → inventario inflado para siempre.
2. Tienda registrada en Trade Marketing NO se convertía automáticamente en cliente comercial — la frase del usuario no era cierta operativamente.
3. Aunque la tienda quedara como customer, NO podía entrar al Portal B2B (falta auto-creación de user `customer_b2b`).

**Fixes entregados:**

| Item | Cambio | Test |
|---|---|---|
| **J.6.1** | `OrdersService.fulfillInTransaction(trx, orderId)` extraído como público + idempotente. `LogisticsShipmentsModule` importa `CommercialOrdersModule`. `ShipmentsService.close()` llama al service en lugar de UPDATE pelado. Stock se consume correctamente + history registra transición + alert WS dispara. | `http-shipment-hook-fulfill-test.js` (15+ checks) agregado a `run-all-tests.js` |
| **J.6.2** | `POST /commercial/customers/from-store` idempotente — falla 409 si ya hay customer con `store_id=X`. Botón `pi-shopping-cart` en `/dashboard/stores` con confirm dialog. Gateado por `COMMERCIAL_CUSTOMERS_GESTIONAR`. | Smoke manual recomendado |
| **J.6.3** | Migración `20260527100005` con UNIQUE índex partial `(tenant_id, customer_id) WHERE customer_id IS NOT NULL`. Endpoint `POST /commercial/customers/:id/portal-access` que genera username `cliente_{code}` + password 8 chars random → bcrypt hash → INSERT en `public.users` con role `customer_b2b`. Devuelve password una sola vez. UI: botón `pi-key` + dialog con copy-to-clipboard. | Smoke manual recomendado |

**Decisiones técnicas:**

- **`fulfillInTransaction` idempotente vs `fulfill` estricto**: el hook puede dispararse en estados ya fulfilled (race con cancelación, retry), por eso el método compartible es no-op si status ≠ confirmed. El endpoint REST `POST /:id/fulfill` mantiene el 409 explícito para no enmascarar bugs de UI.
- **Promoción store→customer NO automática**: opt-in por botón explícito. Razón: usuarios sin permisos comerciales no deberían disparar side-effects al registrar una tienda.
- **Password auto-generado (no manual)**: `randomBytes(6).toString('base64url').slice(0, 8)` — 48 bits de entropía, suficiente para uso temporal. Mostrado UNA vez con copy-to-clipboard + banner amber de aviso.
- **UNIQUE constraint partial vs full**: usar `WHERE customer_id IS NOT NULL` para que internal users (sin customer_id) no participen del unique. Permite múltiples internal users por tenant sin colisión.

**Bug colateral resuelto:** `ai-product-picker.component.html` tenía `[class.bg-brand/5]` que rompía el parser Angular 18 (`/` en valor de atributo binding interpretado como tag close). Fix: migrado a `[ngClass]="{ 'bg-brand/5': ... }"` que sí lo soporta.

**Pendiente operacional (post-fix):**

- **Migración one-off** para data ya creada con stock inflado: si hay shipments cerrados entre 2026-05-27 (J.4 release) y 2026-05-27 (J.6.1 release), esos orders quedaron fulfilled SIN consumir stock. Hay que escribir script idempotente que detecte y emita los `stock_movements.type='sale'` faltantes.
- **Validación visual del flow end-to-end** completo: crear store → promover → crear acceso B2B → loguear en portal → crear pedido → admin confirma → logística crea shipment → entrega → verificar fulfilled + stock consumido. Edgar lo hace manual después del restart.

**Pendientes diferidos (post-beta):**

- J.3 app mobile chofer `/driver/*`.
- J.7 UX polish: cola "pedidos pendientes embarque", estado granular de recipients en order detail, timeline de trazabilidad completa.
- GAP-4 combo "confirmar+embarque" (esperar feedback operativo).
- GAP-7 notificaciones cliente B2B (Fase F WhatsApp).
- GAP-8/9/10 cosméticos.

**Estado global del MVP:** Fases A+B+C+D+J 🟢 CERRADAS (beta scope). Flow end-to-end Trade Marketing → Comercial → Logística → Comercial **completo y consistente**. App lista para arranque comercial beta de Mega Dulces con confianza en inventario y aislamiento multi-tenant.

---

## 2026-05-27 — Checkpoint Fase J cerrado — Logística (embarques, flotilla, costos) completo (beta scope)

**Item revisado:** J.5 (checkpoint) — cierre formal de toda la Fase J.
**Estado al cierre:** 🟢 Fase J CERRADA (beta scope).

**Origen:** repo `Megadulces-Logistica` importado el 2026-05-27 a `_imported/logistica/` (commit `14d7fe0` snapshot vía `git archive`). Decisión arquitectónica: **Opción A** — merge en `apps/api` + `apps/view` existentes (consistencia con cómo se separaron Trade/Comercial vs apps separadas).

**Resumen de Fase J:**

| Sprint | Tema | Estado | Output |
|---|---|---|---|
| J.0 | Schema multi-tenant + 12 tablas + RLS + sequences | ✅ | 4 migraciones aplicadas, smoke RLS 11/11 |
| J.1 | 6 módulos NestJS (fleet, config, shipments con state machine, guides, expenses, payroll) + 11 permisos `LOGISTICS_*` + seed roles | ✅ | 30+ endpoints REST, HTTP smoke 33 checks |
| J.2 | 5 páginas Angular admin (fleet tabs, shipments paginado, shipment-detail tabs, payroll split-view, config) + service + rutas + nav + card landing | ✅ | `nx build view` verde |
| J.3 | App mobile chofer `/driver/*` | ⏸️ deferred post-beta | (3-5 días más) |
| J.4 | Hooks Comercial ↔ Logística | ✅ | sección embarques en order detail + cross-project nav con queryParams + hook close→fulfilled inline en el trx |
| J.5 | Reports (`logistics-analytics` 4 endpoints) + 3 suites agregadas a `run-all-tests.js` | ✅ | smoke 20+ checks |

**Arquitectura final lograda:**

- **DB**: schema `logistics.*` con 13 tablas (12 operativas + `sequences`), todas con `tenant_id UUID NOT NULL` + composite FK + RLS forzado + grants `app_runtime`.
- **Backend**: 7 módulos NestJS (`logistics-fleet`, `-config`, `-shipments`, `-guides`, `-expenses`, `-payroll`, `-analytics`), todos detrás del toggle `ENABLE_MULTITENANT=true`.
- **Frontend**: módulo `logistica/` con servicio + 5 páginas + rutas `/logistica/*` + nav adaptativo por URL prefix + card "Logística" en `/projects` landing.
- **Cross-project hooks**:
  - `logistics.shipments.order_id` ↔ `commercial.orders.id` (composite FK con `tenant_id`)
  - `ShipmentsService.close()` marca `commercial.orders.status='fulfilled'` automático en el mismo trx cuando se cierra la última shipment del order
  - UI `comercial-order-detail` muestra embarques asociados + botón "Crear embarque" que pre-llena order_id via queryParams
- **Regression suite**: 15 suites totales en `run-all-tests.js` (12 previas + 3 J).

**Decisiones técnicas Fase J:**

- **Sequences atómicas**: tabla genérica `logistics.sequences` con PK `(tenant_id, prefix, year)` y UPSERT `ON CONFLICT DO UPDATE RETURNING` para folios `EMB-YYYY-NNNNN` y `GUIA-YYYY-NNNNN`. Mismo patrón que `commercial.order_sequences`.
- **State machine shipments** con `forUpdate()` lock pesimista en cada transición. Map `VALID_TRANSITIONS` declara qué cambios son legales.
- **Payroll calculate idempotente**: respeta `bonuses`/`deductions`/`notes` manuales en re-cálculo. No toca liquidaciones en estado `pagado`/`anulado`.
- **Expenses con recompute automático** de `operating_subtotal` + `total_cost` (incluye `actual_km × fixed_cost_per_km` leído de `config_finance.costo_km_estandar`).
- **Auto-cálculo de comisiones** opt-in en guías: `auto_commissions:true` lee `routes.driver_commission/helper_commission` y aplica como default.
- **Analytics on-the-fly**: sin MVs todavía. Pivot a MV cuando un tenant supere ~1k embarques activos (decisión post-beta).

**Decisiones rechazadas o cambiadas:**

- ❌ Auto-creación de shipment al confirmar order (rechazado: sorpresa para usuarios sin perms LOGISTICS_*). Cambiado a **botón explícito** en order detail.
- ❌ Endpoint dedicado `GET /commercial/orders/:id/shipments` (rechazado: cross-module dependency innecesaria). Reuso del `GET /logistics/shipments?order_id=X` existente.
- ❌ NgRx en frontend (descartado del repo origen — usamos signals + services como el resto del view).
- ❌ `libs/shared-auth` del repo origen (descartado — reuso `auth-mt` actual).
- ❌ 9 primeras migraciones del repo origen (eran fork del Trade Marketing original — duplicarían auth/captures/scoring).
- ❌ Convención `features/` (renombrado a `modules/` para consistencia).

**Pendientes Fase J (post-beta):**

- J.3 app mobile chofer `/driver/*` (captura foto + GPS al entregar recipients, similar a `/vendor/*`).
- MV `analytics.mv_logistics_overview_30d` cuando volumen lo justifique.
- Borrar `_imported/logistica/` cuando se valide todo y la referencia ya no sea útil.
- Tests E2E adicionales: payroll calc con múltiples drivers, fleet utilization comparativa.
- Validación visual manual de las 5 páginas admin (no automatizable desde CLI).

**Pendientes globales del MVP:**

Las Fases A+B+C+D+J están ✅ CERRADAS (beta scope). La app está lista para arranque comercial beta con Mega Dulces + módulo de logística operativo. Próximos sprints opcionales:
- Cutover Railway (A.0mt.5.3-7)
- JwtAuthGuard formal + CORS/JWT secrets
- Fases E (Remote Manager), F (WhatsApp Bot), G (Growth full), H (Fintech), I (ML), K (AI product match)

---

## 2026-05-26 — Checkpoint Fase D cerrado — Catálogo + Portal B2B + Pedidos completo (beta scope)

**Item revisado:** D.5 (checkpoint) — cierre formal de toda la Fase D.
**Estado al cierre:** 🟢 Fase D CERRADA (beta scope).

**Resumen de Fase D:**

| Sprint | Tema | Estado | Output |
|---|---|---|---|
| D.0 | Dominio comercial | ✅ Absorbido por Fase B | `commercial.*` ya tenía todo desde B |
| D.1 | Pedidos B2B + audit trail | ✅ | users.customer_id link + order_status_history + /orders/my + /orders/:id/history |
| D.2 | App vendedor mobile | ✅ MVP | ADR-005 + módulo `/vendor/*` con 3 pages mobile-first |
| D.3 | Portal web B2B | ✅ MVP | Rutas `/portal/*` en apps/view con 5 componentes (login/shell/catalog/cart/orders/history) + recommendations |
| D.4 | Canasta estratégica | ✅ | mv `commercial.recommended_baskets` + 4 categorías heurísticas + cron nightly |
| D.5 | Checkpoint | ✅ | Regression suite 12 suites verde |

**Deferred post-beta (no bloquea):**
- D.2.3 — offline sync queue Dexie para pedidos sin conexión (~2 días de trabajo).
- D.3.1 — app Angular separada `apps/b2b-portal`.
- D.5.3 — validación visual manual del portal + vendor.

**Regression suite completa (`database/run-all-tests.js`):**

| # | Suite | Tipo | Duración |
|---|---|---|---|
| 1 | A.0mt.1 tenant context | DB direct | 367ms |
| 2 | A.0mt.2 RLS isolation | DB direct | 207ms |
| 3 | A.0mt.3 auth multi-tenant | DB direct | 600ms |
| 4 | B.2 orders state machine | DB direct | 269ms |
| 5 | B.3.2 multi-line order | DB direct | 304ms |
| 6 | B.1 HTTP CRUD + order flow | HTTP E2E | 251ms |
| 7 | B HTTP tenant isolation | HTTP E2E | 540ms |
| 8 | C.0 analytics endpoints | HTTP E2E | 199ms |
| 9 | C.1 materialized views | HTTP E2E | 1752ms |
| 10 | C.4 alerts WS realtime | HTTP+WS E2E | 3661ms |
| 11 | D.1 portal B2B + audit history | HTTP E2E | 321ms |
| 12 | D.4 recommendations basket | HTTP E2E | 1095ms |

**Total: 12/12 suites verde en ~10.6s** (~155 sub-assertions individuales).

**Fixes de idempotencia aplicados durante checkpoint:**
1. `test-newdb-orders-with-testdata.js` (B.3.2): re-import del testdata via importer porque la legacy migration había creado los brands en uppercase. Re-cargar brands+products+prices+stock asegura que las assertions hardcoded mixed-case ("Chocolates Premium", "Trufas Surtidas 12pz") encuentren matches.
2. `http-portal-b2b-test.js` (D.1): cambió "my orders inicial = 0" por baseline + delta assert: guarda `initialCount` antes del flujo, asserts `final === initial + 1`. Tolera state acumulado de runs previos.

**Arquitectura final Fase D:**

```
┌──────────────────────────────────────────────────────────────────┐
│                       Frontend (Angular)                          │
│                                                                   │
│  /portal/*          /vendor/*           /dashboard/*              │
│  Customer B2B       Vendor mobile       Admin/staff               │
│  ────────────       ──────────────       ─────────────             │
│  • login            • customers list     • Command Center         │
│  • catalog (own     • take-order:        • Captures               │
│    price)             ▸ customer info    • Reports                │
│  • cart               ▸ catalog+search   • Admin (users, ...)     │
│  • orders+history     ▸ cart sticky      • Modo Vendedor (link)   │
│  • recommendations    ▸ confirm                                   │
│    (4 categorías)   • today (KPIs)                                │
│                                                                   │
│  Guard: customer_b2b   Guard: NOT custome   colaboradorGuard      │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼ HTTP + WS
┌──────────────────────────────────────────────────────────────────┐
│                        Backend (NestJS)                           │
│                                                                   │
│  Modules:                                                         │
│  • commercial-customers / -warehouses / -pricing / -inventory     │
│  • commercial-orders (state machine + status history hooks)       │
│  • commercial-analytics (overview/top/sales/low-stock + MVs)      │
│  • commercial-alerts (WS /alerts + scanner cron + hooks Orders)   │
│  • commercial-recommendations (4 cats + nightly cron)             │
│  • auth-mt + tenants-admin                                        │
│                                                                   │
│  Shared: TenantContextService + TenantContextInterceptor          │
│           + TenantKnexService (RLS via SET LOCAL)                 │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Postgres                                 │
│                                                                   │
│  public.*            commercial.*            analytics.*          │
│  • tenants           • customers (FK users)  • mv_sales_overview  │
│  • users (FK         • warehouses            • mv_top_customers   │
│    .customer_id)     • price_lists           • mv_top_products    │
│  • brands            • product_prices        (CONCURRENTLY)       │
│  • products          • stock + movements                          │
│  • zones             • orders + order_lines                       │
│  • role_permissions  • order_status_history (audit)               │
│  • stores            • payments (cash-only beta)                  │
│  • visits/exhibs     • order_sequences (PD-YYYY-NNNNN)            │
│  ...                 • recommended_baskets                        │
│                                                                   │
│  RLS forzado en commercial.* + public.* + filter explícito MVs    │
└──────────────────────────────────────────────────────────────────┘
```

**Decisiones técnicas acumuladas en Fase D:**
- D.0 absorbido por Fase B (todo el dominio comercial ya existía).
- D.1: link users.customer_id (no tabla separada `customer_users`). draft = cart (no tabla `carts`). Audit trail append-only con snapshot JSONB.
- D.2 ADR-005: extender apps/view con módulo vendor/, no app RN. Reuso PortalService.
- D.3: rutas /portal/* en apps/view, no app Angular separada. Smart routing por role.
- D.4: heurística sin ML (4 categorías). MV-like UPSERT con lazy refresh on stale (24h).
- D.5: regression suite extendida.

**Pendientes operacionales (no bloquean Fase E):**
- Cutover producción Railway con DB nueva (A.0mt.5.3-7).
- JwtAuthGuard formal con 401 + @Public decorator.
- Fix boot order dotenv → decorators.
- Offline sync queue Dexie (D.2.3) cuando vendedores reales lo necesiten.
- App b2b-portal separada (D.3.1) si justifica.
- Refactor god services frontend (reports.component, daily-capture).
- ML upgrade en recommendations cuando haya volumen.
- Sentry, BullMQ, Redis (Fase A.1+ post-cutover).

**Estado global del MVP (Fases A+B+C+D cerradas beta):**
- 134 endpoints REST + 1 WS namespace `/alerts`.
- 13 migraciones aplicadas. 23 tablas + 3 MVs.
- RLS forzado en 28 tablas + filter explícito en 3 MVs.
- Multi-tenant verificado a 5 niveles (composite FK + RLS + filter MVs + tenant rooms WS + role-based UI).
- Frontend: admin dashboard + Portal B2B + Modo Vendedor mobile-first.
- 12 suites de regression con ~155 sub-assertions.
- Data: 28 customers, 1253 products, 1 warehouse, 30+ prices, 30+ orders en distintos estados.

**Siguiente fase:**
- **Fase E — Remote Manager (televenta)** del roadmap (D depends on no future phases for beta).
- O **operacional**: cutover Railway, JwtAuthGuard formal, refactor god services.
- O **validación visual manual** del portal + vendor para confirmar UX antes de demo.

---

## 2026-05-26 — Sprint D.2 MVP cerrado — App vendedor mobile-first (ADR-005)

**Item revisado:** D.2.1 → D.2.9 (MVP). D.2.3 (offline sync) y D.2.10 (visual manual) pendientes.
**Estado al cierre:** ✅ MVP hecho.

**ADR-005 aceptado:**
- Decisión: extender `apps/view` con módulo `vendor/` y rutas `/vendor/*` mobile-first. NO app RN separada.
- Razonamiento: 1 dev (Edgar), infra Capacitor+Dexie ya configurada, reuso de PortalService/AuthService/guards/environment, PrimeNG ya mobile-friendly, decisión reversible. Documentado en `02_DECISIONES_ARQUITECTURA.md`.

**Qué se hizo:**

**Backend (sin cambios):** todo reusa endpoints existentes (`/commercial/customers`, `/orders`, `/price-lists/:id/prices`). Vendedor = usuario interno (rol colaborador/supervisor/admin) tomando pedido para customer arbitrario.

**Frontend (`apps/view/.../vendor/`):**
- `vendor.service.ts`: VendorService con `listCustomers({search})`, `getCustomer`, `catalogForCustomer` (resuelve price list customer→tenant default), `draftForCustomer` / `ensureDraftForCustomer`, delegados a PortalService para line operations, `myOrdersToday`, `defaultWarehouseId`.
- `vendor-shell.component.ts`: header sticky + bottom nav nativo-style (Clientes/Mi día). Toast top-center. Layout responsive max-width 800px.
- `pages/vendor-customers.component.ts`: cards tappables con search debounced 250ms via `Subject` + `switchMap`.
- `pages/vendor-take-order.component.ts`: flujo combinado en 1 página — back link, header customer, banner sticky carrito con scroll-to-cart, search input client-side, lista productos con InputNumber + "+", cart detail al fondo con líneas editables + totales + cancel/confirm. `computed()` signals para totales. Reutiliza draft existente si lo encuentra (no crea duplicado).
- `pages/vendor-today.component.ts`: 3 KPI cards (pedidos/revenue/entregados) + lista de pedidos del día con tags status.
- `vendor.guard.ts`: rechaza customer_b2b (→ /portal); permite roles internos.

**Routes** `/vendor/*` lazy-loaded. **Nav item "Modo Vendedor"** en admin layout con icono `pi-briefcase`, gate por `COMMERCIAL_ORDERS_CREAR`.

**Decisiones técnicas:**
- Reuso de PortalService desde VendorService — las primitivas son las mismas.
- Sin endpoint backend nuevo — el vendedor usa `POST /orders` directo con `customer_id` del cliente seleccionado y `user_id` del JWT.
- Search debounced 250ms (balance responsiveness vs load).
- Filter de catálogo client-side (25 productos — no roundtrip).
- `myOrdersToday` SIN filtro por user_id todavía (admins ven todo). Para "mi día real" agregar `?user_id=ctx.userId` cuando se necesite scope estricto.
- Offline real deferred — sync queue Dexie ~2 días de trabajo, no critical para MVP.

**Validación:**
- `nx build view` OK. Vendor module en chunks lazy-loaded.
- Backend SIN cambios → regression suite acumulada (134 sub-assertions) sigue verde.
- **Visual pendiente Edgar**: serve view + abrir http://localhost:4200/vendor/customers (logged como superoot). Probar flujo completo: pickup customer → catalog → agregar items → confirm → ver en /vendor/today.

**Pendientes:**
- D.2.3 offline sync queue Dexie (post-beta).
- D.2.10 validación visual mobile.
- D.5 checkpoint Fase D + regression extendida.
- Mejoras UX: foto producto, scan barcode, agrupado por brand.

**Siguiente paso:**
- D.5 checkpoint o validación visual.

---

## 2026-05-26 — Sprint D.4 cerrado — Canasta estratégica v1 (heurística sin ML)

**Item revisado:** D.4.1 → D.4.6.
**Estado al cierre:** ✅ Hecho (heurística — ML upgrade futuro).

**Qué se hizo:**

**Backend (`apps/api/src/modules/commercial-recommendations/`):**
- `recommendations.types.ts`: tipos `RecommendationItem`, `RecommendationCategory` (4: base/focus/exploration/innovation), `RecommendedBasket`. Constantes `RECOMMENDATION_LIMITS` con thresholds (BASE=5, FOCUS=5, EXPLORATION=5, INNOVATION=3, CUSTOMER_HISTORY_DAYS=90, TENANT_TOP_DAYS=30, INNOVATION_DAYS=30). Documentadas para volverlas per-tenant cuando crezca.
- `recommendations.service.ts`:
  - `computeForCustomer(customerId)`: ejecuta las 4 heurísticas en orden, evita duplicados (innovation no incluye items ya en base/focus; exploration no incluye los de base ni focus), persiste con UPSERT, devuelve set completo.
  - `getForCustomer(customerId)`: lee la canasta guardada. Si está stale (>24h) o no existe, llama `computeForCustomer` para refresh on-demand.
  - `getForMyCustomer()`: resuelve customer_id del JWT (via users.customer_id) → llama `getForCustomer`. Para el Portal B2B.
- `recommendations-refresh.service.ts`: `@Cron('0 0 9 * * *')` nightly. Itera tenants activos + customers activos, abre scope CLS sintético via `tenantCtx.run({tenantId}, ...)` (workaround porque el service espera context del request handler).
- `recommendations.controller.ts`: 4 endpoints documentados con `@ApiOperation`.
- Migración `100008_commercial_recommended_baskets.js`: tabla con UNIQUE composite + RLS + FK CASCADE + JSONB items y category_counts + computed_at.

**Heurísticas (sin ML por ahora):**
1. **base** — top 5 productos del customer últimos 90d, score = units / max(units). Reason: "Compraste X unidades en N pedido(s) recientes".
2. **focus** — top 5 productos del tenant últimos 30d que el customer NO ha comprado nunca. Score = units / max. Reason: "N cliente(s) lo compraron este mes — no está en tu historial".
3. **exploration** — productos `activo=true` de las brands en las que el customer ya tiene historial, ordenados por `products.puntuacion DESC`. Excluye los ya en base/focus. Score fijo 0.5 (placeholder). Reason: "Marca X que ya compras — este SKU no lo probaste".
4. **innovation** — productos creados en los últimos 30d, excluyendo los ya recomendados. Score fijo 0.4. Reason: "Producto nuevo (agregado hace N días)".

**Frontend (`apps/view/.../portal/pages/portal-recommendations.component.ts`):**
- Ruta `/portal/recommendations` lazy-loaded.
- 4 secciones (una por categoría) con icon distintivo (`pi-star-fill`, `pi-bullseye`, `pi-compass`, `pi-sparkles`) y descripción explicando qué significa cada categoría.
- Grid de cards por item: brand, score%, nombre, reason en pequeño, precio en color primary, botón "Ver" que navega al catalog.
- `computed()` signal precomputa `itemsByCategory` para evitar filters en template.
- Empty state si total=0.
- Header con título + total + fecha + botón "Ir al catálogo completo".
- Nav item "Sugeridos" agregado a `PortalShellComponent`.

**Decisiones técnicas:**
- **Heurística vs ML**: para beta con ~25 customers y 25 SKUs, ML está sobre-engineered. Las heurísticas dan resultados defendibles ("este customer YA compra X, recomendamos Y de la misma brand") y son auditables. Si crece, migrar al collaborative filtering.
- **Lazy refresh on stale (24h)**: en vez de recomputar en cada GET (caro) o exigir refresh manual (UX malo), si la canasta es >24h se recomputa al pedirla. Cron nightly mantiene fresh para queries más recientes.
- **UPSERT por (tenant_id, customer_id)**: 1 row siempre. Items JSONB. Más simple que tabla `recommended_basket_items` con FK — para 12 items no vale el normalizado.
- **Items array preserva orden de inserción** (base → focus → exploration → innovation). El frontend re-agrupa por categoría con `computed()`.
- **Score por categoría, no global**: cada cat usa su propia normalización. Comparar scores cross-cat no es válido — el rank dentro de cat sí.
- **Sin scroll-to-product**: el botón "Ver" del card solo navega al catalog. Implementar scroll/highlight para post-MVP.
- **CLS context sintético en cron**: el service usa `this.tenantCtx.requireTenantId()` que asume scope CLS del request. Para cron, `RecommendationsRefreshService.computeWithTenantContext()` abre `tenantCtx.run({tenantId}, ...)` antes de invocar. Hack visible pero contenido.
- **`exploration` excluye duplicados explícitamente**: sin esto un producto base podía aparecer también en exploration (era de una brand del customer). El Set de excludeIds resuelve eso de forma O(n).

**Validación (`database/http-recommendations-test.js` — 21/21):**
- POST /compute para `TST-PORTAL-001` → 12 items (1 base + 5 focus + 3 exploration + 3 innovation).
- Sample item: `[base] BARRA CHOCOLATE AMARGO 70% — score=1 reason="Compraste 2 unidades en 1 pedido(s) recientes" $45` ← refleja correctamente que el cliente compró este producto en el flujo D.1 test anterior.
- GET /my desde cliente devuelve el mismo set, mismo customer_id.
- GET /:customer_id desde admin idem.
- POST /refresh-all: 1 tenant, 28 customers procesados, 0 errores, 776ms.

**Pendientes:**
- Sprint D.2: app mobile vendedor offline (ADR-005).
- Sprint D.5: checkpoint Fase D + regression suite extendida.
- Configurabilidad de thresholds por-tenant (cuando aparezca el primer use case).
- ML upgrade (collaborative filtering basado en customers similares).
- D.3.1: app Angular separada (post-beta).
- D.3.9 / D.4 verificación visual manual.
- "Comprar en 1 click" desde la card de recomendación (deferred).

**Acumulado:**
- Backend HTTP+WS: 75 (regression) + 18 (alerts) + 20 (D.1 portal) + 21 (D.4 reco) = **134 sub-assertions E2E**.
- Frontend: build view OK con 6 chunks del portal lazy-loaded.

**Siguiente paso:**
- D.5 checkpoint Fase D (cierre formal + regression suite) o D.2 (mobile, scope grande).

---

## 2026-05-26 — Sprint D.3 MVP cerrado — Portal Web B2B (Angular)

**Item revisado:** D.3.2 → D.3.8. D.3.1 (app separada) deferred. D.3.9 (visual manual) pendiente Edgar.
**Estado al cierre:** ✅ MVP hecho.

**Decisión de scope:**
- Plan original: `nx g @nx/angular:app apps/b2b-portal` (app Angular separada).
- Realidad: para MVP esto duplica build/deploy/dependencies sin valor incremental. Customer base es la misma persona (1 person uso bilateral admin + portal posible en dispositivos distintos).
- Decisión: rutas `/portal/*` dentro de `apps/view` con shell propio (sin sidebar) + guard por rol. Refactor a app separada queda para post-beta si justifica (subdominios distintos, themes radicalmente diferentes, etc.).

**Qué se hizo:**

**Backend (1 cambio mínimo):**
- `AuthService.loginMt(payload)` agregado a `apps/view/.../auth.service.ts`: POST a `/auth-mt/login` con `tenant_slug`. Reusa `setSession()` privado existente (escribe cookie auth_token + signal token + carga permisos).
- Backend ya tenía todo (auth-mt + customer_id link en users + orders/my endpoint de D.1).

**Frontend portal (`apps/view/src/app/modules/portal/`):**
- `portal.service.ts`: API client con métodos para catalog (listPriceLists, listPricesForList, listWarehouses, myCustomerInfo), cart (getActiveDraft, ensureDraft, addLine, updateLine, removeLine, confirm, cancel) y orders (myOrders, orderById, orderHistory).
- `portal-shell.component.ts`: header con brand "Portal B2B" + nav (Catálogo / Carrito / Mis pedidos) + username + botón logout. Sin sidebar. Standalone con RouterOutlet.
- `pages/portal-login.component.ts`: form con campos `tenant_slug` (default 'mega_dulces'), username, password. Validación reactive forms. Llama `auth.loginMt()`. Valida `role_name === 'customer_b2b'` (else logout + error message). Tras éxito navega a `/portal/catalog`. Gradient background único.
- `pages/portal-catalog.component.ts`: en `ngOnInit` carga via `forkJoin` el customer + warehouses + price-lists. Resuelve la price-list aplicable al customer (default_price_list_id o tenant default). Luego carga prices de esa lista. Tabla con producto + precio + IVA + min + InputNumber + botón "Agregar". Validación de min_qty antes de submit. `addToCart()`: ensureDraft → addLine → toast success.
- `pages/portal-cart.component.ts`: muestra draft activo con líneas editables. InputNumber con (ngModelChange) llama updateLine inmediato. Botón trash por línea llama removeLine. Botón "Confirmar pedido" abre ConfirmDialog → POST /confirm → navega al detalle. Botón "Vaciar carrito" cancela el draft. Empty state con CTA.
- `pages/portal-orders.component.ts`: tabla con SUS pedidos. Status tag con severity por estado (fulfilled=success / confirmed=info / draft=warn / cancelled=danger). Link de flecha al detalle. Empty state.
- `pages/portal-order-detail.component.ts`: grid 2 columnas. Izquierda: tabla de líneas + totals (subtotal/IVA/total + balance_due en naranja si pendiente). Derecha: **timeline visual de status history** con dots de color por to_status, transición from→to con flecha, changed_by_username, reason, fecha completa. Cargado via forkJoin (orderById + orderHistory).
- `portal.guard.ts`: `customerB2bGuard CanActivateFn`. Si no autenticado → `/portal/login`. Si autenticado pero role distinto → `/dashboard`. Else pasa.

**Routes (`app.routes.ts`):**
- `/portal/login` — pública.
- `/portal` con guard + loadComponent del shell + children:
  - default → catalog
  - /catalog, /cart, /orders, /orders/:id

Todos `loadComponent` lazy-loaded — bundles separados en chunks.

**Decisiones técnicas:**
- **Ensure draft from frontend**: en vez de agregar endpoint backend "POST /cart/items" (que requeriría find-or-create + add atómico), el cliente orquesta: `getActiveDraft()` → si null, `POST /orders` → `POST /orders/:id/lines`. 2 requests pero código backend más simple. Race condition: si user spamea "agregar" rápido, podría crear 2 drafts. Acceptable para MVP (cliente sigue trabajando con el primer draft visible). Solucionar con lock en frontend si surge.
- **Customer-side resolución de price list**: catalog component carga price-lists del tenant + customer info, luego resuelve la lista applicable. Ahorra un endpoint backend dedicado.
- **Sin "checkout" endpoint dedicado**: confirm del cart = `POST /orders/:id/confirm` existente. Más simple.
- **role_name check en login** (no solo guard): si un admin intenta loggearse al portal, el login mismo lo rechaza + hace logout. Defense in depth además del guard.
- **Status history timeline visual**: dots con color por estado para que el cliente entienda visualmente dónde está su pedido. Mejor que solo texto.
- **Sin balance_due interactive** (no se puede pagar): la columna "balance_due" se muestra en naranja si > 0 pero no hay botón "pagar" porque PaymentsService está deferred post-beta. El cliente sabe que debe.

**Lo que NO se hizo (intencional):**
- Mapa de stores / pickup location selector (no aplica — solo 1 warehouse default).
- Drag-and-drop reorder de cart lines (overhead sin valor).
- Búsqueda/filter en catalog (catálogo pequeño beta; agregar cuando crezca).
- Photo de producto en catalog (no hay assets, deferred).
- Notificaciones push de cambios de estado (Sprint C.4 emite WS alerts; el portal podría suscribirse — deferred).
- Validación de stock antes de confirmar en el cliente (backend ya rechaza con 409 si insuficiente; frontend muestra el error).
- Drag handle / sticky checkout button (mobile-friendly nice-to-have).

**Validación:**
- `nx build view` exitoso. 5 componentes nuevos en chunks separados (ETPZCSPF/IP33G25Q/PEDKQFVF/QSDLT3YY + main).
- 11 warnings preexistentes NG8107 sin impacto runtime.
- Backend ya verificado con D.1 smoke (20/20) y regression suite (10/10).

**Para validar en browser (Edgar)**:
1. `npx nx serve view` + API arriba con ENABLE_MULTITENANT=true.
2. Ir a http://localhost:4200/portal/login.
3. Login con `mega_dulces / cliente_demo / cliente_demo`.
4. Catálogo aparece con productos + precios (25 items).
5. Click "+" para subir qty, "Agregar" → toast.
6. Ir a Carrito → ver líneas → editar qty / eliminar → Confirmar pedido.
7. Redirect a detalle → timeline muestra creation → confirmed.
8. Ir a "Mis pedidos" → tabla con status confirmed.
9. Logout → vuelve al login.

**Pendientes Fase D:**
- D.2: app mobile vendedor offline (ADR-005 Ionic/RN pendiente).
- D.3.1: app separada `apps/b2b-portal` (post-beta).
- D.3.9: verificación visual manual del flujo completo en browser.
- D.4: canasta estratégica recomendaciones (ML / heurísticas).
- D.5: checkpoint Fase D.

**Siguiente paso:**
- Edgar valida visualmente, o saltamos a D.4 (recomendaciones backend-heavy, sin frontend nuevo) o D.2 (mobile, mayor scope).

---

## 2026-05-26 — Sprint D.1 cerrado — Portal B2B base (link users↔customers + audit trail)

**Item revisado:** D.0 absorbido + D.1.1 → D.1.8. D.1.7 (sync offline) deferred a D.2.
**Estado al cierre:** ✅ Hecho.

**Reframing vs plan original:**
- D.0 "Dominio comercial" estaba pensado pre-Fase B con Kepler. Las tablas (products, price_lists, customers) ya existen en `commercial.*` desde Fase B. Sync Kepler N/A (no existe). Resultado: D.0 absorbido sin trabajo adicional.
- D.1 "Carrito + pedidos" pensaba en tablas `carts`/`cart_items` separadas. En la nueva arquitectura el "carrito" persistente ES `orders.status='draft'` (state machine B.2 ya implementada). Solo faltaba: link users↔customers + audit trail.

**Qué se hizo:**

**Migración `20260526100007_users_customer_link_and_order_history.js`:**
- `ALTER public.users ADD customer_id UUID NULL`.
- Composite FK `(tenant_id, customer_id)` → `commercial.customers(tenant_id, id)` ON DELETE SET NULL (defensivo: si se borra el customer, el user queda sin link en vez de cascada).
- Partial index `WHERE customer_id IS NOT NULL` para queries fast por customer.
- Tabla `commercial.order_status_history` append-only con: `from_status` (nullable para creación), `to_status` (CHECK), `changed_by`, `changed_by_username` snapshot, `reason`, `snapshot` JSONB con totals, `changed_at`. PK propia (UUID gen_random). RLS forzado.

**Seed `02_mega_dulces_initial_roles.js` extendido:**
- Rol `customer_b2b` con set restrictivo: COMMERCIAL_CUSTOMERS_VER + COMMERCIAL_PRICING_VER + COMMERCIAL_INVENTORY_VER + COMMERCIAL_ORDERS_VER/CREAR/CANCELAR. **No** tiene confirm/fulfill (eso queda para staff interno).

**Seed `05_mega_dulces_demo_customer_user.js` (nuevo):**
- Crea customer `TST-PORTAL-001` (UUID `...c0ffeed1`) con credit_limit $20k.
- Crea user `cliente_demo` (UUID `...c0ffeed2`) con password bcrypt `cliente_demo`, role_name `customer_b2b`, `customer_id` linkeado al customer del portal.
- Idempotente: onConflict por (tenant_id, username) y (tenant_id, code).

**Service hooks en `CommercialOrdersService`:**
- Método privado `recordHistory(trx, orderId, fromStatus, toStatus, reason)`:
  - Fetcha `subtotal/tax_total/total/balance_due` del order como snapshot.
  - Lee `ctx?.userId` y `ctx?.username` del AsyncLocalStorage.
  - Inserta en `commercial.order_status_history` dentro de la trx (atómico con el cambio de status).
- Llamado en: `createDraft` (null→draft), `confirm` (draft→confirmed), `fulfill` (confirmed→fulfilled), `cancel` (current→cancelled + reason).
- `getHistory(orderId)` público: returns array ordenado por `changed_at ASC`.
- `listMyOrders(query)`: resuelve `customer_id` desde el user del JWT y llama `list({customer_id, ...})`. Throws si user sin customer_id linkeado.

**Endpoints en `CommercialOrdersController`:**
- `GET /api/commercial/orders/my` — scoped al customer del JWT.
- `GET /api/commercial/orders/:id/history` — audit trail completo del pedido.

**Decisiones técnicas:**
- **No tabla `carts` separada**: orders.status='draft' cumple esa función. Evita duplicación de lógica (estado, líneas, totales). Cuando se confirma, el draft se convierte en confirmed sin migración de datos.
- **`order_status_history` append-only sin UPDATE**: cada cambio es un row nuevo. Permite reconstruir el flujo completo. No tiene `deleted_at` — un evento histórico jamás se borra.
- **Snapshot JSONB de totals**: facilita debugging "¿cuánto era el total cuando se confirmó este pedido?" sin reconstruir desde order_lines (que sí pueden cambiar después si bug).
- **Customer scope via /my en vez de RLS por customer_id**: RLS funcional pero más simple a nivel app por ahora. Si crece la sensibilidad, agregar RLS policy `(role_name='customer_b2b' AND customer_id=current_user_customer_id())` o similar.
- **customer_b2b sin permiso FULFILL**: el cliente no decide si su pedido se entregó — eso lo confirma el almacén/staff. El cliente puede CANCELAR su propio draft pero no después de confirmed (lo cancela staff).
- **No metí guard formal por customer_id en /orders/:id/history**: dentro del mismo tenant, cualquier usuario autorizado puede ver el history. El customer_b2b podría ver history de pedidos ajenos. Para beta es aceptable (cliente_b2b se usa solo con cliente_demo en testing). En producción, agregar check `if (role===customer_b2b && order.customer_id !== ctx.customer_id) throw`.

**Validación (`database/http-portal-b2b-test.js` — 20/20 PASS):**
- Login cliente_demo OK, JWT incluye `role_name: 'customer_b2b'`.
- `GET /commercial/orders/my` desde cliente_demo: total=0 inicial (sin pedidos).
- Admin login → ve TODOS los pedidos del tenant.
- Cliente_demo ve `TST-PORTAL-001` en `GET /commercial/customers` (RLS por tenant; sin scope adicional por customer todavía).
- Crear draft + add line + confirm desde cliente_demo OK. Fulfill desde admin OK.
- Tras fulfill: `/my` devuelve >= 1 pedido.
- `GET /history/:orderId` devuelve exactamente 3 transitions: `null→draft / draft→confirmed / confirmed→fulfilled`, con changed_by_username populated.
- Comparación `/orders` vs `/orders/my` confirma que /my filtra correctamente (count menor).

**Pendientes:**
- D.1.7 sync offline conflict resolution → requiere D.2 mobile (necesita el cliente offline para tener qué sincronizar).
- Sprint D.2: App vendedor offline (Ionic vs RN — ADR-005 pendiente).
- Sprint D.3: Portal web B2B nuevo Angular app.
- Sprint D.4: Canasta estratégica (recomendaciones).
- Customer-level RLS en /history (post-beta).
- Customer puede ver pedidos donde no es el "owner" (mismo tenant) — agregar check en /history endpoint.

**Acumulado verificado:**
- B HTTP+isolation + C.0+C.1+C.4 = 93 (regression suite 10/10).
- D.1 portal B2B = +20.
- **Total: 113 sub-assertions E2E verde.**

**Siguiente paso:**
- D.3 (portal web) > D.2 (mobile) > D.4 (recomendaciones) — definir prioridad con Edgar.

---

## 2026-05-26 — Checkpoint Fase C cerrado — Sales Intelligence ampliado completo (beta scope)

**Item revisado:** C.5 (checkpoint) — cierre formal de toda la Fase C.
**Estado al cierre:** 🟢 Fase C CERRADA (beta scope).

**Resumen de toda Fase C:**

| Sprint | Tema | Estado | Output |
|---|---|---|---|
| C.0 | Analytics core (pivot vs exhibition_products) | ✅ | 7 endpoints REST sobre `commercial.*` |
| C.1 | Capa analítica con materialized views | ✅ | 3 MVs en `analytics.*` + cron 15min + endpoint refresh |
| C.2 | Endpoints Command Center | ✅ (absorbido en C.0+C.1) | 10 endpoints disponibles |
| C.3 MVP | Frontend Command Center | ✅ | Component standalone con 6 widgets + signals + OnPush |
| C.4 | Alertas WS realtime | ✅ | Gateway `/alerts` + scanner cron + hooks Orders |
| C.5 | Checkpoint | ✅ | Regression suite 10/10 verde |

**Deferred (no bloquea beta):**
- C.0bis: normalizar `exhibition_products` (requiere data de exhibiciones).
- C.3.8: mapa Leaflet con stores heatmapped (requiere lat/lng en stores).
- C.3.9: drill-down zona→ruta→tienda→pedidos (requiere cruce visitas+pedidos).

**Regression suite completa (`database/run-all-tests.js`):**

| # | Suite | Tipo | Duración |
|---|---|---|---|
| 1 | A.0mt.1 tenant context | DB direct | 375ms |
| 2 | A.0mt.2 RLS isolation | DB direct | 201ms |
| 3 | A.0mt.3 auth multi-tenant | DB direct | 604ms |
| 4 | B.2 orders state machine | DB direct | 287ms |
| 5 | B.3.2 multi-line order | DB direct | 315ms |
| 6 | B.1 HTTP CRUD + order flow | HTTP E2E | 252ms |
| 7 | B HTTP tenant isolation | HTTP E2E | 580ms |
| 8 | C.0 analytics endpoints | HTTP E2E | 205ms |
| 9 | C.1 materialized views | HTTP E2E | 1779ms |
| 10 | C.4 alerts WS realtime | HTTP+WS E2E | 3681ms |

**Total: 10/10 suites verde en ~9.3s** (~100 sub-assertions individuales).

**Fixes de idempotencia aplicados durante checkpoint:**
1. `http-e2e-test.js`: customer code dinámico `HTTP-E2E-<timestamp>` para evitar colisión con unique constraint en re-runs.
2. `http-analytics-mv-test.js`: pre-refresh MV antes de comparar MV vs live (alerts test crea orders que invalidan staleness).
3. `http-alerts-ws-test.js`: stock replenish (`POST /commercial/inventory/adjust new_quantity=500`) al inicio del flujo de orden para evitar depletion en runs repetidos.

Estos fixes son críticos para que la regression suite sea fiable. Documentar en README de tests cuando se cree.

**Arquitectura final Fase C:**

```
┌─────────────────────────────────────────────────────────┐
│                     Frontend (Angular)                  │
│  /dashboard/command-center                              │
│  ├─ CommandCenterService (HTTP /api/commercial/...)    │
│  ├─ AlertsSocketService (socket.io /alerts)            │
│  └─ Component standalone signals + OnPush              │
│      ├─ 4 KPI cards                                    │
│      ├─ Top customers / Top products tables           │
│      ├─ Sales by brand (ProgressBar)                  │
│      ├─ Low stock + Inactive customers                │
│      └─ Realtime alerts feed (cap 20) + toast         │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼ HTTP + WS
┌─────────────────────────────────────────────────────────┐
│                  Backend (NestJS)                       │
│                                                         │
│  ┌─────────────────┐    ┌──────────────────────────┐  │
│  │ Analytics       │    │ Alerts                   │  │
│  │ • Service       │    │ • Gateway /alerts (WS)   │  │
│  │   (MV-first +   │    │ • Service (6 builders)   │  │
│  │    fallback)    │    │ • Scanner @Cron(*/5)     │  │
│  │ • RefreshSvc    │    │   (low_stock, vip_inact) │  │
│  │   @Cron(*/15)   │    │ • Controller test/scan   │  │
│  │ • Controller    │    └──────────────────────────┘  │
│  │   (7+refresh)   │                                  │
│  └─────────────────┘    Hooks: OrdersService.confirm/  │
│                         fulfill emiten alerts          │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   Postgres                              │
│                                                         │
│  commercial.* (10 tablas)    analytics.* (3 MVs)       │
│  • orders, customers, etc.   • mv_sales_overview_30d   │
│                              • mv_top_customers_30d    │
│                              • mv_top_products_30d     │
│                              (UNIQUE idx → CONCURRENTLY)│
│                                                         │
│  RLS forzado en commercial.* + filter explícito en MVs │
└─────────────────────────────────────────────────────────┘
```

**Decisiones técnicas acumuladas en Fase C:**
- Pivot estructural: skip exhibition_products hasta tener data; analytics core comercial primero.
- MVs con UNIQUE indexes para `REFRESH MATERIALIZED VIEW CONCURRENTLY` (lecturas no se bloquean).
- KNEX_NEW_DB_ADMIN provider separado (postgres user) porque REFRESH es owner-only.
- Service refactor con dual-path: MV-first con `?live=true` override + `?from/to` siempre on-the-fly.
- Tenant filter explícito en MVs (Postgres no soporta RLS directo sobre MVs).
- WS gateway con tenant rooms (defense in depth además de RLS).
- 6 alert builders tipados centralizados (no payload construction ad-hoc).
- Cooldown in-memory anti-spam (1h por alert_key).
- Hooks de OrdersService dentro de la trx: trade-off conocido (rollback no des-emite alert).

**Pendientes operacionales (no bloquean Fase D):**
- Fix de boot order para dotenv → JWT_SECRET inline workaround actualmente.
- JwtAuthGuard formal (rechazar sin Bearer con 401 en lugar de 500 / `requireTenantId()` throw).
- @Public decorator para `/auth-mt/login`, `/health`, etc.
- Outbox pattern para alerts post-commit (cuando crezca volumen).
- Cooldown en Redis (cuando haya múltiples instancias del API).

**Siguiente fase:**
- **Fase D — Catálogo + Portal B2B + Pedidos**: app de vendedor offline + portal web cliente self-service. Más grande (4 sprints D.0-D.4). Pre-requisitos: Fase B (✅ cerrada beta) + opcionalmente parte de Fase C (✅ cerrada beta).
- Antes de D, opcionalmente: verificación visual manual del Command Center, o saltar directo a D.0.

---

## 2026-05-26 — Sprint C.4 cerrado — Alertas WS realtime

**Item revisado:** C.4.1 → C.4.9.
**Estado al cierre:** ✅ Hecho.

**Qué se hizo:**

**Backend** (`apps/api/src/modules/commercial-alerts/`):
- `alerts.types.ts`: tipos `Alert`, `AlertType` (low_stock_critical/large_order/vip_inactive/order_confirmed/order_fulfilled/test), `AlertSeverity` (info/warn/critical), constantes `ALERT_THRESHOLDS`.
- `alerts.gateway.ts`: `@WebSocketGateway({ namespace: '/alerts' })`. Handshake JWT (auth.token / Authorization header / query token). Cliente sin auth → emite `auth_error` + `disconnect(true)`. Cliente válido → `socket.join('tenant:<tenant_id>')` + `socket.data = {tenantId, userId, username, roleName}`. Method público `emitToTenant(tenantId, alert)` para enviar a room. Tracking `tenantSockets` Map para stats/debug.
- `alerts.service.ts`: 6 builders tipados que construyen `Alert` + delegan a `gateway.emitToTenant`. `emitLargeOrder` skipea si total < threshold. `emitLowStock` ajusta severity según available_quantity.
- `alerts-scanner.service.ts`: `@Cron('0 */5 * * * *')` cada 5 min. Itera `public.tenants WHERE activo=true`. Para cada tenant abre tx + `SET LOCAL app.tenant_id` + escanea: (a) `commercial.stock` joineado con warehouses + products + brands buscando `(quantity - reserved_quantity) < 50`; (b) customers con `credit_limit >= 15000` cuyo MAX(order.created_at) sea NULL o < NOW() - 14d. Cooldown in-memory 1h por (tenant, alert_key) anti-spam. Flag `isRunning` previene overlapping.
- `alerts.controller.ts`: `POST /commercial/alerts/test` (manual trigger), `POST /commercial/alerts/scan-now` (reset cooldown + scan all), `GET /commercial/alerts/stats`.
- `commercial-alerts.module.ts`: JwtModule embedded con mismo secret que auth-mt (evita mismatch de boot order).
- Hook en `OrdersService`:
  - `confirm()`: tras update, fetch customer name + `alerts.emitOrderConfirmed` + `alerts.emitLargeOrder` (builder maneja threshold).
  - `fulfill()`: tras update, `alerts.emitOrderFulfilled` con customer name + total.

**Frontend** (`apps/view/.../command-center/`):
- `alerts-socket.service.ts`: `@Injectable({providedIn: 'root'})`. `connect()` lee JWT de AuthService, abre socket.io-client al namespace `/alerts` con `path: '/reports/socket.io'`, transports websocket+polling, reconnection. Maneja eventos `connect`, `disconnect`, `alert`, `auth_error`, `connect_error`. Expone `connected` signal + `alert$` Subject. `disconnect()` limpia listeners.
- Command Center component:
  - `ngOnInit`: `alertsSocket.connect()` + subscribe a `alert$`.
  - `ngOnDestroy`: `alertsSocket.disconnect()`.
  - `handleAlert(a)`: append al feed signal (cap 20, most recent first) + toast con severity mapeado (info/warn/critical → info/warn/error). Toast life 8s para critical, 4s otros.
  - Tag visual `● realtime` (severity success) o `○ offline` (secondary) en header.
  - Sección feed visual con últimas alerts: severity tag + title + message + hora HH:MM:SS.

**Decisiones técnicas:**
- **Path WS compartido `/reports/socket.io`** con namespace `/alerts` para evitar configurar segundo adapter en main.ts. Socket.io soporta múltiples namespaces en mismo path.
- **JWT en handshake.auth** (preferido) con fallback a header y query — para compat con clientes que no pueden setear auth (postman, curl tests).
- **Tenant rooms** automáticos en `handleConnection`. Server emite a room, NUNCA broadcast global. Esto garantiza aislamiento al WS level (defense in depth además de RLS).
- **Self-contained payloads**: cada Alert incluye customer_name resuelto, product_name, etc. para que el frontend muestre sin requests adicionales.
- **Cooldown in-memory** (1h) — se pierde al restart. Aceptable para beta (pocas instancias, restarts infrecuentes). Si crece, mover a Redis con TTL.
- **No emite alert si confirm/fulfill rollback**: las emisiones están dentro del callback de `tk.run()`. Si la trx hace rollback, las emisiones YA salieron por WS — trade-off conocido. Para garantía estricta, mover a outbox pattern post-commit (futuro).
- **emitLargeOrder builder maneja el threshold**: si total < LARGE_ORDER_MXN, retorna sin emitir. Esto deja el caller simple (`alerts.emitLargeOrder(tenantId, params)` sin if previo).

**Smoke E2E `database/http-alerts-ws-test.js` — 18/18 PASS:**
1. Login mega_dulces + tenant 2 nuevo (creado en test via Knex directo).
2. WS connect ambos tenants → OK.
3. WS con `xxx_bad_token` → server emite `auth_error` + desconecta dentro de 800ms.
4. `POST /alerts/test` desde tenant 1 → tenant 1 recibe `test` alert; **tenant 2 NO recibe** (aislamiento OK).
5. Create draft → add línea con producto caro x30 → confirm (total >$3k) → recibimos `order_confirmed` + `large_order`. Fulfill → recibimos `order_fulfilled`.
6. `POST /alerts/scan-now` → scanner escaneó 2 tenants y emitió 6 alerts (productos low_stock < 50 que quedaron tras los pedidos del test).
7. `GET /alerts/stats` → `total_sockets >= 2`.

**Acumulado verificado a fin de hoy:**
- B HTTP+isolation: 31
- C.0 analytics: 23
- C.1 MVs: 21
- C.4 alerts WS: 18
- **Total: 93 tests E2E verde**

**Pendientes:**
- Sprint C.5: checkpoint formal de Fase C.
- Verificación visual manual del Command Center con realtime.
- Cuando crezca volumen: outbox pattern para alerts post-commit, cooldown en Redis.

**Siguiente paso:**
- Edgar verifica visualmente, o cerramos Fase C con C.5 checkpoint.

---

## 2026-05-26 — Sprint C.3 MVP cerrado — Frontend Command Center

**Item revisado:** C.3.1 → C.3.7 (MVP). C.3.8-9 deferred, C.3.10 verificación visual pendiente.
**Estado al cierre:** ✅ MVP hecho (faltan items deferred + check visual manual).

**Scope MVP vs plan original:**
- Plan original: mapa Leaflet heatmapped + drill-down zona→ruta→tienda→última visita.
- Scope MVP: dashboards comerciales sin mapa, sin drill-down. Foco en consumir los 10 endpoints C.0+C.1 con 6 widgets útiles desde día 1.
- Deferred: mapa requiere data de stores con lat/lng + agregación por zona; drill-down requiere cruce visitas+pedidos (cuando haya data en ambos).

**Qué se hizo:**
- `apps/view/src/app/modules/dashboard/command-center/`:
  - `command-center.service.ts`: HttpClient inject, métodos para overview, topCustomers, topProducts, salesByBrand, lowStock, inactiveCustomers, refresh.
  - `command-center.component.ts`: standalone, ChangeDetection.OnPush, signals para state, `forkJoin` para cargar 6 endpoints en paralelo, formatters para MXN/fechas, severity helper para low stock.
  - `command-center.component.html`: grid CSS responsive con 4 KPI cards arriba, 2 tablas medias (top customers + top products), sales by brand abajo, 2 tablas inferiores (low stock + inactive customers). PrimeNG: Card/Table/Skeleton/Tag/ProgressBar/Button/Toast.
  - `command-center.component.css`: variables CSS para light/dark theme. Grid responsive `auto-fit minmax(420px, 1fr)`.
- Ruta `/dashboard/command-center` con `permissionGuard(COMMERCIAL_ORDERS_VER)` en `app.routes.ts`.
- Nav item con icono `pi pi-compass` insertado entre Dashboard y Captura Diaria en `layout.component.ts`.
- Permission enum frontend (`apps/view/src/app/core/constants/permissions.ts`) extendido con 14 permisos commercial — ahora en sync con backend.

**Decisiones técnicas:**
- **PrimeNG `severity="warn"` no `"warning"`**: la lib usa el primer string. Trip-up común. Cambio inline en TS+HTML.
- **6 endpoints en `forkJoin` paralelo en `ngOnInit`**: trade-off latency vs reads independientes. Para MVP es OK; si crece, considerar lazy load por widget.
- **Botón Refresh MVs**: dispara `POST /commercial/analytics/refresh` que es admin-only en backend. Sin guard separado por ahora — superadmin tiene todos los permisos. Próximo sprint: gate por `COMMERCIAL_ORDERS_CONFIRMAR` u otro.
- **Signals + OnPush**: cada widget se actualiza independientemente sin re-renders innecesarios.
- **Sin Chart.js para sales-by-brand**: ProgressBar de PrimeNG es suficiente y mucho más liviano. Si crece la complejidad, migrar a Chart.

**Validación:**
- `nx build view` exitoso. Chunk `chunk-CWBIR6O5.js` generado (lazy-loaded vía `loadComponent`).
- Warnings preexistentes NG8107 (optional chain `?.` redundante) sin impacto — vienen de componentes legacy.
- Backend ya verificado con 21+23=44 HTTP tests pasados.

**Pendientes:**
- Verificación visual manual en browser (`http://localhost:4200/dashboard/command-center`) — no automatizable desde CLI assistant.
- Sprint C.4: alertas WS realtime.
- Sprint C.0bis (futuro): exhibition_products normalization cuando aparezca data.
- Items deferred del C.3 original: mapa Leaflet + drill-down.

**Acumulado verificado hasta fin de hoy:**
- Backend HTTP E2E: 18 (B) + 13 (isolation) + 23 (C.0) + 21 (C.1 MV) = 75 tests verde.
- Frontend: build clean + rutas registradas + bundle generado.

**Siguiente paso:**
- Edgar verifica visualmente abriendo browser, o decidimos C.4 (alertas WS).

---

## 2026-05-26 — Sprint C.1 cerrado — Capa analítica con materialized views

**Item revisado:** C.1.1 → C.1.7.
**Estado al cierre:** ✅ Hecho.

**Pivot vs plan original:**
- Plan original C.1: `daily_mix_depth_by_store` + `weekly_top_underperformers` + job BullMQ on `capture:created`.
- Realidad: ambas tablas requieren exhibition data normalizada (Sprint C.0bis), no la tenemos todavía.
- Reorientación: 3 MVs sobre datos comerciales que YA tenemos. Cron @nestjs/schedule en vez de BullMQ (suficiente para volumen actual; migrar a BullMQ cuando crezca).

**Qué se hizo:**
- Migración `100006_analytics_schema_and_mvs.js`:
  - `CREATE SCHEMA analytics` + grants `USAGE` + `DEFAULT PRIVILEGES SELECT` para `app_runtime`.
  - `analytics.mv_sales_overview_30d`: 1 row por tenant con KPIs rolling 30d (revenue/orders por estado/units/unique_customers + `refreshed_at`).
  - `analytics.mv_top_customers_30d`: ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY SUM(total) DESC) → top 50 por tenant.
  - `analytics.mv_top_products_30d`: 2 rankings simultáneos (rank_by_units + rank_by_revenue) con CTE.
  - UNIQUE INDEX en cada MV → habilita REFRESH MATERIALIZED VIEW CONCURRENTLY (lecturas no se bloquean).
- `KNEX_NEW_DB_ADMIN` provider en `NewDatabaseModule`: conexión separada con `DATABASE_URL_NEW` (postgres user). Pool min:0 max:2 (solo mantenimiento). Devuelve `null` si la env no está seteada → consumers chequean.
- `AnalyticsRefreshService`:
  - `@Cron('0 */15 * * * *')` → cada 15 min en :00, :15, :30, :45.
  - `refreshAll(source)` método público: itera las 3 MVs con `REFRESH MATERIALIZED VIEW CONCURRENTLY`, mide ms, devuelve resultados por MV.
  - Flag `isRefreshing` previene corridas overlapping.
  - Skip silencioso si `KNEX_NEW_DB_ADMIN` es null (env no seteado).
- `CommercialAnalyticsService` refactor:
  - `overview()`: si no hay date range y no `live=true`, llama `overview30dFromMv()` (lee de MV con `where tenant_id`). Si hay range o live, fallback a `overviewLive()` (aggregation on-the-fly que ya existía).
  - `topCustomers()`: mismo patrón. MV devuelve `rank` pre-calculado.
  - `topProducts()`: MV devuelve `rank_by_units` y `rank_by_revenue`. Ordering según `orderBy` query param.
  - Cada respuesta incluye `source: 'mv'` o `source: 'live'` para que el cliente sepa de dónde viene.
  - Otros endpoints (inactive-customers, sales-by-brand, low-stock, daily-series) siguen on-the-fly — agregaciones complejas que no se benefician tanto de cache + necesitan datos frescos.
- Endpoint `POST /api/commercial/analytics/refresh` manual.

**Decisiones técnicas:**
- **RLS no soportado en MVs**: Postgres rechaza `ENABLE ROW LEVEL SECURITY` sobre materialized views. Workaround: service filtra `where tenant_id = current_tenant_id()` explícitamente en cada query de MV. Defense in depth: app_runtime solo tiene SELECT, refresh corre como postgres (sin context, ve todos los tenants), service code es 1 lugar auditable.
- **CONCURRENTLY refresh**: requiere UNIQUE INDEX. Sin él, refresh requiere lock exclusivo. Con él, lecturas siguen sirviendo data vieja durante refresh.
- **Cron `*/15`** (no más frecuente): testdata refresh tarda <100ms, pero las MVs son rolling 30d — granularidad de 15 min es más que suficiente. Para latencia menor en evento crítico (ej. `order:fulfilled`), agregar trigger event listener en próximo sprint.
- **Source field en respuesta**: ayuda al frontend a mostrar "Updated 2 min ago" para MVs vs "Live" para queries on-demand. También facilita debugging.
- **No materialicé inactive-customers / low-stock / daily-series**:
  - low-stock cambia con cada movimiento → debe ser fresh.
  - inactive-customers depende de NOW() (rolling window dinámica) → MV se desactualiza rápido.
  - daily-series ya es eficiente con índices existentes.

**Validación:**
- HTTP smoke 21/21:
  - source='mv' default en 3 endpoints.
  - `?live=true` cambia a source='live'.
  - Datos numéricos coinciden entre MV y live (mismas reglas: solo fulfilled, mismo período cuando aplicable).
  - POST /refresh devuelve `{refreshed_at, results: [{mv, ok, ms}]}` con 3 entries.
  - Refresh OK: 58ms (sales_overview) + 15ms (top_customers) + 12ms (top_products) = 85ms total.
  - `refreshed_at` en mv_sales_overview_30d avanza después de refresh.
  - Tenant 2 nuevo (creado vía Knex directo, sin orders) NO ve ninguna fila en MVs (filter explícito por tenant_id funciona como esperado).

**Métricas iniciales (rolling 30d sobre testdata):**
- Revenue gross $4,244.32 / 3 fulfilled / 3 unique customers.
- Top customer: Abarrotes La Esquina ($3,971.84, rank=1).
- Top product (revenue): Pulparindo 20pz ($1,670.40, 30 units).

**Pendientes para C.2+:**
- Sprint C.3 — Frontend Command Center: dashboard Angular consumiendo los 10 endpoints (`overview`, `top-customers`, `top-products`, `inactive-customers`, `sales-by-brand`, `low-stock`, `daily-series`, `refresh`, `top-customers ?live`, `top-products ?live`). Idealmente con Leaflet para mapa de tiendas por zona.
- Sprint C.4 — Alertas WS realtime: low-stock crítico, pedidos grandes, customers inactivos VIP, etc.
- Sprint C.0bis (cuando aparezca data de exhibiciones): normalizar `exhibition_products` para cruzar con ventas.

**Siguiente paso:**
- Definir con Edgar: C.3 (frontend) o C.4 (alertas WS).

---

## 2026-05-26 — Sprint C.0 cerrado — Analytics core comercial (pivot vs plan original)

**Item revisado:** C.0.1 → C.0.4.
**Estado al cierre:** ✅ Hecho.

**Pivot del scope original:**
- Plan original C.0: normalizar `exhibitions.productos` (JSONB) → tabla `exhibition_products` para joins.
- Realidad: las exhibiciones legacy están en `daily_captures.exhibiciones[i].productos` (JSONB), y NO hay todavía un flujo activo de capturas con volumen significativo. Normalizar ahora sería trabajo especulativo.
- Decisión: redefinir Sprint C.0 como **analytics core sobre `commercial.*`** (data que YA tenemos cargada). Entregar valor inmediato. La normalización exhibition_products queda como Sprint C.0bis cuando haya data real de exhibiciones.

**Qué se hizo:**
- Módulo nuevo `apps/api/src/modules/commercial-analytics/` con service + controller + module.
- 7 endpoints REST bajo `/api/commercial/analytics/*`:
  1. `overview` — KPIs del período: revenue gross/net/tax/currency, orders por estado (fulfilled/confirmed/draft/cancelled), AOV, units_sold, unique_customers.
  2. `top-customers` — ranking por revenue con orders_count, avg_order_value, last_order_at.
  3. `top-products` — ranking SKU por units o revenue, con orders_count y brand_name.
  4. `inactive-customers` — customers activos sin pedido confirmado/fulfilled en N días (oportunidad recuperación). Devuelve threshold_days + customers array con days_since_last_order.
  5. `sales-by-brand` — revenue + units por brand + share % del total.
  6. `low-stock` — items con `available_quantity = quantity - reserved_quantity < threshold`. Filtrable por warehouse.
  7. `daily-series` — series diarias agrupadas por DATE_TRUNC en TZ MX para gráficos.
- Wireado en `AppModule` dentro de toggle `ENABLE_MULTITENANT`.
- Build OK + HTTP smoke 23/23 en `database/http-analytics-test.js`.

**Decisiones técnicas:**
- **Solo `status='fulfilled'` cuenta para revenue real**. Confirmed = pipeline (no revenue), draft/cancelled = ignorados. Esto evita inflar KPIs con pedidos que no van a cobrarse.
- **Aggregations on-the-fly** sin schema `analytics.*` ni vistas materializadas. Para testdata < 1000 rows es suficiente. Migrar a `analytics.*` con cron-refreshed views cuando volúmenes lo justifiquen (Sprint C.1).
- **TZ MX en daily-series** vía `created_at AT TIME ZONE 'America/Mexico_City'` para que los días reflejen el cierre comercial local (no UTC).
- **share_pct calculado app-side** (no en SQL) para evitar problemas con DIV BY ZERO cuando no hay revenue.
- **Validación de date range** con `BadRequestException` (400) cuando ISO inválido. Confirmed funciona retornando 400.

**Validación con testdata:**
- Total: revenue $4,244.32 / 3 fulfilled / 80 units / 2 unique customers.
- Top customer: `Abarrotes La Esquina` con $3,971.84 (el pedido E2E del smoke B.2).
- Top product: `Pulparindo 20pz` (Dulces Típicos MX) — 30 units, $1,670.40.
- Top brand: Dulces Típicos MX 39.36% share.
- Inactive (7d): 22 customers (la mayoría de testdata jamás compró todavía).
- Low-stock (threshold=300): 5 productos.

**Pendientes para Sprint C.1+:**
- Schema `analytics.*` con vistas materializadas refrescadas por cron (cuando volúmenes lo justifiquen).
- Cross-domain analytics: cruzar visitas/exhibiciones legacy con orders nuevos — requiere datos en ambos sistemas con tenant_id consistente.
- Command Center frontend con mapa Leaflet (Sprint C.3).
- Alertas en tiempo real via WS (Sprint C.4).

**Siguiente paso:**
- Definir con Edgar si seguimos con C.1 (analytics schema avanzado) o saltamos a C.3 (frontend Command Center que consume los 7 endpoints de C.0).

---

## 2026-05-26 — Verificación E2E HTTP Fase B + wiring multi-tenant final

**Item revisado:** Verificación integral pre-Fase C.
**Estado al cierre:** ✅ Hecho. 31/31 verificaciones HTTP pasaron.

**Motivación:**
Edgar preguntó si verificamos el funcionamiento de lo que llevamos hecho. Hasta este punto solo teníamos smoke tests con queries Knex directas, no via HTTP/JWT/interceptor. Era necesario validar la cadena completa antes de avanzar a Fase C.

**Gaps encontrados y resueltos:**

1. **Circular import KNEX_NEW_DB** (CRÍTICO):
   - `new-database.module.ts` importaba `TenantKnexService`, que a su vez importaba `KNEX_NEW_DB` de `new-database.module.ts`.
   - Fix: `tenant-knex.service.ts` ahora usa el string token `'KNEX_NEW_DB'` directamente (sin import del const). El token sigue siendo el mismo que el `provide:` del provider.

2. **TenantContextInterceptor NO estaba wireado globalmente** (CRÍTICO):
   - Sin el interceptor, `request.user.tenant_id` nunca se poblaba → `TenantContextService.requireTenantId()` lanzaba en cada request commercial.
   - Fix:
     a. Modificado `TenantContextInterceptor` para decodear el Bearer JWT **inline** (no requiere `JwtAuthGuard` ni passport-jwt) usando `JwtService` inyectado.
     b. `TenantModule` ahora importa `JwtModule.register({secret})`.
     c. `AppModule` registra `APP_INTERCEPTOR` con `TenantContextInterceptor` condicionalmente cuando `ENABLE_MULTITENANT=true`.
   - Decisión: el interceptor es **passive** (no rechaza requests sin auth — solo no abre scope). Los services siguen siendo strict via `requireTenantId()`. La autorización formal (rechazo de requests sin Bearer) la hará un guard cuando se wire en cutover prod.

3. **JWT secret mismatch entre auth-mt y TenantModule** (CRÍTICO):
   - `auth-mt` usaba `'dev_secret_change_in_prod'` como fallback default; `TenantModule` usaba `'super_secret_dev_key_change_in_prod'`.
   - Cuando `dotenv.config()` carga JWT_SECRET DESPUÉS de la evaluación de los decoradores `@Module`, ambos modules usan sus defaults distintos → verify() falla con "invalid signature".
   - Fix inmediato: unificado el default de auth-mt al mismo string. El fix real (cargar dotenv antes de imports) queda para sprint dedicado de boot order.
   - Mitigación operacional: arrancar API con `JWT_SECRET=...` inline en env hasta el fix de boot.

**HTTP E2E test suite (`database/http-e2e-test.js`) — 18/18 PASS:**

| # | Test | Resultado |
|---|---|---|
| 1 | `POST /api/auth-mt/login` con creds mega_dulces/superoot devuelve JWT | OK |
| 2-6 | Customers: GET paginado + total ≥ 20, POST create, PATCH update, search ?search=, soft-delete | 5/5 OK |
| 7 | `GET /api/commercial/warehouses` incluye MD-CENTRAL | OK |
| 8-9 | `GET /api/commercial/price-lists` incluye BASE-MXN; lista de prices con 25+ productos | 2/2 OK |
| 10 | `GET /api/commercial/inventory/stock` paginado con `available_quantity` calculado | OK |
| 11-16 | Order flow completo via HTTP: pickup customer → create draft → add line con totals → confirm → fulfill → GET detalle con lines | 6/6 OK |
| 17 | Request sin Authorization Bearer → 500 (TenantContext no seteado, comportamiento esperado pre-guard) | OK |
| 18 | Bearer JWT inválido → 500 (verify() falla, no abre scope) | OK |

**Tenant isolation test suite (`database/http-tenant-isolation-test.js`) — 13/13 PASS:**

- Setup: creado tenant `tenant_isolation_test` (UUID `00000000-0000-0000-0000-000000002222`) + role superadmin + user `isouser`.
- Login OK con tenant 2 → JWT incluye `tenant_id=...2222`.
- Tenant 1 (mega_dulces) ve: 21 customers, 3 warehouses, 1 price-list, 29 stocks, 3 orders.
- Tenant 2 (iso) ve: **0 customers, 0 warehouses, 0 price-lists, 0 stocks, 0 orders**.
- `GET /commercial/customers/<UUID-de-tenant-1>` desde tenant 2 → **404** (no leak por UUID directo).
- Cleanup: tenant 2 + dependencies eliminados.

**Conclusión:**
✅ Cadena completa funciona end-to-end: HTTP → JWT decode → AsyncLocalStorage → service → TenantKnexService → `SET LOCAL app.tenant_id` → RLS filter → respuesta correcta. Aislamiento entre tenants garantizado a 4 niveles (FK composite, RLS USING, RLS WITH CHECK, app-side `requireTenantId()`).

**Pendientes operacionales (no bloquean Fase C):**
- Fix de boot order para que `dotenv.config()` corra antes de evaluación de decoradores.
- JwtAuthGuard formal que rechace requests sin Bearer con 401 en vez de 500.
- @Public decorator para `/auth-mt/login`, `/health`, etc.

**Siguiente paso:**
- **Fase C — Sales Intelligence ampliado** sin restricciones técnicas. La base multi-tenant + commercial está sólida.

---

## 2026-05-26 — Fase B cerrada (beta scope) — Carga de testdata + smoke E2E

**Item revisado:** B.3.2 (cierre de Fase B beta).
**Estado al cierre:** ✅ Hecho.

**Decisión:** Edgar pidió continuar con test data en lugar de esperar la real ("hagamoslo con datos de prueba por el momento"). Cuando llegue la data real de Mega Dulces, se reemplazan los archivos en `database/importers/testdata/` y se re-corre el importer (idempotente).

**Qué se cargó (sabor distribuidora de dulces):**
- **5 brands**: Chocolates Premium, Dulces Típicos MX, Chicles & Gomitas, Paletas y Helados, Galletas y Snacks.
- **25 products**: 5 por brand (trufas, pulparindo, gomitas frutales, paleta payaso, galletas marías, etc.).
- **25 prices** en `BASE-MXN` con `min_qty` realista (paletas glaseadas requieren 12, almendras 6, resto 1) y IVA 16%.
- **20 customers** con códigos `TST-0001` a `TST-0020`, créditos entre $0 y $25,000, payment_terms 0-30 días.
- **25 stock entries** iniciales en `MD-CENTRAL` (saldos entre 120 y 2,400 unidades).

**Validación final E2E:**
- Pedido `PD-2026-00002` para `Abarrotes La Esquina` (TST-0001):
  - 5x Trufas Surtidas @ $180 = $1,044 (con IVA)
  - 30x Pulparindo @ $48 = $1,670.40
  - 8x Gomitas Frutales @ $110 = $1,020.80
  - 24x Paleta Glaseada Caramelo @ $8.50 = $236.64
  - **Total $3,971.84** (sub $3,424 + IVA $547.84)
- Stock decrementado exactamente: 120→115, 1200→1170, 400→392, 2400→2376.
- 8 movements creados (4 reserve + 4 sale), trazables por `reference_id=orderId`.

**Estado de Fase B:**
- ✅ B.0 Schema (9 tablas comercial + RLS)
- ✅ B.1 4 módulos NestJS (customers/warehouses/pricing/inventory)
- ✅ B.2 Orders state machine + sequential code (sin payments en beta)
- ✅ B.3 Importer CLI + testdata cargada
- 🟢 **Fase B = CERRADA (beta scope)**

**Pendiente post-beta:**
- PaymentsService (B.2.8 deferred).
- Reemplazar testdata por data real cuando Edgar la provea.

**Siguiente paso:**
- **Fase C — Sales Intelligence ampliado**: cruzar visitas (trade marketing existing) con pedidos (Fase B nuevo) para detectar oportunidades. Modelo `exhibition_products` + capa analítica + Command Center frontend.

---

## 2026-05-26 — Sprint B.3.1 cerrado — Importer CLI comercial

**Item revisado:** B.3.1 (B.3.2 BLOCKED esperando data real de Edgar).
**Estado al cierre:** ✅ Hecho (parcial — B.3.2 espera input).

**Qué se hizo:**
- CLI `database/importers/commercial_import.js` con 6 importers idempotentes:
  - `customers` — upsert por `(tenant_id, code)`. Valida RFC MX, code regex, lookup de `default_price_list_code`.
  - `brands` — upsert por `(tenant_id, nombre)`.
  - `products` — upsert por `(tenant_id, brand_id, nombre)`. Lookup de brand por nombre.
  - `warehouses` — upsert por `(tenant_id, code)`.
  - `prices` — upsert por `(tenant_id, price_list_id, product_id)`. Requiere `--price-list-code`. Lookup de productos por `brand_nombre + product_nombre`.
  - `stock` — UPDATE saldo + INSERT movement `adjust` con delta vs anterior. Requiere `--warehouse-code`.
- Args: `--type=<X>`, `--file=<path>`, `--tenant-slug=<slug>`, `--dry-run`, `--price-list-code=<C>`, `--warehouse-code=<W>`.
- Reporte por corrida: total / upserted / skipped / first 10 errors / elapsed ms.
- Exit codes: 0 OK, 1 fatal (file/tenant inexistente), 2 corrió pero algunos rows fallaron.
- 6 archivos `examples/*.json` con shapes válidos.
- `README.md` con instrucciones de uso, conflict keys por entidad, orden de carga recomendado.

**Decisiones de diseño:**
- **Lookup por nombre natural en vez de UUIDs**: el dueño de la data (Edgar) tiene nombres en su Excel/ERP, no UUIDs. Hacer `brand_nombre` + `product_nombre` resolver internamente es mucho más usable. Trade-off: si hay productos con mismo nombre en distinta brand, se distinguen porque la key es composite `brand||nombre`.
- **Stock como `adjust` movement con delta**: en lugar de inserción cruda, calcula la diferencia vs saldo actual y emite movement con el delta. Esto mantiene la bitácora consistente y permite auditar quién hizo la carga (vía `reference_type='import'`).
- **Sin Zod en el importer**: validaciones inline simples (regex + typeof checks). Razón: el importer es CLI corto-vivido, no vale agregar dep extra cuando el código es lineal. Si la complejidad crece, migrar a Zod.
- **Usa `DATABASE_URL_NEW` (postgres), no `app_runtime`**: simplifica resolución cross-table de FKs (brands, products, price_lists, warehouses) en una sola conexión. RLS se respeta vía `SET LOCAL app.tenant_id` igual.
- **Idempotencia agresiva**: `.onConflict(...).merge(['...', 'updated_at'])` permite re-correr sin duplicar y refrescar valores cambiados. Útil para sync nocturnos futuros.

**Validación:**
- 6 importers ejecutados end-to-end con `examples/`: 3 customers, 2 brands, 3 products, 3 prices, 2 warehouses (MD-NORTE, MD-SUR), 3 stock entries. Total 16/16 upserted, 0 skipped.
- Re-run de customers: 3/3 upserted otra vez (sin duplicar — verificado).
- Dry-run con row inválido (`name=""`): correctamente reportado como skipped 1/1 con razón.

**Pendientes:**
- B.3.2 BLOCKED waiting on Edgar — necesita los archivos JSON reales de Mega Dulces (customers + catálogo + precios + stock).
- Documentar en Fase B doc cuál fue el orden real de carga y qué se encontró (cuando llegue data).

**Siguiente paso:**
- Si Edgar provee archivos → ejecutar carga real y cerrar B.3.2.
- Si no → arrancar **Fase C — Sales Intelligence ampliado** (modelo `exhibition_products` + capa analítica + Command Center frontend).

---

## 2026-05-26 — Sprint B.2 cerrado — Módulo de pedidos (sin payments en beta)

**Item revisado:** B.2.1 → B.2.7 (Sprint B.2 completo, B.2.8 PaymentsService deferred por decisión usuario).
**Estado al cierre:** ✅ Hecho.

**Decisión de scope (2026-05-26):**
- Usuario solicitó remover PaymentsService de B.2: "en beta no necesitamos un payment service por el momento".
- Tabla `commercial.payments` se mantiene en DB (sin uso en código).
- `orders.paid_amount` queda en 0 y `balance_due` = `total` permanentemente hasta que se active el módulo.
- Reactivar como Sprint dedicado cuando salgamos de beta.

**Qué se hizo:**
- Migración `20260526100005_commercial_order_sequences.js`: tabla `commercial.order_sequences (tenant_id, year, current_value)` con PK composite + RLS forzado + CHECK constraints + FK CASCADE a tenants.
- Módulo `commercial-orders` con `CommercialOrdersService`:
  - `createDraft(customer_id, warehouse_id, notes?)`: valida customer/warehouse activos, genera code, snapshot de price_list aplicable.
  - `addLine` / `updateLine` / `removeLine`: solo si status=draft, resuelve precio via `CommercialPricingService.resolvePriceForCustomer()` (customer→tenant default), snapshot inmutable de unit_price/tax_rate/discount_percent, recalc automático de totals.
  - `confirm()`: state transition draft→confirmed, reserva stock inline en mismo trx (FOR UPDATE anti-race), genera `reserve` movements con `reference_type='order'`.
  - `fulfill()`: confirmed→fulfilled, `sale` movements decrementan `quantity` y `reserved_quantity` atómicamente.
  - `cancel(reason?)`: desde draft (nada que liberar) o confirmed (`release` movements). Rechaza desde fulfilled (requiere flujo de devolución, fuera de scope).
  - `findById` (con líneas), `list` (paginado con filtros status/customer/user/fechas).
- `nextCode()` privado: UPSERT atómico Postgres
  ```sql
  INSERT INTO commercial.order_sequences (tenant_id, year, current_value)
  VALUES ($1, $2, 1)
  ON CONFLICT (tenant_id, year) DO UPDATE
    SET current_value = order_sequences.current_value + 1
  RETURNING current_value
  ```
- Controller con endpoints REST completos (`POST /api/commercial/orders`, líneas, transiciones, listado).
- Módulo wireado en AppModule dentro del toggle `ENABLE_MULTITENANT`.
- Smoke E2E `database/test-newdb-orders-flow.js`: setup stock 200 → create draft → add line (qty 10, unit 9.99, tax 16%) → confirm (10 reserved) → fulfill (10 sale, stock 200→190) → asserts final state. Movements `reserve:10 → sale:10`.

**Decisiones técnicas:**
- **Stock helpers inline, no via inventory.recordMovement()**: la `tk.run()` de inventory abre su PROPIA transacción. Para mantener atomicidad del confirm/fulfill completo (todas las reservas atómicas o ninguna), las operaciones de stock se hacen con la trx del orders flow. Si una línea falla por stock insuficiente, todo el confirm rollbackea automáticamente.
- **Snapshot de precio en order_lines**: `unit_price`, `tax_rate`, `discount_percent` se persisten al momento de agregar la línea. No se rehidratan desde `product_prices`. Esto garantiza que el total del pedido es estable aunque la lista de precios cambie después.
- **min_qty validado en addLine**: si el price tiene `min_qty=5` y el usuario pone qty=3, rechaza.
- **Cancel desde fulfilled no permitido**: requiere flujo de devolución que escribiría movements `in` para reponer stock. Fuera de scope beta.
- **`code` generator atomic via UPSERT**: probado que Postgres garantiza increment correcto bajo concurrencia. Alternativa con SEQUENCE descartada porque no son tenant-aware ni year-aware.

**Validación:**
- Build webpack OK (warnings preexistentes de `export interface` strippeados por TS — no afectan runtime).
- Smoke test end-to-end OK: pedido PD-2026-00001 con flujo completo + verificación de stock + movimientos.

**Pendientes que NO son B.2:**
- B.3: Importer CLI + carga real de Mega Dulces.
- PaymentsService (B.2.8 deferred post-beta).
- Tests integración formales (cuando se active el wiring de Jest para nueva DB).

**Siguiente paso:**
- Sprint B.3 — Importer CLI `database/importers/commercial_seed.js` que lea JSON/CSV de Mega Dulces y upsertee customers/products/prices.

---

## 2026-05-26 — Sprint B.1 cerrado — Módulos NestJS comerciales

**Item revisado:** B.1.1 → B.1.8 (Sprint B.1 completo).
**Estado al cierre:** ✅ Hecho.

**Qué se hizo:**
- 4 módulos NestJS nuevos bajo `apps/api/src/modules/commercial-*/`:
  - `commercial-customers`: CRUD completo. Validaciones: code `[A-Z0-9_-]{2,50}`, RFC MX regex, UUIDs, Zod address. Lista paginada con search por name/code/rfc/email.
  - `commercial-warehouses`: CRUD + `is_default` exclusivo (auto-clear al setear nuevo default) + protección al borrar último default.
  - `commercial-pricing`: CRUD `price_lists` + `bulk-upsert` de prices (cap 1000 items, onConflict merge). Endpoint `GET /commercial/products/:id/price?customer_id=` resuelve customer→tenant default→null.
  - `commercial-inventory`: stock listing paginado + per-product. Movements con `SELECT ... FOR UPDATE` para evitar race entre reservas. State machine de tipos (in/out/adjust/reserve/release/sale) con validaciones de saldo disponible vs reservado. `adjustStock()` toma saldo absoluto y calcula delta.
- Permission enum extendido con 14 permisos comerciales nuevos.
- Seed `02_mega_dulces_initial_roles.js` actualizado: superadmin/admin todo, supervisor lectura+confirmar/cancelar/fulfill, jefe_marketing solo lectura, colaborador toma pedidos + cobros. Re-corrido via knex seed:run.
- `AddressJsonbSchema` en `jsonb-schemas.ts` (calle, número ext/int, colonia, CP MX 5 dígitos, lat/lng).
- `TenantKnexService` registrado como provider exportado por `NewDatabaseModule` (antes era clase sin DI registration).
- 4 módulos wireados en `AppModule` dentro del toggle `ENABLE_MULTITENANT=true`.

**Decisiones tomadas:**
- **Lock pesimista en stock**: `SELECT ... FOR UPDATE` durante reservas para prevenir double-spending en pedidos concurrentes. Más simple que optimistic locking con version column; si crece la carga se puede migrar.
- **Bulk upsert cap 1000 items**: límite arbitrario para evitar payloads gigantes. Si se necesita más, partir en batches.
- **`tenant_id` via `current_tenant_id()`** en cada INSERT — no se confía en lo que mande el caller, RLS WITH CHECK validaría de todos modos pero esto es defense in depth.
- **DTOs como interfaces TS** (no clases con decoradores). El service valida con regex/range checks + Zod para JSONB. Razón: evita la complejidad de class-transformer + ValidationPipe global y nos da mensajes de error en español sin gimnasia adicional.
- **Soft-delete** con `deleted_at` en customers, warehouses, price_lists, product_prices. Inventory movements son append-only (no soft delete).

**Validación:**
- Build webpack OK (warnings preexistentes de `export interface` que TS strippea — no afectan runtime, mismos warnings que tenants-admin y visitas-sync).
- Smoke test end-to-end con queries reales: CREATE customer + ILIKE search + UPDATE + bulk upsert prices con 2 productos reales + stock movement `in 100` + soft delete. Todo OK.

**Pendientes que NO son B.1:**
- B.2: OrdersService state machine + payments + generador secuencial.
- B.3: importer CLI + carga real Mega Dulces.

**Siguiente paso:**
- Sprint B.2 — empezar por `OrdersService` con state machine `draft → confirmed → fulfilled/cancelled` + integración con `commercial-inventory` para reserva/consumo.

---

## 2026-05-26 — Sprint B.0 cerrado — Core comercial schema base (pivot Kepler)

**Item revisado:** B.0.1 → B.0.6 (Sprint B.0 completo).
**Estado al cierre:** ✅ Hecho.

**Contexto / pivot:**
- Premisa original Fase B: integrar con ERP Kepler vía Postgres FDW.
- Realidad descubierta 2026-05-26: **Kepler no existe todavía** — Mega Dulces no tiene ERP.
- Decisión: construir el core comercial directamente sobre `commercial.*` en `postgres_platform`. Si más adelante aparece un ERP, se integra via FDW o sync hacia estas tablas.
- Doc `FASE_B_INTEGRACION_KEPLER.md` marcado DEFERRED. Plan vigente: `FASE_B_COMERCIAL_CORE.md`.

**Qué se hizo:**
- 4 migraciones nuevas en `database/migrations-newdb/` (batch 8):
  - `100001_commercial_customers_warehouses.js`: customers + warehouses + schema `commercial`.
  - `100002_commercial_pricing.js`: price_lists + product_prices + FK deferida en customers.
  - `100003_commercial_inventory.js`: stock (UNIQUE wh+product) + stock_movements (append-only).
  - `100004_commercial_orders_payments.js`: orders + order_lines + payments con CHECK `payment_method='cash'` (beta).
- 9 tablas creadas. Todas con composite FK `(tenant_id, id)` + RLS forzado + grants `app_runtime`.
- Cross-schema FKs (a `public.tenants`, `public.users`, `public.products`, `public.stores`) implementadas via raw ALTER TABLE.
- Seed `04_mega_dulces_commercial_baseline.js`: warehouse `MD-CENTRAL`, price_list `BASE-MXN`, customer `DEMO-001`.
- Smoke test RLS: 0 rows sin contexto / 1 row con tenant Mega Dulces / 0 rows con tenant fake. ✅

**Decisiones tomadas:**
- **Pago cash-only en beta** via CHECK constraint en `orders.payment_method` y `payments.payment_method`. Documentado cómo expandir cuando se agreguen otros métodos.
- **Snapshot de precios** en `order_lines` (unit_price, tax_rate, discount_percent) — no rehidratar desde price_lists para estabilidad del total.
- **Customer vs Store**: separados, con FK opcional `customers.store_id` para tiendas que son ambas cosas.
- **Inventario sync app-side** (no trigger por ahora) — más debuggeable; si surge corrupción por concurrencia, agregar trigger.
- **Tax rate por producto** (no global) para soportar productos exentos / tasa cero.

**Pendientes que NO son B.0:**
- Sprint B.1: módulos NestJS CRUD (customers/warehouses/pricing/inventory).
- Sprint B.2: flujo de pedidos + state machine + reserva/consumo de stock + payments.
- Sprint B.3: importer CLI + carga real de Mega Dulces + cierre.

**Siguiente paso:**
- Sprint B.1 — empezar por `commercial-customers` module + extender enum `Permission` con permisos comerciales.

---

## 2026-05-26 — Inicialización del sistema de tracking

**Item revisado:** N/A (setup inicial)
**Estado:** N/A

**Qué se hizo:**
- Creado `docs/IMPLEMENTACION/` con estructura de tracking.
- Roadmap general en `00_ROADMAP_GENERAL.md` con 9 fases (A → I).
- Tracker kanban en `01_TRACKER_PROGRESO.md`.
- ADR log en `02_DECISIONES_ARQUITECTURA.md` con plantilla + 8 ADRs iniciales (1 aceptado, 6 pendientes).
- Este archivo de log de revisiones.

**Próximo paso:**
- Iniciar **Sprint A.0** — limpieza inmediata: borrar archivos `.js` duplicados, actualizar `.gitignore`, documentar setup en `README.md`, arrancar trámite WhatsApp Business.

---

## 2026-05-26 — Auditoría profunda de la base existente (Sprint A.-1)

**Item revisado:** A.-1.1 → A.-1.5 (auditoría completa)
**Estado al inicio:** No iniciado
**Estado al cierre:** ✅ Hecho

**Qué se revisó:**
- Schema de DB y 84 migraciones (`database/migrations/`).
- Backend NestJS: 85 archivos `.ts`, 17 módulos.
- Frontend Angular: ~70 componentes + servicios.
- Config/seguridad: Dockerfile, start.sh, nginx.conf, main.ts, .env, .gitignore.

**Hallazgos:** **60 issues totales**
- 🔴 **19 críticos** (vulnerabilidades + bloqueantes técnicos)
- 🟡 **25 importantes** (deuda técnica significativa)
- 🟢 **16 nice-to-have** (cosmético)

**Hallazgos críticos por dominio:**
- DB: migraciones no idempotentes, audit fields fragmentados, roles con naming inconsistente, FKs sin índices, JSONB sin validación.
- Backend: 3 god services (1399 + 788 + 379 LOC), DTOs aceptando `any`, catches silenciosos en cron, `.js` basura en git.
- Frontend: 3 mega-componentes (3047 + 1801 + 1356 LOC), 3 mega-servicios, mix signals + BehaviorSubject, sin interceptor global de errores.
- Seguridad: CORS `origin: '*'` con credentials, JWT secret con fallback inseguro, credenciales en `.env`, `console.log` con data sensible, vulnerabilidades npm HIGH (Angular XSS, NestJS path-to-regexp).

**Acciones tomadas:**
- Documento consolidado generado: `AUDITORIA_BASE_INICIAL.md`.
- Sprint A.0bis agregado al tracker con 26 items en 5 bloques de prioridad.
- ADR-004 (Kepler MSSQL) marcado como superseded → ADR-009 (Kepler Postgres con `postgres_fdw`).
- Fase B reescrita simplificada con stack Postgres-to-Postgres.

**Siguiente paso:**
- Empezar **Sprint A.0bis Bloque 1 (Seguridad inmediata)** con item `[A.0bis.1]`: cerrar CORS abierto en `main.ts`.
- Estimado para cerrar el Sprint A.0bis completo: 5-7 semanas.

---

## 2026-05-26 — Setup del modo de trabajo + decisión multi-tenant

**Tipo:** Decisión estratégica + setup de tracking
**Estado al cierre:** ✅ Configurado

**Qué se decidió:**
- **Modo de trabajo**: todo el desarrollo se hará desde este chat con Claude. No habrá onboarding para humanos. Los `.md` son la memoria entre sesiones; mantenerlos vivos es mandatorio.
- **Multi-tenancy ACEPTADO** (ADR-010): vamos a crear una DB Postgres nueva con schema multi-tenant desde el origen. Mega Dulces será el primer tenant.
- **Approach**: shared DB + `tenant_id` en todas las tablas + Postgres RLS como defense-in-depth.
- **DB legacy queda en paralelo** hasta cutover.
- **Plan correctivo del audit (Sprint A.0bis)**: gran parte se aborbe automáticamente al crear schema limpio en nueva DB.

**Qué se creó:**
- Nuevo sprint en tracker: `A.0-multitenant` con 5 sub-sprints + checkpoint (35 items).
- Plan detallado en [`FASES/FASE_A0_MULTITENANT_NEW_DB.md`](FASES/FASE_A0_MULTITENANT_NEW_DB.md).
- ADR-010 documentado.
- ADR-003 marcado como superseded por ADR-010.
- Tracker mejorado con estados granulares: ⬜ TODO · 🔨 EN CÓDIGO · 🧪 PROBADO · 🚀 STAGING · ✅ PROD · ⚠️ BLOCKED · ❌ REVERTED.
- CLAUDE.md actualizado con el modo de trabajo + sprint en curso.
- INDEX.md actualizado.
- Items A.0bis.1-3 (CORS, JWT, credenciales) marcados ⚠️ BLOCKED por decisión del usuario.

**Qué se limpió:**
- Borrado `docs/ONBOARDING.md` (no aplica — todo via chat).
- Borradas carpetas vacías `docs/RUNBOOKS/`, `docs/PLANTILLAS/`, `.github/ISSUE_TEMPLATE/`.

**Siguiente paso:**
- **`[A.0mt.1.1]`** — Crear servicio Postgres nuevo en Railway (separado del actual). Es el primer item del Sprint A.0-multitenant.

---

## 2026-05-26 — Sub-sprint A.0mt.1 cerrado: aprovisionamiento + schema base nueva DB

**Tipo:** Sprint checkpoint
**Items revisados:** A.0mt.1.1 → A.0mt.1.6 (6 items)
**Estado al cierre:** ✅ TODOS COMPLETADOS

**Qué se logró:**
- **DB `postgres_platform` operando local** en `192.168.0.245:5432` (Postgres 18.4).
- **Tabla `tenants`** creada con audit timestamps + soft-delete + jsonb metadata.
- **Mega Dulces seedeado** como primer tenant con UUID `00000000-0000-0000-0000-00000000d01c`.
- **Función Postgres `current_tenant_id()`** lee el tenant del contexto de sesión via `current_setting('app.tenant_id', true)::uuid`.
- **Extensión `pgcrypto`** habilitada para `gen_random_uuid()`.
- **Knexfile separado** `database/knexfile-newdb.js` con dotenv loading explícito (resuelve issue de Knex CLI que cambia cwd).
- **Directorios paralelos** `database/migrations-newdb/` y `database/seeds-newdb/` para no contaminar legacy.
- **Helper TypeScript** `TenantKnexService` + `runWithTenant()` + `setTenantContext()` en `apps/api/src/shared/database/tenant-knex.service.ts`. Usa `SET LOCAL app.tenant_id` (no SET regular) para evitar leaks cross-request en el pool de Knex.
- **Validación regex anti-injection** en el tenantId antes de interpolar (Postgres no soporta `SET` con parameter binding).
- **Test end-to-end** `database/test-newdb-tenant-context.js`: 8/8 pass, incluye aislamiento entre 2 transacciones concurrentes con tenants distintos.

**Lecciones aprendidas:**
- Knex CLI cambia `cwd` a `database/` al cargar el knexfile → hay que cargar dotenv con path absoluto (`path.resolve(__dirname, '..', '.env')`) o las env vars no llegan.
- `SET LOCAL` (no `SET`) es mandatorio en Postgres para tenancy correcto: garantiza que el valor se reset al COMMIT/ROLLBACK y no leak por el pool de conexiones.
- Postgres NO acepta parameter binding en `SET` → validar tenantId con regex UUID antes de interpolar es la forma correcta.

**Archivos creados/modificados:**
- `.env` (vars NEW_DB_* + DATABASE_URL_NEW agregadas localmente, no commiteadas)
- `.env.example` (template con todas las vars)
- `database/knexfile-newdb.js` (knexfile separado)
- `database/migrations-newdb/20260526000001_init_tenants_and_extensions.js`
- `database/seeds-newdb/01_first_tenant_mega_dulces.js`
- `database/test-newdb-tenant-context.js`
- `apps/api/src/shared/database/new-database.module.ts` (sin wirear todavía al AppModule)
- `apps/api/src/shared/database/tenant-knex.service.ts`

**Estado de prod:** Sin cambios. Toda la app sigue operando contra la DB legacy. Los archivos nuevos no se ejecutan en runtime de prod.

**Siguiente paso:**
- **Sub-sprint A.0mt.2** — diseñar y crear el schema multi-tenant completo (10+ tablas) + índices por `tenant_id` + políticas RLS de aislamiento + seeds iniciales (rol superadmin + usuario superoot del tenant mega_dulces).

---

## 2026-05-26 — Sub-sprint A.0mt.2 cerrado: schema multi-tenant completo

**Tipo:** Sprint checkpoint
**Items revisados:** A.0mt.2.1 → A.0mt.2.10 + bonus app_runtime role
**Estado al cierre:** ✅ TODOS COMPLETADOS

**Qué se logró:**
- **19 tablas multi-tenant creadas** en `postgres_platform`:
  - Global: `tenants` (sin tenant_id, raíz)
  - Identidad: `users`, `zones`, `role_permissions`, `catalogs`
  - Producto: `brands`, `products`
  - Operación: `stores`, `daily_assignments`, `visits`, `exhibitions`, `exhibition_photos`
  - Capturas: `daily_captures`
  - Scoring: `scoring_config`, `scoring_config_versions`, `scoring_weights`, `rubric_criteria`, `rubric_levels`, `valid_exhibition_combinations`
- **95 índices** creados (1 por FK + tenant_id + queries frecuentes)
- **95 foreign keys** — la mayoría composite (tenant_id, X) → tabla(tenant_id, id) para aislamiento DB-level
- **18 políticas RLS** `tenant_isolation` con USING + WITH CHECK (todas las tablas multi-tenant)
- **FORCE RLS** activo (no bypass ni para owner) — pero superuser igual lo bypassea, por eso:
- **Rol `app_runtime` NOSUPERUSER NOBYPASSRLS** creado con grants CRUD apropiados + DEFAULT PRIVILEGES para tablas futuras
- **5 roles canónicos seedeados**: superadmin, admin, supervisor, jefe_marketing, colaborador (con permisos del enum Permission)
- **Usuario superoot** creado para Mega Dulces con password bcrypt-hashed 'superoot'
- **Test E2E `test-newdb-rls-isolation.js`: 16/16 pass** — valida aislamiento completo entre 2 tenants

**Cambios intencionales vs legacy** (aprovechando reset):
- Quitado `captured_by_username` en visits y daily_captures (deuda audit 1.7)
- Quitado `zona_captura` en daily_captures (deuda 1.12)
- Renombrado `pertenece_mega_dulces` → `is_own_brand` (multi-tenant friendly)
- Renombrado `scoring_pesos` → `scoring_weights`, `rubrica_*` → `rubric_*`, `combinaciones_validas` → `valid_exhibition_combinations`
- `creado_por` string legacy → `created_by` FK estándar
- Excluida tabla `captures` (deprecated, solo daily_captures se usa)
- 2 connection strings: `DATABASE_URL_NEW` (postgres, para migraciones) + `DATABASE_URL_NEW_RUNTIME` (app_runtime, para runtime API)

**Lecciones aprendidas:**
- Postgres superuser BYPASSEA RLS incluso con FORCE — obligatorio usar un rol app dedicado.
- `SET LOCAL app.tenant_id` es la forma correcta de propagar tenant context dentro de tx (vs `SET` que persiste en pool).
- Composite FK `(tenant_id, fk_id) → (tenant_id, id)` es la forma de garantizar a nivel DB que no se puede asignar entidad de otro tenant. RLS solo filtra reads/writes, no impide referenciar (sin esto).
- Seeds que escriben en tablas con RLS deben setear `SET LOCAL app.tenant_id` aunque corran como postgres (WITH CHECK lo requiere si force_rls bypass no aplica al admin del role).

**Archivos creados:**
- `database/migrations-newdb/`: 6 archivos de migración (0002-0007)
- `database/seeds-newdb/`: 02_initial_roles, 03_superoot_user
- `database/test-newdb-rls-isolation.js`: test suite RLS
- `apps/api/src/shared/database/`: `new-database.module.ts` actualizado para usar `DATABASE_URL_NEW_RUNTIME`

**Estado de prod:** Sin cambios. App sigue contra legacy. Toda la actividad en la nueva DB local.

**Siguiente paso:**
- **Sub-sprint A.0mt.3** — Integración NestJS: crear `TenantContextInterceptor` global que extrae `tenant_id` del JWT y lo propaga via `AsyncLocalStorage` para que `TenantKnexService.run()` lo use automáticamente sin pasarlo por argumentos. Más: endpoint admin `POST /admin/tenants`, login multi-tenant, tests de integración con 2 tenants.

---

## 2026-05-26 — Sub-sprint A.0mt.3 cerrado: integración NestJS multi-tenant

**Items:** A.0mt.3.1 → A.0mt.3.7 (todos completados)

**Qué se logró:**
- `TenantContextService` con AsyncLocalStorage nativo (Node 18+) — propaga {tenantId, userId, username, roleName} a través de toda la cadena async sin pasarlo por args.
- `TenantContextInterceptor` global (no wireado al AppModule todavía — cutover) que abre el ALS scope al inicio de cada request autenticado.
- `TenantKnexService.run()` actualizado con overload: lee tenant del ALS automáticamente o lo recibe explícito.
- Módulo `auth-mt`: login multi-tenant requiere `tenant_slug`, JWT incluye `tenant_id`.
- Módulo `tenants-admin`: CRUD básico de tenants vía `/admin/tenants` (sin guard todavía).
- Test `test-newdb-auth-multitenant.js`: **12/12 pass** incluyendo concurrencia real con clients pg separados.

**Decisiones de diseño:**
- Usar `AsyncLocalStorage` nativo en vez de `cls-hooked` (es estándar Node 18+, sin dependencia extra).
- `SET LOCAL app.tenant_id` con interpolación de string (no parameter binding) porque Postgres no soporta params en SET. Validación regex UUID en el helper para prevenir SQL injection.
- `app_runtime` user para conexiones runtime (NOSUPERUSER NOBYPASSRLS); `postgres` solo para migraciones.
- `auth-mt` y `tenants-admin` conviven con módulos legacy hasta el cutover Sprint A.0mt.5.

**Archivos creados:**
- `apps/api/src/shared/tenant/tenant-context.service.ts`
- `apps/api/src/shared/tenant/tenant-context.interceptor.ts`
- `apps/api/src/shared/tenant/tenant.module.ts`
- `apps/api/src/modules/auth-mt/{auth-mt.service.ts, auth-mt.controller.ts, auth-mt.module.ts}`
- `apps/api/src/modules/tenants-admin/{tenants-admin.service.ts, tenants-admin.controller.ts, tenants-admin.module.ts}`
- `database/test-newdb-auth-multitenant.js`

**Siguiente:** Sub-sprint A.0mt.4 — script de migración de data legacy → nueva DB con tenant_id poblado.

---

## 2026-05-26 — Sub-sprint A.0mt.4 cerrado: migración data legacy → nueva DB

**Source:** `trade_marketing_respaldo` local (backup del Railway legacy).
**Destino:** `postgres_platform` (nueva DB local).
**Items:** A.0mt.4.1 → A.0mt.4.9 (todos completados).

**Resultado: 1804/1830 rows migrados (98.6%)**

| Tabla | Legacy | NewDB | Notas |
|---|---|---|---|
| zones | 5 | 5 | ✓ |
| catalogs | 23 | 23 | ✓ |
| role_permissions | 5 | 6 | seed (5) + legacy `supervisor_ventas` único |
| users | 26 | 26 | ✓ |
| brands | 61 | 61 | ✓ |
| products | 1225 | 1225 | ✓ |
| stores | 35 | 35 | ✓ |
| daily_assignments | 33 | 9 | 24 skip por route_id huérfano en legacy |
| scoring_config_versions | 1 | 1 | ✓ |
| scoring_weights (era scoring_pesos) | 15 | 15 | ✓ con rename |
| daily_captures | 401 | 398 | 3 skip por user_id huérfano |

Visits/exhibitions/exhibition_photos NO migrados (vacíos en legacy — data vive en daily_captures.exhibiciones JSONB).

**Issues resueltos durante migración:**
1. **JSONB serialization**: `r.exhibiciones || []` falla en algunos shapes. Fix: `JSON.stringify()` explícito.
2. **Self-FK catalogs.parent_id**: jerarquía requiere pasadas iterativas + sanitización de huérfanos a null.
3. **Roles legacy `Jefe_M`**: normalizado a `jefe_marketing` con map.
4. **Data sucia legacy**: 24+3 rows con FKs huérfanos. Skip silencioso pre-insert.

**Decisiones:**
- UUIDs originales preservados (no regenerar) → mantiene FKs internas.
- onConflict ignore → idempotente y safe para re-runs.
- TENANT_ID hardcoded a Mega Dulces.
- Conexión legacy usa user `postgres` (bypass RLS no aplica al ser lectura del legacy schema sin RLS).
- Conexión nueva DB usa `postgres` también para insert (bypass RLS necesario para seed cross-tenant inicial).

**Archivo:** `database/migrate-legacy-to-newdb.js` (~400 LOC, modular por tabla).

**Siguiente:** Sub-sprint A.0mt.5 — cutover plan (validar API contra nueva DB en staging + switch de DATABASE_URL en prod).

---

## 2026-05-26 — Sub-sprint A.0mt.5 parte LOCAL cerrada

**Items locales completos:** A.0mt.5.1, A.0mt.5.2.
**Items operacionales Railway en pausa:** A.0mt.5.3-7 (requieren acción del usuario al cutover real).

**Logros locales:**
- **Runbook completo** `docs/IMPLEMENTACION/RUNBOOKS/CUTOVER_NEW_DB.md` con 5 fases + plan rollback + checklist pre-flight.
- **AppModule extendido** con import condicional `ENABLE_MULTITENANT=true` → wirea `[NewDatabaseModule, TenantModule, AuthMtModule, TenantsAdminModule]`. Convive con legacy sin romper.
- **Smoke test API end-to-end via curl** (puerto 3334):
  - `POST /api/auth-mt/login {tenant_slug,username,password}` → JWT con tenant_id correcto.
  - `GET /api/admin/tenants` → array con Mega Dulces + metadata.
- API arrancó con todos los módulos legacy + multi-tenant cohabitando, sin errores.

**Estado de prod:** Sin cambios. App sigue contra legacy en Railway.

**Pendientes Railway** (cuando el usuario decida ejecutar cutover):
1. Crear servicio Postgres en Railway.
2. Setear env vars (`DATABASE_URL_NEW`, `DATABASE_URL_NEW_RUNTIME`, `APP_RUNTIME_PASSWORD`, `ENABLE_MULTITENANT=true`).
3. Correr migraciones + script de migración data contra Railway.
4. Smoke test Railway → switch `DATABASE_URL` → monitoreo 24h.

**Siguiente sub-sprint:** A.0mt.6 — checkpoint final del Sprint A.0-multitenant + decidir A.0bis vs Fase B.

---

## 2026-05-26 — Sprint A.0bis residual cerrado (cleanup + hardening)

**Items completados:** 4-9, 14-17, 19 (11 items).
**Items BLOCKED por usuario:** 1-3 (CORS, JWT secret, credenciales).
**Items DEFERRED:** 18 (user non-root nginx), 20-23 (refactor god services 2-3 sem).

**Cleanup:** 70 archivos `.js`/`.js.map`/`.d.ts` borrados de `apps/api/src` + `.gitignore` actualizado. `.env.cloudinary` eliminado (consolidado en `.env`). 3 `*.log` raíz borrados.

**Backend seguridad:**
- `console.*` → `Logger` NestJS en `visitas-sync.service.ts` y `visitas-sync.controller.ts` (8 ocurrencias).
- `catch (e) {}` silencioso en `tasks.service.ts:71` → `logger.warn` + `continue`.
- `npm audit fix` sin --force aplicado. 68 vulns restantes requieren upgrade Angular 19 (deferred).

**Hardening backend:**
- **Helmet** en `main.ts` (CSP off por Swagger, COEP off).
- **`@nestjs/throttler`** global: 3 tiers (10/seg, 60/10seg, 200/min) + APP_GUARD.
- **Body parser** 50mb → 2mb global. Uploads multipart pasan por interceptor, no por este middleware.

**Hardening infra:**
- **`nginx.conf`** con security headers: X-Frame-Options DENY, X-Content-Type-Options nosniff, X-XSS-Protection, Referrer-Policy strict-origin, Permissions-Policy, HSTS 1año, `server_tokens off`.

**Schemas JSONB:** `apps/api/src/shared/schemas/jsonb-schemas.ts` con Zod (permissions, exhibiciones, stats, scoring_config, tenant metadata) + helper `validateJsonb()`. Listos para integrar en serializers.

**Build:** OK. Sentry NO integrado (era Fase A.1 del plan original — pendiente).

**Siguiente fase:** **B — Integración Kepler ERP** (Postgres-to-Postgres con `postgres_fdw`, co-located en `192.168.0.245`).

---

<!-- Las siguientes entradas se agregan al revisar / cerrar items reales. -->

## 2026-06-02 — Sesión QA + caza de bugs internos (Trade Marketing + Comercial)

Sesión reactiva: arrancó por un error 25P02 en prod y derivó en una caza
sistemática de bugs internos + QA de navegador de los proyectos Trade Marketing
y Comercial. Todo commiteado en `f7b21b2` / `9f6763a` / `34f404e`.

**Clase "transacción envenenada" (25P02 / rollback silencioso).** Causa raíz:
`TenantContextInterceptor` envuelve TODA request autenticada en una sola
transacción; cualquier `catch` que traga un error DB y sigue queryeando tira
`25P02` (o rollback silencioso en el COMMIT). Fixes:
- `daily-captures.service`: INSERT idempotente envuelto en SAVEPOINT (el catch de
  `23505` releía la fila en la trx ya abortada → era el 25P02 de prod).
- `daily-captures` / `catalogs` / `planograms`: helpers best-effort
  (`registrarLog`, `safeRecalcularScoreMaximo`, `embedProduct`) desacoplados —
  conexión separada (audit log) o savepoint (read-after-write).

**Materialized views.** `AnalyticsRefreshService`: `REFRESH ... CONCURRENTLY`
fallaba en MVs sin poblar → ahora chequea `pg_class.relispopulated` y hace un
REFRESH normal la primera vez.

**Código muerto / roto eliminado (verificado sin uso en front+back):**
- `VisitasSyncModule`: referenciaba tabla `tiendas` (nunca existió), `sync_logs`
  (nunca existió) y 9 columnas inexistentes en `daily_captures`. El frontend
  sincroniza vía `/daily-captures`. Borrado.
- `ExhibitionsModule`: 2 POST huérfanos sin RolesGuard/permisos (vector Cloudinary).
  Frontend no los llama. Borrado. (Colateral: `import 'multer'` movido a
  `cloudinary.service` para conservar la augmentation global `Express.Multer`.)

**Multi-tenant isolation (defense-in-depth).** `reports.service.buildBaseQuery`
y los counts de `stores` no filtraban `tenant_id` (la conexión legacy es
`postgres` y bypassa RLS) → leak latente con 2+ tenants. Agregado filtro explícito.

**QA navegador (login superoot):**
- Trade Marketing: 11/11 páginas sanas, 0 errores JS. Solo warning perf del logo.
- Comercial: 9/9 páginas sanas. Bugs encontrados y arreglados:
  - **COM-001**: promos mostraban `-0.15%` en vez de `-15%` (display no hacía
    ×100 sobre la fracción del engine). Fix en `promotions-meta`.
  - **COM-002**: inventory devolvía pagination flat → contador "líneas de stock"
    en 0. Fix: forma anidada consistente con el resto de endpoints.
  - **COM-004** (HIGH): el form de promos guardaba percent 1-100 pero el engine
    lo clampa a [0..1] → una promo creada por UI aplicaba 100% off. Fix:
    conversión fracción↔1-100 en el borde (load/save + tiers).

Reportes QA en `.gstack/qa-reports/`. Deferred: COM-003 (historical FDW "0
clientes únicos", módulo nuevo en curso), endurecer `isPercent` backend a ≤1.
