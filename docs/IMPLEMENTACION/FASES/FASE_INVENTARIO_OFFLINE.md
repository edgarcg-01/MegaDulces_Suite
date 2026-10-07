# Fase OFF — Conteo de inventario offline-first

> **Estado: 🔨 OFF.0 EN CURSO — 2026-06-19.** Extiende la Fase I (conteo físico). El conteo es un **handheld en almacén** (señal intermitente = estado normal). Hoy el conteo es **100% online**: si se cae la red, el escaneo se pierde, el contador queda atrapado, y el backend **no es replay-safe**. Esta fase lo vuelve offline-first.

## Objetivo
Que el contador **nunca pierda un conteo** por falta de red: el escaneo se persiste local primero, se sincroniza al reconectar, y el backend acepta el replay sin duplicar ni corromper el doble-conteo ciego.

## Benchmark — cómo lo hacen los mejores
| Sistema / patrón | Principio | Qué tomamos |
|---|---|---|
| WMS handheld (Manhattan, SAP EWM, Blue Yonder, Oracle, Körber) | El handheld es la fuente de verdad durante el conteo: store-and-forward, auto-sync al reconectar | Escaneo local-first; red secundaria |
| POS offline-first (Shopify/Square) | Captura local + cola; **idempotency key persistida ANTES de enviar**, reusada en el retry | `scan_uuid` por escaneo |
| Offline-first mobile (Android guide, outbox) | Local-first + optimistic UI + outbox; **LWW es malo para inventario/auditado** | Merge determinista por slot, no LWW |
| ABC cycle counting (Pareto) | Contar A más seguido | Ya existe (Fase ABC) |

## Métricas objetivo (SLAs)
- **Pérdida de conteos = 0** (SLA #1).
- Throughput offline **== online** (el escaneo no espera red).
- Sync success ≥ 99.9%; time-to-sync tras reconexión < 10 s.
- Duplicados tras replay = **0** (idempotencia).
- Conflict rate < 1%, 100% auditables.
- IRA ≥ 97% (best-in-class 99%) — `(1 − Σ|var| / Σ total) × 100` (endpoint IRA ya existe, Fase I.5).

## Principios no negociables
1. Offline-first: el escaneo va a Dexie primero, después a la red.
2. Outbox + idempotencia (`scan_uuid` persistido antes de enviar).
3. Merge **determinista por slot** (respeta doble-conteo ciego), nunca LWW ciego.
4. Optimistic UI + estado de sync visible.
5. Estado de red siempre visible (banner "sin conexión / N pendientes").
6. **Backend replay-safe ANTES de la cola** (sin esto, sincronizar corrompe data).

## Arquitectura (a la medida del repo)
- Reusa: `TradeMarketingOfflineDB` (Dexie), `offline-sync.service` (reconnect + Web Locks + retry transitorio), patrón `pendingSale` del vendor.
- Backend: idempotencia + folio `FOR UPDATE` + slot por `capture_pass` + rechazo limpio post-reconcile.
- Catálogo offline: cachear el catálogo del folio al iniciar la jornada → resolve sin red.

## Modelo de datos
**Backend:**
- `commercial.inventory_count_scan_log (tenant_id, count_id, scan_uuid PK, item_id, slot, applied_by, applied_at)` — idempotency store (append-only, RLS forzado). **✅ migración 20260619180000.**
- `submitCount` acepta `scan_uuid` + `capture_pass`.

**Cliente (Dexie, nueva versión):**
- store `inventoryScans`: `{scan_uuid, count_id, product_id|barcode, qty, capture_pass, client_ts, sincronizado, intentos_fallidos}`.
- store `inventoryFolioCatalog`: catálogo del folio para resolve offline.

## Backend replay-safe (4 fixes, OFF.0)
1. `FOR UPDATE` en el folio (excluye con reconcile; a ritmo humano la serialización es imperceptible).
2. **Idempotencia** por `scan_uuid` (si ya está en scan_log → no-op).
3. Slot por **`capture_pass`** (la fase en que se capturó), no la fase actual → un count_1 encolado no se desvía a count_2.
4. Rechazo **tipado** si el folio está `reconciled/cancelled` → el cliente lo muestra como "N conteos no aplicados (folio cerrado)" y los aparta auditados.

## Fases
| Fase | Entrega | Aceptación | Estado |
|---|---|---|---|
| **OFF.0** | Backend replay-safe (scan_log + scan_uuid + lock + capture_pass + rechazo limpio) | Replay (dup/out-of-order/post-reconcile) → estado idéntico, 0 duplicados | 🔨 migración ✅ · `submitCount` **bloqueado** (contención con Fase PA/PA.4 en el mismo archivo) |
| **OFF.1** | Catálogo offline (cache del folio + resolve local-first) | resolve funciona en avión | ⬜ |
| **OFF.2** | Outbox de escaneos (Dexie + feed optimista + submit local-first) | escaneo se ve al instante sin red | ⬜ |
| **OFF.3** | Sync engine (flush on reconnect + retry + Web Locks + banner) | 50 offline → reconecta → 50 aplicados < 10s | ⬜ |
| **OFF.4** | Bordes (finishSession offline, folio cerrado durante offline, log de conflicto) | el contador nunca queda atrapado | ⬜ |
| **OFF.5** | Telemetría de SLAs + E2E airplane-mode | IRA correcto tras sync | ⬜ |

## Conflictos — decisión (ADR pendiente de formalizar en 02_DECISIONES)
Caso difícil: dos contadores cuentan el **mismo SKU, mismo slot (count_1)** offline.
- **Política elegida: (a) último-aplicado-gana + log de conflicto auditable.** Reversible. (El caso normal —count_1 por A, count_2 por B— no es conflicto; mismo usuario que reintenta → idempotente por `scan_uuid`.)

## Riesgos
- Doble-conteo ciego + offline = el conflicto más delicado (se mitiga con `capture_pass`).
- Catálogo de miles de SKUs en Dexie → cachear **solo el folio**, no todo.
- **Contención de archivo**: el backend de OFF.0 vive en `inventory-count.service.ts`, que la sesión de **Fase PA (PA.4 count-scoping)** está editando en paralelo. OFF.0 `submitCount` queda en pausa hasta secuenciar la propiedad del archivo (que PA.4 commitee, y OFF.0 rebase encima).

## Relacionado
- [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) (conteo físico base).
- [FASE_PASILLOS_EQUIPOS.md](FASE_PASILLOS_EQUIPOS.md) (Fase PA — comparte `inventory-count.service.ts`).

## Fuentes (benchmark)
- Android Developers — offline-first · EducBA — Offline-First (Outbox/Idempotency/Conflict) · Shopify — Implementing idempotency · Shopify POS offline · Extensiv — RF scanners · NetSuite — cycle counting · Interlake Mecalux — IRA.
