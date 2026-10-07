# Proyecto A — WMS / Inventario Trazable

> **Origen:** visión del Jefe Frank (WhatsApp 14-ago-2026) — "de recibir mercancía a construir la identidad digital del inventario" + Apéndice A (Promotoría externa) + Apéndice B (Prevención de Inventarios).
> **Análisis:** 2026-08-15, verificado contra el código actual (no contra notas viejas).
> **Tesis del proyecto:** no es "una app para tomar fotos de caducidades". Es la **cadena de trazabilidad del inventario** desde antes de que llegue el camión hasta la ubicación física — con evidencia y reglas.
> **Principio (coincide con ADR-016):** el motor decide, el operador confirma la realidad física, el LLM/OCR propone pero no autoriza. Frank llegó al mismo principio de forma independiente.

Leyenda: ✅ **Completo** · 🟡 **Parcial** (existe base, falta cerrar) · ⬜ **No existe**

---

## 1. Recepción (Requerimiento → OC → Orden de Entrada → Vale de Entrada)

| # | Capacidad que pide Frank | Estado | Evidencia / brecha |
|---|---|---|---|
| 1.1 | Cadena de doctypes procure-to-pay decodificada | ✅ | X-A-30→35→37→40→**XA2001** verificado y con espejo. `analytics.erp_goods_receipts` (+`_lines`), multi-fuente md_00–05 + Wincaja. Ref: `reference_kepler_reception_flow`. |
| 1.2 | Recepción física con evidencia (folio maestro = Vale) | ✅ | `finance.goods_receipt_proofs` (mig `20260803130000`), backend `libs/finance/.../goods-receipt-proofs`, ruta `/compras/entradas`, live socket. |
| 1.3 | OCR de la remisión/factura (no recapturar) | ✅ | `LlmExtractorService.extractRemision()` (Claude Haiku vision, imagen y PDF) llamado desde `goods-receipt-proofs.service.ts`. |
| 1.4 | Requerimiento + Orden de Compra como objetos | ✅ | `commercial.purchase_requisitions` + `_lines` (mig `20260709120000`), folio `RQ-YYYY-NNNNN`, flujo HITL aprobar/rechazar. OCs `20260710180000`. |
| 1.5 | Cuadre 3-vías (OC vs entrada vs factura) | ✅ | `discrepancy_kind` clasificado y persistido (mig `20260805160000`); `purchase-adjustments` con `for-entrada`, `duplicates`, `compras-360`. |
| 1.6 | "El sistema le dice al operario qué falta validar" | 🟡 | El detalle de entrada muestra cuadre y auto-explica el descuadre (X-D-40/55), pero **no hay checklist guiado de validación por caja/pieza escaneada** durante la recepción. |
| 1.7 | Escaneo código de caja + código de pieza en recepción | 🟡 | Barcode existe en catálogo/conteo (97% cobertura), pero **el flujo de escaneo caja→pieza contra lo esperado en la puerta no está armado como pantalla de recepción**. |

**Nuevo aquí:** 1.6 y 1.7 — el "modo recepción" guiado por escaneo (qué falta validar, comparar físico vs esperado en vivo).

---

## 2. Lote / Caducidad / FEFO

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 2.1 | Sub-ledger de lotes (identidad del lote) | ✅ | `commercial.stock_lots` (mig `20260618200000`) + `stock_lot_movements` (`20260618230000`). Invariante `SUM(lotes)=stock`. |
| 2.2 | Captura de lote + caducidad en recepción | ✅ | `recordMovement()` acepta `lot_code`/`expiry_date`, upsert al recibir (`movement_type='in'`). |
| 2.3 | FEFO real (primero lo que caduca; vencido al último) | ✅ | Trigger invariante (`20260618210000`) + expired-last (`20260618220000`). Verificado `verify-fefo-expired-last.js`. Política vencidos = **WARN, no block**. |
| 2.4 | Dashboard "por vencer" + valor en riesgo | ✅ | `GET /commercial/inventory/expiring`, ruta `/comercial/inventory/expiring`. |
| 2.5 | Alertas de caducidad (cron) + aviso al despachar vencido | ✅ | `AlertsScannerService`: `expiring_lots` + `sold_expired`. |
| 2.6 | **Foto de la impresión de caducidad → OCR → confirmar** | ⬜ | El OCR (`extractRemision`) y `stock_lots` existen, pero **no hay flujo "operador fotografía la fecha impresa → OCR extrae lote/caducidad → confirma"** ligado al Vale. Frank lo pide explícitamente (§8). Ensamblable con piezas existentes. |
| 2.7 | **Auditor de recepción: caducidad entrante vs inventario existente** | ⬜ | Hoy la política es WARN al **vender**, no un **control en la puerta**. Falta: comparar caducidad del lote nuevo contra lotes existentes del SKU y dar semáforo 🟢/🟡/🔴, rechazar proveedor que entrega más viejo, caducidad mínima por producto/proveedor. **Corazón de la visión de Frank (§10-11).** |
| 2.8 | Control de vencidos/próximos existente ("PRÓXIMOS Y EXCEDENTES 2026") | 🟡 | El dashboard `/expiring` cubre "próximos"; falta migrar el control operativo actual al dato transaccional. |

