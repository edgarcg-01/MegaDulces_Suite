# Fase ABC — Clasificación ABC + conteo cíclico programado

> **Estado: 🔨 ABC.0 EN CÓDIGO — 2026-06-19** (diseño aprobado). Clasificación ABC operativa; falta 1 reinicio para verde live del smoke I.6. Siguiente item estratégico de inventario tras caducidad/FEFO (ver [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) §Roadmap P2).

## Objetivo

Pasar del **inventario anual que congela todo** a **control continuo**: clasificar cada SKU por su valor de consumo (A/B/C) y agendar conteos cíclicos por clase (A seguido, C esporádico), generando folios `type='cycle'` **automáticamente y acotados**. Apalanca la rotación que ya calcula Thot + el infra de conteo físico (Fase I).

Beneficio: detectar y corregir errores de saldo **antes** del cierre anual; foco del esfuerzo de conteo donde está el dinero (clase A); IRA sube de forma sostenida.

## Qué ya existe (anclas)

- **Conteo físico (Fase I)** completo: `inventory_counts` (folio, `type` 'full'|'cycle', estados, freeze, blind double, reconcile, IRA). **Gap:** `openCount` **siempre siembra TODO** el almacén — `type='cycle'` hoy no acota los items.
- **Rotación product-level:** `catalog.products.rotation_tier` / `sales_units_30d` (del ERP, sumado entre almacenes, **puede estar vacío en prod**). Señal débil: no es per-almacén.
- **Historial reconciliado:** folios `reconciled` + `inventory_count_items` → da "última vez contado" por item.
- **Consumo real tenant-local:** `commercial.orders` (fulfilled) + `order_lines` + `catalog.cost_base` → unidades y valor por (almacén, producto) sin depender del sync ERP.

## Decisiones de diseño

1. **Métrica ABC = valor de consumo anualizado, per (almacén, producto).** unidades vendidas (líneas de pedidos `fulfilled`, ventana trailing 90d → anualizada) × costo unitario (`cost_base`, fallback costo ERP). **Tenant-local, per-almacén, no depende del sync.** `rotation_tier` queda como señal secundaria/UX, no como base. Pareto: ordenar por valor desc y acumular → **A = hasta 80%** del valor, **B = 80–95%**, **C = 95–100%**; sin ventas → C.
2. **Clasificación materializada** en `commercial.abc_classification` (`tenant, warehouse, product, class, annual_value, value_share, computed_at`), refrescada por cron (semanal) + endpoint manual. Materializar (no on-the-fly) = estabilidad para el scheduling + lectura barata. (Patrón del proyecto: tenant_id, RLS forzado, FK compuesta, grant app_runtime, idempotente.)
3. **Cadencia por clase configurable** — defaults **A=30d, B=90d, C=365d**. MVP: constantes con override por query; tabla de policy por tenant = refinamiento.
4. **Due tracking:** `last_counted_at(almacén,producto)` = `max(reconciled_at)` de folios reconciliados que incluyeron el item; `next_due = last_counted_at + cadencia(clase)`; nunca contado = due ya.
5. **Seed acotado:** extender `openCount` con `product_ids?: string[]` (o `abc_class?`) → siembra solo ese subset; sin subset = full actual (compat). Esto es lo que hace **real** el `type='cycle'`.
6. **Auto-folio (cron):** diario por almacén, junta items due (prioriza A), cap N por folio, crea folio `type='cycle'` acotado. MVP: endpoint manual "generar folio cíclico de lo due" antes del cron.

## Fases (rebanadas verticales)

| Fase | Tema | Entrega |
|---|---|---|
| **ABC.0** ✅ código | Clasificación | ✅ 2026-06-19: tabla `commercial.abc_classification` (mig `20260619100000`, RLS forzado, FKs compuestas) + `InventoryAbcService` (Pareto por almacén con **share acumulado exclusivo** — el top siempre A; DELETE+INSERT atómico) + `GET /commercial/inventory/abc` y `POST .../abc/refresh` (gate SUPERVISAR) + smoke I.6 + verificación DB-direct (`verify-abc-compute.js`: 32 849 clasificados, SQL válido). Build verde. ⏳ 1 reinicio para verde live de I.6. Nota: data local casi sin ventas → A=5/resto C (esperado; en prod se distribuye). |
| **ABC.1** | Due / agenda | Cadencia por clase + cómputo de due (last-counted desde historial reconciliado) + `GET .../cycle-due?warehouse_id=` ("qué toca contar"). |
| **ABC.2** | Folio cíclico acotado | `openCount` acepta subset de productos → folio chico. + `POST .../counts/open-cycle` (genera folio cíclico de lo due, capeado). Smoke E2E (abrir cíclico → contar → reconciliar → IRA). |
| **ABC.3** | Cron + UI | `@Cron` diario (cap, prioriza A, anti-duplicado por folio abierto) + página/sección de agenda + clasificación. |
| **ABC.4** ⬜ defer | Refinamientos | UI calendario, policy de cadencia por tenant, asignación por zona, aprobación por umbral $, 2º conteo aleatorio. |

**Orden de valor:** ABC.0 (clasificar) → ABC.2 (folio acotado — el corazón) → ABC.1 (due) → ABC.3 (automatizar). Nota: ABC.2 depende de ABC.0 (clase) y se beneficia de ABC.1 (due), pero el seed-acotado se puede entregar y probar con una lista explícita antes del cálculo de due.

## Riesgos / decisiones abiertas

- **Sin historial de ventas (testdata irreal):** todo cae a C. El cómputo tolera 0-ventas (→C) y la clasificación sigue siendo válida; en prod con ventas reales se llena. El smoke debe sembrar ventas o asertar el shape, no proporciones (lección [[feedback_smoke_brittle_vs_real_data]]).
- **Dos mundos de stock:** ABC arranca sobre `commercial.stock` (lo operacional, como FEFO). El mundo `inventory.warehouse_stock` (Kepler SKU) queda para después.
- **Per-almacén:** un SKU puede ser A en un almacén y C en otro — la clasificación es por (almacén, producto), no global.
- **Freeze del cíclico:** un folio cíclico **acotado** no debería congelar TODO el almacén (hoy `freeze_movements` es por-almacén). Decisión ABC.2: el cíclico arranca con `freeze=false` (conteo en caliente, tolerancia/count-back filtra ruido) **o** freeze por-item — evaluar. El full sigue con freeze.

## Relacionado
- [FASE_I_INVENTARIO.md](FASE_I_INVENTARIO.md) — conteo físico (base). §Roadmap P2 lista este item.
- Thot rotación: `libs/commercial/src/lib/commercial-intelligence/thot.service.ts`, `catalog.products.rotation_tier`.
- [FASE_FEFO_CADUCIDAD.md](FASE_FEFO_CADUCIDAD.md) — patrón de rebanadas verticales + sub-ledger (referencia de estilo).
