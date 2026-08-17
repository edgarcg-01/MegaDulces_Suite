# Fase WMS-REC — Estación de Recepción viva

> **Estado:** 🟢 Piezas 1 + 2 + 3 CONSTRUIDAS (beta) LOCAL — 2026-08-17. Ver el detalle ✅ por pieza abajo. Pendiente prod: 5 migraciones a Railway + redeploy + permisos.
> **Origen:** cierra la brecha central del [Proyecto A — WMS / Inventario Trazable](PROYECTO_WMS_INVENTARIO_TRAZABLE.md): hoy tienes el lado de **planeación** (Compras/RA) y el de **evidencia en oficina** (`/compras/entradas`), pero NO la **estación de recepción en la rampa** que pide Frank — donde el operador escanea, captura lote+caducidad con foto→OCR, recibe semáforo 🟢/🟡/🔴 y ubica el producto.
> **Principio (ADR-016):** el motor de reglas decide el semáforo; el operador confirma la realidad física; el OCR propone pero no autoriza.

---

## 0. Decisión de arquitectura previa (la que hay que fijar)

**Tensión:** hoy **Kepler recibe** (X-A-40) y el feed espeja la recepción; `/compras/entradas` adjunta evidencia *después*. Frank quiere que la **app** capture la recepción física *en el momento*.

**Decisión propuesta (ADR nuevo, p.ej. ADR-044):** la estación corre **en paralelo, capturando lo que Kepler NO tiene** — Kepler sigue siendo SoR de la **cantidad** recibida; la app es dueña de la capa **lote + caducidad + ubicación + evidencia + veredicto de auditoría**, y **reconcilia** su captura contra `analytics.erp_goods_receipts`. Razones:
- Kepler **no codifica caducidad** (verificado, ADR-022) → ese dato es net-new limpio para la app.
- El proyecto trata Kepler como **read-only** (sin write-back) en todas las fases → no romper esa regla aquí.
- Permite **shippear valor sin integración de escritura al ERP** (write-back queda diferido).

Consecuencia: el "Vale de Entrada" de la app es el **folio maestro de la captura física**, ligado (por reconciliación) al doc del ERP, no un reemplazo del ERP.

---

## Pieza 1 — Modo recepción por escaneo

> **✅ CONSTRUIDA (beta) LOCAL 2026-08-17.** Migración `20260817120000` (`commercial.receiving_sessions` = Vale vivo + `receiving_lines` + `receiving_session_sequences`, folio `VE-YYYY-NNNNN`, RLS forzado). Backend `ReceivingSessionService` + `/commercial/receiving/sessions/*` (open manual **o** desde orden de entrada ERP con precarga de líneas esperadas, scan barcode→SKU, setLine, add-line, close, cancel; discrepancia determinista ok/faltante/sobrante/dañado/producto_incorrecto). Frontend: `/almacen/inventory/recepcion-sesiones` (lista + nueva) + `/almacen/inventory/recepcion-sesiones/:id` (handheld: escaneo en vivo + "qué falta validar" + KPIs + cerrar/cancelar). Permiso reusa `COMMERCIAL_INVENTORY_RECIBIR`. Nav "Vales de entrada". Builds api+view OK. Smoke `test-newdb-receiving-session` **18/18** (en `run-all-tests`). **No escribe stock** (captura la realidad física; el alta de stock/FEFO es la Pieza 2 al aceptar, enlazada por `source_ref`=folio). **Pendiente prod:** aplicar mig a Railway + redeploy. **Diferido:** captura de caducidad por-línea embebida en la sesión (hoy la sesión y el auditor Pieza 2 comparten dominio pero son flujos separados); origen desde `purchase_orders` (hoy manual + erp_receipt).

**Objetivo (Frank §5-6):** el operador en la rampa escanea caja→pieza contra *lo esperado*, y el sistema le dice *qué falta validar* + registra faltantes/sobrantes/daños.

**"Lo esperado" viene de** (en orden de preferencia):
1. `commercial.purchase_orders` + `purchase_order_lines` (OC app-nativa, RA.15) — si la compra nació en la plataforma.
2. `analytics.erp_goods_receipts` + `erp_goods_receipt_lines` (X-A-40 del ERP) — si la compra nació en Kepler (caso mayoritario hoy).