**Nuevo y de alto valor:** 2.6 (captura foto+OCR de caducidad) y 2.7 (auditor de recepción con semáforo/gate). Ambos montan sobre FEFO ya construido → esfuerzo bajo, valor alto.

---

## 3. Conteo físico / Inventario (Fase I)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 3.1 | Conteo ciego + doble conteo por contadores distintos | ✅ | `inventory-count.service.ts`, `blind_double_count` default, `count_1/count_2`. |
| 3.2 | Segregación de funciones (quien cuenta no reconcilia) | ✅ | `count_2≠count_1`, reconciliador no contó, `count_3` desempate por tercero. |
| 3.3 | Coverage guard + freeze guard | ✅ | Reconcile rechaza no-contado; freeze cross-module en order flow. |
| 3.4 | Reason codes de varianza (merma/caducado/robo/error) | ✅ | `inventory_variance_reason_codes` (mig `20260618180000`). |
| 3.5 | KPI de exactitud (IRA) + tolerancia/count-back | ✅ | Endpoint `/counts/ira`, `recount_threshold_pct`. |
| 3.6 | Ledger de ajustes inmutable | ✅ | `warehouse_stock_movements` append-only. |
| 3.7 | Conteo cíclico ABC | ✅ | Fase ABC completa, ruta `/inventory/abc`. |

**Fase I está madura.** No hay brechas contra lo básico que pide Frank en conteo.

---

## 4. Ubicaciones físicas (WMS bin-level)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 4.1 | Pasillos / racks / equipos | ✅ | Fase PA núcleo completo: `commercial.warehouse_aisles` (mig `20260619140000`), ruta pasillos. |
| 4.2 | **Auxiliar de ubicaciones lote × posición** | 🟡 | `commercial.stock` es único por (almacén, producto); `location` es **pista, no eje**. Falta stock a nivel **lote × ubicación (pasillo-rack-nivel-posición)** que pide Frank (§13). |
| 4.3 | FEFO de surtido dirige al bin correcto | 🟡 | FEFO decrementa el lote correcto en el ledger, pero **no dirige físicamente al surtidor a un bin** ("ve primero a esta ubicación") — depende de 4.2. |
| 4.4 | Foto de acomodo (memoria física del almacén) | ⬜ | No existe captura de foto de la mercancía colocada en su ubicación (§16). |

**Nuevo:** 4.2/4.3/4.4 — bin-level real con lote y foto. Es la parte más "WMS clásico" y la de mayor esfuerzo.

---

## 5. Prevención de Inventarios (Apéndice B)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 5.1 | Rol Prevención separado de quien ajusta | ✅ | Rol `prevencion_auditoria` en `role-presets.ts`; permiso `COMMERCIAL_INVENTORY_RECONCILIAR` separado de SUPERVISAR/CONTAR/ASIGNAR. |
| 5.2 | Folio de diferencia que congela evidencia | 🟡 | El conteo genera discrepancias + reason_code + ledger, pero **no hay un objeto "folio de diferencia" independiente del conteo** con su propio expediente. |
| 5.3 | Segundo conteo independiente | ✅ | Doble/triple conteo con segregación (3.1/3.2). |
| 5.4 | **Expediente de investigación de causa raíz** | ⬜ | Existe maquinaria adyacente (`reconciliation-findings`, `movement-reconcile`, reason_codes), pero **no el expediente con árbol guiado** (recepción/transferencia/venta/devolución/merma/ubicación) que pide Frank (§6). FASE_SM (ADR-029) lo describe en diseño. |
| 5.5 | **Línea de tiempo del SKU** | 🟡 | "Diario de Movimientos" (`commercial-movements`) filtra por `product_id` y da drill línea a línea, pero **no hay una vista timeline dedicada del SKU** que consolide entrada/transferencia/venta/devolución/ajuste/conteo en una sola pantalla (§7). Data existe; falta la vista. |
| 5.6 | Clasificación de causa (EC/ER/EA/TR/UB/MR/PNI…) | 🟡 | Reason codes existen a nivel item; falta la **taxonomía de causa raíz de investigación** que pide Frank (§8). |
| 5.7 | Ajuste nunca huérfano (ligado a investigación) | 🟡 | El ajuste queda en el ledger con reason_code, pero **no obligatoriamente ligado a un expediente de investigación** (depende de 5.4). |
| 5.8 | **Monitoreo intensivo 2×/día + ventanas de pérdida** | ⬜ | No existe. Es el corazón de "Prevención" (§11-12): tras pérdida no identificada, dos conteos diarios para acotar la ventana temporal de la merma. |
| 5.9 | Escalamiento por reincidencia | ⬜ | No existe (§14). |
| 5.10 | **Índice de riesgo de inventario** (SKU/ubicación/horario/proceso) | ⬜ | No existe (§15). |
| 5.11 | Inmutabilidad (nunca sobrescribir, solo agregar eventos) | 🟡 | Los ledgers son append-only; falta extender el principio a conteos/fotos/OCR/investigaciones formalmente (§18). |
| 5.12 | "El sistema no acusa personas, detecta patrones" | ⬜ | Depende de 5.8-5.10. |

