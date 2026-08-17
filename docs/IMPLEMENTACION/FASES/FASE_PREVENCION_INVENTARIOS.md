# Fase PREV — Prevención de Inventarios

> **Estado:** 🔨 EN CURSO — PREV.1 ✅ CONSTRUIDA (beta) LOCAL 2026-08-17; PREV.2/PREV.3 planeadas.
> **Origen:** Apéndice B de la visión del Jefe Frank — "auditoría, investigación y prevención de inventarios". Frente 2 del [Proyecto A — WMS / Inventario Trazable](PROYECTO_WMS_INVENTARIO_TRAZABLE.md).
> **Principio (ADR-016 + segregación):** detectar → documentar → investigar → autorizar → corregir → monitorear → cerrar. **Quien observa una diferencia no la ajusta**: solo Prevención autoriza. El sistema **detecta patrones, no acusa personas**.

Leyenda: ✅ **Completo** · 🟡 **Parcial** · ⬜ **No existe**

---

## 0. Lo que ya existe (base sobre la que montar)

- **Fase I** (conteo físico): conteo ciego, doble conteo, segregación, `reason_code` de varianza (merma/caducado/robo/error…), IRA, reconcile con ledger. ✅
- **Rol `prevencion_auditoria`** separado + permisos `RECONCILIATION_*`. ✅
- **Ledgers append-only**: `commercial.stock_movements`, `stock_lot_movements`, `inventory.warehouse_stock_movements`. ✅
- **Fase SM** (Supervisor de Movimientos): bandeja de descuadres caja/inventario/cruce (otro dominio — NO duplicar). ✅

Fase I resuelve *"cuánto falta"*. Prevención responde *"por qué falta"* y *"por qué se repite"*.

---

## Rebanadas

### PREV.1 — Expediente de investigación + Línea de tiempo del SKU ⭐ (primero)

> **✅ CONSTRUIDA (beta) LOCAL 2026-08-17.** Migración `20260817160000` (`commercial.inventory_investigations` folio `INV-DIF-YYYY-NNNNN` + secuencia; RLS forzado; CHECK causa raíz + status; **índice único parcial 1 expediente por item de conteo**). `InventoryInvestigationService` en `commercial-inventory`: `open` (manual), `from-count` (genera 1 expediente por item con varianza, idempotente), `list`, `detail` (+ timeline), `classify`, `resolve` (liga `adjustment_movement_id`, exige causa), `toMonitoring` (PNI → hook PREV.2), y **`skuTimeline`** = unión cronológica `commercial.stock_movements` (RLS) + `analytics.stock_movements` (ERP, best-effort). Permisos nuevos `COMMERCIAL_PREVENTION_VER`/`_GESTIONAR` (6 touch-points). Frontend `/almacen/prevencion` (master-detail: bandeja + detalle con hechos + clasificar/resolver/monitoreo + timeline; "Importar diferencias" desde folio de conteo + "Abrir" manual). Nav "Prevención" (grupo Conciliación). Builds api+view OK. Smoke `test-newdb-inventory-investigation` **17/17** (en `run-all-tests`). **Pendiente prod:** aplicar mig a Railway + redeploy + asignar `COMMERCIAL_PREVENTION_*` en `/admin/roles` (al rol `prevencion_auditoria`) + re-login. **Diferido:** botón "investigar" embebido en el folio de Fase I; timeline con `stock_lot_movements` (lote) + `inventory.warehouse_stock_movements` (modo inventory).

**Qué (Frank §5-9):** una diferencia confirmada abre un **expediente de investigación** (folio); el sistema arma la **línea de tiempo del SKU** para no navegar 5 módulos; Prevención clasifica la **causa raíz**, documenta y cierra ligando el ajuste (nunca huérfano).

- Migración `commercial.inventory_investigations` (folio `INV-DIF-YYYY-NNNNN`, warehouse, product, expected/physical/difference, value_at_cost, status `open|investigating|resolved|monitoring`, `root_cause`, resolution, `adjustment_movement_id`, opened/resolved by/at) + secuencia. RLS forzado.
- Taxonomía de causa raíz: **EC** error de conteo · **ER** error de recepción · **EA** error de aplicación · **DC** devolución cliente · **DP** devolución proveedor · **TR** transferencia · **UB** ubicación · **MR** merma · **PNI** pérdida no identificada.
- Backend `InventoryInvestigationService`: `open` (desde un item de conteo o manual), `list`, `detail` (con timeline), `classify`, `resolve` (liga ajuste), `toMonitoring` (si PNI → alimenta PREV.2). **SKU timeline** = unión cronológica de `stock_movements` (+ conteos + capturas de recepción) filtrable por (almacén, producto).
- Permisos nuevos `COMMERCIAL_PREVENTION_VER` / `_GESTIONAR` (segregación: distintos de CONTAR/RECONCILIAR).
- Frontend `/almacen/prevencion` (bandeja) + detalle (timeline + clasificar + resolver). Nav "Prevención".

**Esfuerzo:** medio. Reusa Fase I + ledgers. *El fundamento — todo lo demás cuelga de poder abrir/investigar/cerrar una diferencia.*

### PREV.2 — Monitoreo intensivo + ventanas de pérdida

**Qué (Frank §10-13):** tras una **pérdida no identificada**, el SKU entra a **monitoreo intensivo** (2 conteos/día, horarios parametrizables/variables). Cada conteo acota la **ventana temporal** de la merma → reduce el universo de investigación.

- Tabla `commercial.inventory_monitoring` (SKU/almacén en monitoreo, cadencia, horarios) + `monitoring_counts` (conteos rápidos con timestamp → diferencia por ventana).
- Cron/agenda que genera los conteos del día; UI de captura rápida + vista de ventanas ("la pérdida ocurrió entre 09:00 y 17:00").
- **Esfuerzo:** medio-alto.

### PREV.3 — Escalamiento por reincidencia + Índice de riesgo

**Qué (Frank §14-15):** reincidencia sube el nivel; **índice de riesgo** por SKU/ubicación/categoría/horario/proceso para dirigir recursos de Prevención. **No acusa personas** — reporta recurrencia bajo condiciones.

- Tabla `commercial.inventory_risk_index` (computada) + scanner nocturno.
- UI de priorización.
- **Esfuerzo:** medio.

---

## Secuencia
PREV.1 (fundamento) → PREV.2 (monitoreo) → PREV.3 (riesgo). Cada una es una rebanada vertical con migración + backend + frontend + smoke.

## ADRs
- Addendum a ADR-029 (Supervisor de Movimientos) o ADR nuevo: Prevención = autoridad única del ajuste por diferencia; todo ajuste ligado a un expediente.