**Migraciones nuevas:**
- `commercial.receiving_sessions` — el Vale vivo. `folio VE-YYYY-NNNNN` (secuencia atómica como `inventory_count_sequences`), `warehouse_id`, `supplier_code`, `source_kind` (`purchase_order`|`erp_receipt`), `source_ref`, `status` (`open`→`validating`→`located`→`closed`|`cancelled`), audit fields, `tenant_id` + RLS forzado.
- `commercial.receiving_lines` — `session_id`, `product_id`, `expected_qty`, `expected_boxes`, `received_qty`, `received_boxes`, `barcode_scanned`, `discrepancy_kind` (`ok`|`faltante`|`sobrante`|`producto_incorrecto`|`dañado`), `notes`.
- `commercial.receiving_sequences` — counter del folio.

**Backend** — nuevo `libs/commercial/.../commercial-receiving/` (o dentro de `commercial-inventory`):
- `POST commercial/receiving/open` — abre sesión desde PO o desde erp_receipt (precarga líneas esperadas). Perm `COMMERCIAL_INVENTORY_RECIBIR` (nuevo).
- `POST commercial/receiving/:id/scan` — barcode → resuelve SKU (reusa lookup de conteo) → incrementa `received_*`.
- `POST commercial/receiving/:id/lines/:lineId` — set cantidad/discrepancia manual.
- `GET commercial/receiving/:id/progress` — qué falta validar (esperado vs recibido).
- `POST commercial/receiving/:id/submit` — pasa a `validating`.

**Frontend** — `/almacen/recepcion` (handheld HID, **reusa el patrón de** `comercial-inventory-count.component`): escaneo caja→pieza, feed en vivo "faltan N SKUs por validar", panel de discrepancias.

**Permiso nuevo:** `COMMERCIAL_INVENTORY_RECIBIR` (receta de 6 touch-points; restrictivo → sin seed, se asigna en `/admin/roles` + re-login).

**Esfuerzo:** medio. **Depende de:** nada nuevo (usa PO/erp_receipt existentes).

---

## Pieza 2 — Auditor de recepción por caducidad ⭐ (mejor valor/esfuerzo)

> **✅ CONSTRUIDA (beta) LOCAL 2026-08-15.** Migraciones `20260815120000` (`commercial.expiry_receiving_policy`) + `20260815120100` (`commercial.receiving_lot_captures`, NC = fila `verdict='red'`). OCR `LlmExtractorService.extractExpiryLabel`. Backend `libs/commercial/.../commercial-receiving` (`ReceivingAuditorService` con `computeVerdict` determinista + `/commercial/receiving/*`: lot-capture/evaluate/captures/scorecard/authorize/reject/policy). Permiso `COMMERCIAL_INVENTORY_RECIBIR` (restrictivo, 6 touch-points; autorizar rojo = `SUPERVISAR`). Frontend `/almacen/inventory/recepcion` (captura foto→OCR→confirmar→semáforo + bandeja NC + scorecard + **diálogo de administración de políticas** gateado por `SUPERVISAR`: alta/edición/baja por producto/categoría/proveedor). Builds api+view OK. Smoke `test-newdb-receiving-auditor` **17/17** (en `run-all-tests`). **Pendiente prod:** aplicar 2 migs a Railway + redeploy api/view + asignar `COMMERCIAL_INVENTORY_RECIBIR` en `/admin/roles` + re-login + `S3_*`/`ANTHROPIC_API_KEY` para foto+OCR (degrada si faltan). **Diferido:** put-away/bin-level (Pieza 3), modo escaneo (Pieza 1).

**Objetivo (Frank §7-12):** capturar lote+caducidad con **foto→OCR**, compararlos contra el inventario existente, dar **semáforo**, **bloquear el 🔴** sin autorización, y generar **No Conformidad** → scorecard de proveedor.

**Monta sobre lo ya construido:** `commercial.stock_lots` + trigger FEFO + `recordMovement('in', lot_code, expiry_date)` ya existen. Esto solo añade la **captura + el motor de reglas + el veredicto**.

**OCR nuevo:** `LlmExtractorService.extractExpiryLabel(base64, mediaType)` → `{ lot_code, expiry_date, confidence }` (Claude Haiku vision; mismo patrón que `extractRemision`).