**Nuevo (extensión natural de Fase I):** 5.4 (investigación), 5.5 (timeline SKU consolidado), 5.8-5.10 (monitoreo intensivo + ventanas + índice de riesgo). Este bloque es el que convierte "conteo" en "Prevención".

---

## 6. Promotoría externa (Apéndice A)

| # | Capacidad | Estado | Evidencia / brecha |
|---|---|---|---|
| 6.1 | Scope del promotor por marca | ✅ | `commercial.promoter_brands` (mig `20260810160000`, RLS), admin UI `/comercial/.../promotores`. |
| 6.2 | Flujo de inspección de caducidades del promotor | ✅ | `commercial-expiry-reviews` (mig `20260810120000` + ubicación `20260810140000`): crear, upload, líneas, submit. UI detalle. |
| 6.3 | **Usuario EXTERNO controlado (tipo guest)** | 🟡 | El promotor es un **mapeo marca↔usuario normal**, no un tipo de usuario externo. Falta `user_type`/`is_external`, rol guest en seeds, y aislamiento (nada de costos/márgenes/competidores §3). |
| 6.4 | Cadena de supervisión externa (supervisor del proveedor) | ⬜ | No existe expediente con datos del supervisor/vendedor externo (§2). |
| 6.5 | Cierre de inspección → **reporte automático** | 🟡 | Existe `submit`; falta la **generación del Reporte de Inspección** consolidado con folio (§6). |
| 6.6 | Envío por **correo** al supervisor externo | ⬜ | No hay dispatch de correo desde el flujo. |
| 6.7 | Envío por **WhatsApp** al supervisor externo | ⚠️ | **Bloqueado por decisión pendiente:** WhatsApp BSP sin decidir (ADR-006). No arrancar hasta resolver. |
| 6.8 | Bitácora de comunicaciones (a quién se informó y cuándo) | ⬜ | Depende de 6.5-6.7. |
| 6.9 | Inspección profunda de mueble (protocolo 10 pasos, 90 días) | ⬜ | No existe; extensión del core de capturas de PdV. |

**Nuevo:** 6.3-6.9. Es el frente **menos construido** de este proyecto, y el que roza el bloqueo de WhatsApp. El correo sí es viable ya.

---

## 7. Resumen ejecutivo — qué falta realmente

**Ya lo tienes (no hay que construirlo):** cadena de recepción decodificada, recepción con evidencia + OCR + cuadre 3-vías, sub-ledger de lotes + FEFO + alertas de caducidad, conteo físico completo (ciego/doble/segregación/IRA/ABC), pasillos, rol de Prevención, scope de promotor por marca + expiry-reviews.

**Genuinamente nuevo, ordenado por relación valor/esfuerzo:**

1. 🥇 **Auditor de recepción por caducidad** (2.7) + **captura foto→OCR de caducidad** (2.6) + **NC de vida útil + scorecard de proveedor** — bajo esfuerzo (monta sobre FEFO), alto valor. *El premio rápido.*
2. 🥈 **Prevención: investigación causa-raíz (5.4) + timeline SKU (5.5) + monitoreo intensivo/ventanas/índice de riesgo (5.8-5.10)** — esfuerzo medio, extiende Fase I. *El diferenciador de control.*
3. 🥉 **Modo recepción guiado por escaneo** (1.6/1.7) + **bin-level lote×ubicación con foto** (4.2-4.4) — esfuerzo alto (WMS clásico).
4. **Promotoría externa completa** (6.3-6.9) — depende de decidir WhatsApp BSP; el reporte + correo se puede adelantar.

**Sin dependencia de datos externos:** todo este proyecto corre sobre datos que ya controlas (Kepler recepción + `commercial.*`). No tiene el limitante de granularidad que sí afecta al Proyecto B.

---

## 8. Relación con otras fases del repo

`FASE_RE_RECEPCION_MERCANCIA` (recepción 360, diseño) · `FASE_FEFO_CADUCIDAD` (P2, MVP completo) · `FASE_I_INVENTARIO` (conteo, I.0-I.3 ✅) · `FASE_PASILLOS_EQUIPOS` (PA ✅) · `FASE_ABC_CYCLE_COUNT` (✅) · `FASE_SM_SUPERVISOR_MOVIMIENTOS` (ADR-029, diseño) · `FASE_RA_REABASTECIMIENTO` (compras ✅).
