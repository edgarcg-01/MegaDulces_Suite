# Fase I — Inventario físico (conteo cíclico/total por almacén)

> Digitaliza el proceso manual de "hacer inventario" (marbeteo + doble conteo + recaptura del checador) en una sesión con **conteo ciego**, **doble conteo** por contadores distintos y **reconciliación auditable**. Colapsa los 5 pasos manuales (contar→papel→checador→capturar→imprimir→recontar) a 2 digitales: *contar escaneando* + *reconciliar*.

## Estado

| Sub-sprint | Tema | Estado |
|---|---|---|
| **I.0** | Schema + permisos + RLS | ✅ 2026-06-13 |
| **I.1** | Backend (servicio + controller + guard freeze + smoke) | ✅ 2026-06-13 |
| I.2 | Frontend contador (handheld, conteo ciego, barcode) | ⬜ |
| I.3 | Frontend supervisor (tablero + reconciliación) | ⬜ |
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

## Próximo

I.2/I.3 frontend: página de conteo mobile-first (reusa scanner barcode + match AI del wizard de captures) + tablero/reconciliación del supervisor (tabla densa, Operations design). Confirmar alcance con Edgar.