**Migraciones nuevas:**
- `commercial.expiry_receiving_policy` — reglas por `product_id` **o** `category` **o** `supplier_code` (fallback en cascada): `min_shelf_life_days`, `allow_older_than_existing` (bool), `source` (`manual`|`default`), RLS. Es el **motor que decide** (no el OCR).
- `commercial.receiving_lot_captures` — append-only: `session_id`/`receiving_line_id`, `product_id`, `photo_url` (ObjectStorage, R2-ready), `ocr_lot`, `ocr_expiry`, `ocr_confidence`, `confirmed_lot`, `confirmed_expiry`, `verdict` (`green`|`yellow`|`red`), `rule_broken`, `authorized_by`, `authorized_at`, audit + RLS.
- `commercial.receiving_nonconformities` — `session`, `supplier_code`, `product_id`, `lot`, `expiry`, `existing_min_expiry`, `rule_broken`, `photo_url`, `resolution` (`authorized`|`rejected`), `by`, `at` → alimenta el scorecard.

**Motor de reglas (determinista):** al confirmar caducidad, comparar `confirmed_expiry` vs:
- `min_shelf_life_days` (días desde hoy) de la política aplicable.
- `MIN(expiry_date)` de los `stock_lots` existentes del SKU en ese almacén.

| Condición | Semáforo |
|---|---|
| Cumple vida útil mínima **y** no es más viejo que lo existente | 🟢 verde → acepta |
| Cumple mínima **pero** más viejo que algún lote existente / cerca del umbral | 🟡 amarillo → advierte, permite con nota |
| Bajo vida útil mínima **o** más viejo que lo existente (proveedor entrega más viejo) | 🔴 rojo → **bloquea** |

**Backend** (dentro de `commercial-receiving` o `commercial-inventory`):
- `POST .../receiving/:id/lines/:lineId/lot-capture` — upload foto + OCR → devuelve `{ocr_lot, ocr_expiry, confidence}`. Perm `RECIBIR`.
- `POST .../receiving/:id/lines/:lineId/lot-confirm` — recibe lote/caducidad confirmados → corre el motor → devuelve `verdict`. Si 🟢: escribe a `stock_lots` (reusa `recordMovement`). Si 🔴: crea NC, **no** escribe stock.
- `POST .../nonconformities/:id/authorize` — Perm `COMMERCIAL_INVENTORY_SUPERVISAR` (o rol `prevencion_auditoria`) → libera el 🔴 y escribe stock.
- `POST .../nonconformities/:id/reject` — rechaza mercancía.
- `GET commercial/receiving/nonconformities?supplier=` — bandeja + scorecard.
- CRUD de `expiry_receiving_policy` — Perm `SUPERVISAR`.

**Frontend:**
- En la línea de recepción: botón **"Capturar caducidad"** → cámara → tarjeta de resultado OCR con **% de confianza** (si baja, pide corrección manual) → confirmar → **badge de semáforo**. El 🔴 abre diálogo de autorización/rechazo.
- Bandeja **No Conformidades** (`/almacen/recepcion/no-conformidades`) + vista **Scorecard proveedor** (NCs / recepciones, extiende `/compras/proveedores`).

**Esfuerzo:** **bajo-medio** (la mayoría de la infra de lotes ya existe). **El premio rápido.**

---

## Pieza 3 — Ubicación bin-level (lote × posición)

> **✅ CONSTRUIDA (beta) LOCAL 2026-08-17.** Migración `20260817140000` (`commercial.warehouse_bins` = posiciones + `commercial.stock_lot_locations` = Auxiliar de Ubicaciones, RLS forzado). Regla realista (no invariante estricto): **`SUM(ubicado por lote) ≤ stock_lots.quantity`**, remanente = "por ubicar" (la recepción suma al lote antes del put-away); validada en `BinLocationService.putAway`. Backend en `commercial-inventory`: bins CRUD (`ASIGNAR`), put-away por `bin_id`/`bin_code` escaneado (`RECIBIR`), `/locations` (auxiliar), `/unlocated` (por ubicar), `/pick-suggestion` (**FEFO físico**: bins ordenados por caducidad), `/bins/:id/contents` (lecturas `VER`). Frontend `/almacen/inventory/ubicaciones` (put-away con prefill desde "por ubicar" + auxiliar filtrable + admin de bins en diálogo). Nav "Ubicaciones". Builds api+view OK. Smoke `test-newdb-bin-locations` **18/18** (en `run-all-tests`). **Pendiente prod:** aplicar mig a Railway + redeploy + asignar `COMMERCIAL_INVENTORY_ASIGNAR` (admin de bins) donde aplique. **Diferido:** decremento por surtido real (integración con fulfillment), movimientos de re-acomodo entre bins, put-away embebido en la sesión de recepción (Pieza 1).

