# Fase I — Inventario físico (conteo cíclico/total por almacén)

> Digitaliza el proceso manual de "hacer inventario" (marbeteo + doble conteo + recaptura del checador) en una sesión con **conteo ciego**, **doble conteo** por contadores distintos y **reconciliación auditable**. Colapsa los 5 pasos manuales (contar→papel→checador→capturar→imprimir→recontar) a 2 digitales: *contar escaneando* + *reconciliar*.

## Estado

| Sub-sprint | Tema | Estado |
|---|---|---|
| **I.0** | Schema + permisos + RLS | ✅ 2026-06-13 |
| **I.1** | Backend (servicio + controller + guard freeze + smoke) | ✅ 2026-06-13 |
| **I.2** | Frontend contador (handheld, conteo ciego, barcode) | ✅ 2026-06-15 |
| **I.3** | Frontend supervisor (tablero + reconciliación) | ✅ 2026-06-15 |
| I.4 | Deferred: cycle counts programados (ABC), offline, asignación de zonas, reconciliación parcial | ⬜ |

## Diagnóstico de datos (2026-06-13, prod real)

- **12 almacenes**; con stock real: MD-10/30/50/CEDIS (**6,352 SKUs** c/u, sync ERP) + MD-CENTRAL (5, seed).
- **Barcode: 97%** (11,109/11,444) → conteo por escaneo viable; ~335 sin código → fallback manual/AI.
- **Location: 97%** → pista de ubicación para el contador.
- **UoM: NO existe columna** + **9,001 filas con saldo fraccionado** → el conteo acepta decimales; unidad ambigua (riesgo abierto #4).
- `commercial.stock` es único por `(almacén, producto)` → granularidad de conteo = **por SKU por almacén**; `location` es pista, no eje.

## Jerarquía (segregación de funciones)

| Rol | Permiso | Puede |
|---|---|---|
| Contador | `COMMERCIAL_INVENTORY_CONTAR` | Enviar conteos **a ciegas** (nunca ve teórico ni varianza) |
| Supervisor | `COMMERCIAL_INVENTORY_SUPERVISAR` | Abrir folio, ver avance/items, calcular discrepancias, resolver |
| Reconciliador (jefe) | `COMMERCIAL_INVENTORY_RECONCILIAR` | Autorizar ajuste de saldo (mueve dinero) + cerrar folio |

Seed: superadmin/admin = los 3; supervisor = CONTAR+SUPERVISAR; colaborador = CONTAR. RECONCILIAR solo admin/superadmin.

## Schema (`commercial.*`, migración `20260613100000`)

- **`inventory_counts`** — folio/sesión por almacén. `folio` (INV-YYYY-NNNNN), `type` (full|cycle), `status` (open→counting→review→ready_to_reconcile→reconciled|cancelled), `freeze_movements`, `blind_double_count`. Índice parcial único: **un folio abierto por almacén**.
- **`inventory_count_items`** — fila por SKU. `expected_qty` (snapshot del teórico, **oculto al contador**), `count_1/2/3` + `counted_by_*`, `final_qty`, `variance`, `status` (pending|counted|discrepancy|resolved), `location`, `notes`.
- **`inventory_count_sequences`** — counter atómico (tenant, year) para el folio.
- RLS forzado + grants `app_runtime` en las 3. FK tenant→`identity.tenants`, producto→`catalog.products` (public.* son vistas tras la reorg de schemas).

## Backend (`libs/commercial/.../commercial-inventory/`)

`InventoryCountService` + `InventoryCountController` (`/commercial/inventory/counts`):

| Endpoint | Permiso | Qué hace |
|---|---|---|
| `GET /` | VER | Lista folios |
| `POST /open` | SUPERVISAR | Crea folio + **snapshot** del teórico (expected_qty desde `commercial.stock`) |
| `POST /:id/count` | CONTAR | Conteo **ciego** (barcode o product_id). Segregación: count_2 ≠ contador de count_1. Sobrantes (no en snapshot) se crean con expected 0 |
| `GET /:id/progress` | SUPERVISAR | Tablero: cobertura %, discrepancias, **valor $ en riesgo**, productividad por contador |
| `GET /:id/items` | SUPERVISAR | Items con teórico + varianza (no lo usa el contador) |
| `POST /:id/compute` | SUPERVISAR | Calcula discrepancias (count_1==count_2→final; mismatch→discrepancy; count_3 rompe empate) → review |
| `POST /:id/items/:itemId/resolve` | SUPERVISAR | Resolución manual del valor final |
| `POST /:id/reconcile` | RECONCILIAR | Ajusta `commercial.stock` al físico + movimientos `adjust` (reference_type=`inventory_count`) en una trx. Cierra folio |
| `POST /:id/cancel` | RECONCILIAR | Cancela folio |

### Controles embebidos (las 3 debilidades críticas resueltas)

1. **Coverage guard** — `reconcile` rechaza si hay SKU con `count_1 IS NULL` (un "no contado" jamás se trata como cero → no se destruye stock real). También bloquea discrepancias sin resolver e items sin `final_qty`.
2. **Freeze guard cross-module** — `assertWarehouseNotFrozen` en `orders.reserveStockInline`/`consumeStockInline` y en `adjustStock`/`recordMovement` manual: si el almacén tiene folio abierto con `freeze_movements`, se rechaza mover stock (el teórico no deriva durante el conteo).
3. **Comparar contra `quantity` (on-hand)** — la varianza es `físico − expected_qty` (snapshot de `quantity`, no de `available`). Reconcile respeta el CHECK `quantity >= reserved` (si físico < reservado → item a discrepancy, no ajusta, exige liberar reservas).
4. **Segregación de funciones** — count_2 lo hace un contador distinto a count_1; el reconciliador no puede ser quien contó ningún item del folio.

## Smoke

`database/tests/test-newdb-inventory-count.js` (DB-direct, `app_runtime`, RLS) — **13/13 ✓**: folio+snapshot, conteo ciego doble, segregación, discrepancia+count_3, coverage guard, freeze guard, reconciliación (stock ajustado + movimientos), descongelamiento al cerrar. En `run-all-tests.js`.

## Riesgos abiertos (endurecimiento post-MVP)

- **#4 UoM ambigua** — sin columna de unidad; el conteo asume la unidad del ERP. Si llega multi-unidad (caja/pieza/granel) se necesita UoM + conversión.
- **#5 sin barcode (3%)** — fallback manual/AI a diseñar en frontend.
- **#6 multi-ubicación** — granularidad por SKU/almacén; `location` solo pista. Conteo por posición física es refinamiento futuro.
- **#8 colusión** — el 2º conteo debería asignarlo el sistema (aleatorio), no el supervisor.
- **#10 reconciliación parcial por zona** — hoy es todo-o-nada por folio.
- **#11 offline** — handheld en zonas muertas de WiFi (infra Dexie ya existe en captures).

## I.2 — Frontend contador (✅ 2026-06-15)

Página `/comercial/inventory/count` (`ComercialInventoryCountComponent`, mobile-first para handheld HID keyboard-wedge). Nav "Conteo físico" (icono `pi-qrcode`, gateado por `COMMERCIAL_INVENTORY_CONTAR`). Flujo de un gesto: escanear código → salta a cantidad → Enter envía → confirmación en feed → foco vuelve al código. **Conteo ciego** (usa `GET /count-progress`, que no expone teórico ni varianza). Selector de folio (folios en counting/review), barra de progreso ciega (contados/total/restantes/míos), feed de últimos 15 con badge de slot (1er/2do/reconteo).

Backend para el contador: endpoint `GET /:id/count-progress` (gateado CONTAR, agregados ciegos), `submitCount` devuelve sku/nombre/location para confirmar el SKU escaneado (identificación, no dato ciego), y **corrección same-counter**: si el mismo contador re-escanea su `count_1` lo sobrescribe (no choca con segregación); solo un contador distinto dispara `count_2`.

## I.3 — Frontend supervisor (✅ 2026-06-15)

Dos páginas (superficie Operations, tabla densa):
- **`/comercial/inventory/sessions`** (`ComercialInventorySessionsComponent`, nav "Folios inventario", gate `SUPERVISAR`) — lista de folios + dialog **Abrir folio** (almacén, tipo full/cíclico, toggles congelar/doble-ciego).
- **`/comercial/inventory/sessions/:id`** (`ComercialInventorySessionDetailComponent`) — KPIs (cobertura %, contados, **sin contar**, discrepancias, **valor $ en riesgo**), acciones (calcular discrepancias, **reconciliar** con confirmación — solo `RECONCILIAR`, cancelar), filtro Todos/Discrepancias/Pendientes, tabla de items (teórico/C1/C2/C3/final/varianza coloreada/estado), dialog **resolver item** (cantidad física final + motivo).

Fase I = **🟢 frontend + backend completos (beta scope)**. Falta solo validación visual en browser con lector real.

## I.5 — Endurecimiento de correctness (P0 ✅ 2026-06-18)

Auditoría de correctness + comparación con prácticas de industria (cycle counting/ABC, IRA con tolerancia, FEFO/caducidad, shrinkage NRF ~1.6% de ventas). La base ya era grado-enterprise (blind double count + segregación + coverage + freeze + auditoría). Cerrados los 3 fixes de mayor riesgo + 1 verificación, todos en [`inventory-count.service.ts`](../../../libs/commercial/src/lib/commercial-inventory/inventory-count.service.ts):

- **A1 — Freeze integrity guard en `reconcile`.** El ajuste fija el saldo de forma **absoluta** contra un teórico fotografiado al abrir; si el almacén no quedó congelado y hubo movimientos desde entonces, el set absoluto **borraba esas ventas** (lost-update) y mal-atribuía la varianza como merma. `reconcile` ahora **bloquea** si hay `stock_movements` (ref ≠ `inventory_count`) en el almacén desde `started_at` (solo modo `commercial`; `inventory.warehouse_stock` no lo mueven los pedidos).
- **A2 — `computeDiscrepancies` salta items `resolved`.** Re-correr "calcular discrepancias" revertía resoluciones manuales (`resolved`→`discrepancy`) y pisaba overrides → bloqueaba el reconcile. Ahora no re-procesa lo ya resuelto.
- **A4 — Segregación en el 3er conteo (desempate).** `submitCount` rechaza `count_3` de quien ya hizo `count_1`/`count_2` de ese SKU (antes solo `count_2` tenía segregación). Escape: que cuente otra persona o el supervisor resuelve manual.
- **A5 — Verificado** que `inventory_count_items.product_id` es **nullable + FK dropeada** en LOCAL (migración `20260615170000`). ⚠️ **Pendiente confirmar en prod/.245** antes de confiar en modo `inventory` allí (el `INSERT` del snapshot inventory falla con 23502 si no está aplicada).

Build `api` verde. **Sin cobertura de smoke a nivel servicio** (el smoke I.1 es DB-direct y no ejercita el service) → pendiente test de servicio para A1/A2/A4.

## Roadmap de inventario (priorizado, post-P0)

Del gap-analysis vs industria. **Lo que falta** para pasar de "conteo digital" a "control de inventario continuo":

**P1 — quick wins de valor:**
- **A3 — Ledger + costo en modo `inventory` ✅ 2026-06-18.** Nueva tabla `inventory.warehouse_stock_movements` (espejo por-SKU de `commercial.stock_movements`, RLS forzado, mig `20260618170000`); la reconciliación en modo inventory ahora deja bitácora `adjust` (before/after, `reference_type=inventory_count`). `getProgress.value_at_variance` ya no sale 0: costo proxy = `venta_valor_costo_anual / venta_unidad_anual` de `inventory.products` (fallback a `catalog.cost_base`). **Pendiente:** test E2E del modo inventory (requiere sembrar `inventory.warehouse_stock`; el smoke I.5 cubre modo commercial).
- **Reason-codes estructurados ✅ 2026-06-18** (merma/caducado/dañado/robo/error_conteo/error_sistema/devolución/transferencia/encontrado/otro): `reason_code` en `inventory_count_items` + propagado al ledger (ambas tablas de movimientos), taxonomía validada en servicio (`VARIANCE_REASONS`, mig `20260618180000`), endpoint `variance-reasons` + dropdown `p-select` en el dialog de resolver. **Sigue:** **KPI de IRA** (Inventory Record Accuracy) por almacén/contador/tiempo + dashboard de shrinkage por causa — ya habilitado por el `reason_code` en el ledger.
- **Tolerancia de varianza** configurable (±%/±$/clase ABC) → count-back obligatorio solo de lo que excede.

**P2 — estratégico (mueven el negocio):**
- **Caducidad / lote / FEFO** — crítico para dulcería; hoy no hay lote ni fecha de expiración. Reduce merma 30–50% y es tema regulatorio en alimentos.
- **ABC + conteo cíclico programado** — apalanca la rotación que ya calcula Thot; agendar A mensual / C trimestral; generar folios automáticos. Pasa del "evento anual que congela todo" a control continuo.
- **Offline (Dexie)** para conteo en zonas sin WiFi (infra ya existe en captures/vendor).
- **Bin-level** + asignación por zona a contadores; 2º conteo **aleatorio** anti-colusión; reconciliación **parcial por zona**; **aprobación por umbral $** (ajustes chicos auto, grandes requieren gerente).

(Ver también "Riesgos abiertos" #4–#11 arriba — UoM/conversión, fallback sin barcode, multi-ubicación.)