**Objetivo (Frank §13-15):** al aceptar, ubicar la mercancía en un bin; el stock sabe **lote × ubicación**; FEFO **dirige al surtidor** al bin correcto.

**Hoy:** `commercial.warehouse_aisles` (pasillos 2D) + `commercial.stock.aisle_id` (SKU→pasillo, **uno por SKU**). Falta granularidad bin + lote.

**Migraciones nuevas:**
- `commercial.warehouse_bins` — `aisle_id`, `code` (rack-nivel-posición), `warehouse_id`, RLS.
- `commercial.stock_lot_locations` — **el Auxiliar de Ubicaciones**: `(warehouse, product, lot_code, expiry, bin_id) → quantity`. **Invariante:** `SUM(lot_locations.qty por lote) = stock_lots.quantity` (mismo patrón trigger que `stock_lots↔stock`). Append de movimientos de ubicación en tabla hermana si se quiere trazar re-acomodos.

**Backend:**
- `POST .../receiving/:id/put-away` — escanea bin + lote + cantidad → asigna a `stock_lot_locations` (+ foto opcional de acomodo). Perm `RECIBIR`.
- `GET commercial/inventory/bins/:bin_id` — contenido del bin.
- `GET commercial/inventory/pick-suggestion?wh=&product=` — devuelve el bin con la **caducidad más próxima** (FEFO físico).

**Frontend:**
- Paso **put-away** en la estación (escanear ubicación, foto opcional).
- Hint de surtido FEFO ("ve primero a bin X") en el flujo de picking/pedido.

**Esfuerzo:** **alto** (WMS clásico: invariante lote×bin + put-away + picking). La pieza más pesada.

---

## Cross-cutting

- **Inmutabilidad (Frank §18):** capturas/OCR/NC son append-only; correcciones = evento nuevo (conteo original + corrección + usuario + motivo). Los ledgers actuales (`stock_lot_movements`, `warehouse_stock_movements`) ya siguen el patrón.
- **Fotos:** `ObjectStorageService` (ya R2-ready, ver `project_fase_infra_worker_tier`).
- **Reconciliación con ERP:** un job compara `receiving_sessions` (físico app) vs `analytics.erp_goods_receipts` (cantidad ERP) y marca divergencias → reusa el patrón de `libs/reconciliation`.

---

## Secuencia recomendada

| Orden | Pieza | Esfuerzo | Por qué |
|---|---|---|---|
| **1º** | **Pieza 2 — Auditor de caducidad** | bajo-medio | Monta sobre FEFO ya hecho; es el corazón de Frank; valor inmediato (semáforo + NC + scorecard). **Se puede hacer standalone**, sin la estación completa: la captura foto→OCR→semáforo funciona incluso adjunta a `/compras/entradas`. |
| 2º | Pieza 1 — Modo escaneo | medio | Da la estación en la rampa (Vale vivo + qué falta validar). |
| 3º | Pieza 3 — Bin-level | alto | WMS clásico; el mayor esfuerzo, se puede diferir hasta tener demanda de put-away real. |

**Nota importante:** la **Pieza 2 no requiere las otras dos**. Se puede shippear como un "auditor de caducidad" que corre sobre el flujo de entrada actual → premio rápido, riesgo bajo, y valida el motor de reglas antes de invertir en la estación completa y el bin-level.

---

## ADRs a crear

- **ADR-044** — Estación de recepción en paralelo (app dueña de lote/caducidad/ubicación/evidencia; Kepler SoR de cantidad; sin write-back; reconciliación).
- Addendum a **ADR-022** — el auditor de recepción usa el semáforo como **gate en la puerta** (además del WARN al vender ya existente).

## Permisos a crear

- `COMMERCIAL_INVENTORY_RECIBIR` (estación) — restrictivo, sin seed.
- Autorización del 🔴 reutiliza `COMMERCIAL_INVENTORY_SUPERVISAR` / rol `prevencion_auditoria`.
