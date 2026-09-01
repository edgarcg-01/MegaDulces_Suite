# Fase WMS-REC — Estación de Recepción viva

> **Estado:** 🟢 Piezas 1 + 2 + 3 CONSTRUIDAS (beta) LOCAL — 2026-08-17 · **Pieza 1+2 COSIDAS (captura de lote POR RENGLÓN) 2026-08-25**. Ver el detalle ✅ por pieza abajo. Pendiente prod: 6 migraciones a Railway + redeploy + permisos.
>
> **[WMS-REC.7] 🧪 2026-09-01 — Andén de Entrada: dos puertas en una sola pasada.** Reemplaza el recorrido de 4 pantallas por una pantalla de foco junto al camión. **79 toques → 24** en un vale de 5 líneas (2 traer el vale de Kepler · 11 contar y dar acceso · 2 por renglón en la puerta 2).
> - **La tesis: son DOS PUERTAS con dos relojes distintos.** La **puerta 1 (cotejo y acceso)** corre contra el chofer — identificar el vale con el folio del papel, contar contra Kepler, dar acceso; la mercancía entra en lote `NA` y el camión se va. Ahí **nadie fotografía etiquetas**: el andén ocupado es el recurso que no se quiere gastar. La **puerta 2 (fechado y acomodo)** corre contra el anaquel, sin prisa. Hoy el sistema las mezcla, y por eso fechar y ubicar compiten con la siguiente tarima **y pierden siempre**.
> - **Ruta `/almacen/anden`**, pantalla de **foco** (fuera del shell de tabs, declarada antes del padre `path: ''`), permiso `COMMERCIAL_INVENTORY_RECIBIR`. Se entra **escaneando el folio del papel, no eligiendo de una lista** — es la diferencia de fondo con la pantalla vieja.
> - **Subcomponentes de verdad** (`anden/components/`, 4 piezas + `anden.state.ts` con signals y cero red). El área tenía **ocho páginas y cero carpetas `components/`**, con archivos de 700 a 1,500 líneas; esto no lo repite.
> - **Cajas, no piezas.** `calcularTotal(cajas, sueltas, uxc)` en `cantidad.util.ts` (puro, testeado) + chip **Llegó todo** + la diferencia dicha en el idioma correcto ("faltan 48 — 2 cajas"). Mata los `−1/+1`, que convertían una corrección de 12 piezas en 12 clics y 12 POST.
> - **⚠️ Hallazgo verificado contra `platform_test`: el `uxc` casi no existe.** `catalog.product_barcodes` tiene 12,357 filas vivas, pero **sólo 358 SKU de 11,525 (3.1 %) tienen código de caja** (`factor > 1`) y **4,579 filas tienen `factor` en `null`** (todas `wincaja`). O sea que "contar por cajas" **no se destraba arreglando `resolveProductByCode()`** —que sí hace `.distinct('sku')` y descarta el factor, eso es cierto— porque para 97 de cada 100 productos **no hay dato de cuántas piezas trae la caja**. La UI deshabilita el campo de cajas y cuenta por piezas cuando falta; **no se inventa ni se hardcodea un factor**. Decisión pendiente: capturarlo a mano, derivarlo de `kdii.c84` (Fase AX ya lo decodificó), o dejar el andén en piezas.
> - **Semáforo anticipado**, pero honesto: se pinta mientras se teclea, con los días de vida y la caducidad más próxima ya en stock (derivada de `pick-suggestion`). **No se duplica la cascada producto→departamento→proveedor en el front** — `resolvePolicy()` sigue privado y copiarla la desincronizaría del backend. Falta `GET /policy/resolve` para mostrar la vida útil mínima real.
> - **Rack precargado** desde `GET /pick-suggestion` — el endpoint estaba implementado, tipado en el frontend y **no lo invocaba nadie**.
> - **El almacén se hereda del vale y nunca se re-pregunta.** `open()` ni lo manda: lo deriva el backend del mapa sucursal→almacén.
> - **Sin `settle` transaccional todavía** (va aparte): la puerta 2 hace **dos** llamadas (`evaluate` + `put-away`). Si la segunda falla, el renglón queda `sinUbicar`, se avisa *"Se fechó pero no se acomodó"* y **NO se marca terminado** — justo el modo en que hoy se acumula mercancía fantasma. Sin rack tampoco: *"Fechado sin rack"*.
> - **Fuera de alcance:** el tablero del supervisor, el endpoint `settle`, y el renombre `closed` → `con_acceso` / `cerrado`.
> - **Corrección al plan recibido:** decía que `--tap-min` no está definido en ningún archivo y que la regla de `styles.css` no hace nada. Es al revés — `tokens.css:494` lo define en `0px` y `:504` lo sube a **44px** bajo `@media (pointer: coarse)`. Es densidad por método de entrada (Polaris/Carbon), deliberada, y en un handheld ya da 44 px sola.
> - **Verificado:** `nx build view` verde · `nx test view` **4 suites, 40 tests** · lint sin sumar problemas (el repo arrastra 1,144; los 4 que introduje se limpiaron). **Falta validación visual y con pistola real.**
>
> **[WMS-REC.6] 🧪 2026-09-01 — piezas base de los aceleradores de Entrada + se encendió Jest.** Rebanada chica y honesta de un plan de cuatro cambios: **dos ya estaban hechos** y **uno está bloqueado**, así que lo que va acá es la pieza pura del tercero más la infraestructura que faltaba para poder testear.
> - **Hallazgo 1 — dos de los cuatro cambios ya existían** en el working tree de otra sesión, sin commitear. La *cantidad tecleada en vez de ∓1*: `adjust()` fue eliminado y ya hay `setRec(line, expected_qty)` con **un solo** `setLine({ received_qty })` y su chip "recibir todo". El *encadenado de Por fechar*: el diálogo ya no cierra y la regla del lote ya se unificó a vacío = `NA`. **Rehacerlos habría sido construir lo mismo dos veces sobre 843 y 632 líneas ajenas.** Los números de línea del plan coinciden con `origin/main`, no con el working tree — de ahí la confusión.
> - **Hallazgo 2 — `nx test view` estaba roto para todo el mundo.** El target apuntaba a `apps/view/jest.config.ts`, que **no existía**; tampoco `jest.preset.js` ni `src/test-setup.ts`; y `tsconfig.spec.json` declaraba `types: ["jasmine"]` (no jest) con un `rootDir` clavado a **una sola carpeta de componente**, así que cualquier spec fuera de ahí quedaba fuera del programa de TS. En todo el monorepo había **un solo** `jest.config.ts`, el de la raíz, que resuelve proyectos con `getJestProjectsAsync()` y por lo tanto encontraba cero. Las dos specs que ya existían en `view` **nunca corrieron**. Las herramientas sí estaban instaladas (`jest 30`, `jest-preset-angular 17`, `jest-environment-jsdom`): faltaba el config.
> - **Encendido:** `jest.preset.js` + `apps/view/jest.config.ts` + `src/test-setup.ts` (entrypoint `jest-preset-angular/setup-env/zone`; el viejo `setup-jest` se retiró en v17) + `tsconfig.spec.json` corregido. Al prender, una suite falló por una causa trivial: `offline-status.component.spec.ts` **estaba vacío** con la nota *"TODO: implementar tests cuando el entorno de testing esté configurado"* — y un `.spec.ts` sin tests tumba la suite entera. Quedó con `it.todo()`: la deuda sigue declarada y visible en cada corrida, sin romper el target. **`nx test view`: 3 suites, 31 pasan, 3 todo.**
> - **`parseExpiryShort()`** (`modules/almacen/shared/expiry-short.ts`) — captura de caducidad en **dígitos pelados**, sin separadores que teclear con guantes: `0327` → `2027-03-31` (MMAA, último día del mes: la mayoría del dulce imprime sólo mes y año), `150327` → `2027-03-15` (DDMMAA). Función **pura y exportada**, separada del componente, con `formatExpiryEcho()` para el eco `DD/MM/AAAA` antes de guardar. **El día se valida contra SU mes**: `310228` → `null`, porque sin eso `Date` desborda a marzo y guarda una caducidad falsa. 12 casos en `expiry-short.spec.ts`, incluidos bisiesto (`0228` → 29/02/2028) y no bisiesto.
> - **Sin cablear todavía, a propósito.** Las 4 pantallas donde iría (`recepcion-auditor`, `caducidades-por-fechar`, `ubicaciones`, `recepcion-sesion`) incluyen 3 archivos que la otra sesión está reescribiendo. Cablearlo ahora garantiza conflicto; la pieza pura no.
> - **Croquis del CEDIS transcrito** (`database/importers/warehouse/cedis-layout.json`): 4 zonas (Tapanco / Arriba / Abajo / Macha) y **14 ubicaciones** con el grid del dibujo. **Hallazgo: la bodega está organizada por MARCA y FAMILIA, no por coordenada rack-nivel-posición** — así que la ubicación se *deriva* de la marca del producto y el put-away sugerido sale casi gratis. Eso baja el bin-level de "el trabajo más pesado" a barato. Dos cosas más que salieron del dibujo: **LA ROSA vive en dos ubicaciones** (`stock.aisle_id` es uno por SKU → hace falta `stock_lot_locations`), y *EXCESO* / *ZONA DE RESTOS* no son marca ni familia sino **overflow** (el `kind` de bin que faltaba). **Sin validar contra el catálogo**: falta confirmar que TINAJITA, WINIS, JONYY, KARLA etc. existan como marcas, y eso necesita DB.
> - **Bloqueado y declarado, no improvisado:** el rack precargado (`pickSuggestion`) pedía verificar con una llamada real qué devuelve el endpoint antes de cablearlo — **imposible hoy**: `app_runtime` y `postgres` dan `28P01` en el cluster compartido (credencial rotada, [GOTCHAS §24](../../GOTCHAS.md)). Precargar a ciegas es justo lo que el plan prohibía. Igual el test de `resolveAlmacenArea()` que pedía el plan: `almacen-tabs.ts` **no está en `main`**, vive en el PR de WMS.1 sin mergear.
> - **Código de tracker a confirmar con Edgar** (asumido `WMS-REC.6` por continuidad).
>
> **[WMS-REC.4] ✅ 2026-08-25 — captura de lote por renglón + fix del bug que la bloqueaba.** Cierra el diferido "captura de caducidad por-línea embebida en la sesión". **ADR-044 escrito** (existía el hueco entre ADR-043 y 045): reparto de autoridad Kepler-vs-app, **un único escritor de stock**, **aceptación parcial con veredicto por lote**, eje de política = `products.department`, y `MM/AAAA` → último día del mes.
> - **Bug bloqueante corregido (reproducido en runtime, no inferido):** `evaluate()` leía `products.category`, **columna que no existe** → `42703` → **500 en TODA captura**; la ruta principal de la Pieza 2 nunca funcionó. Segunda capa del mismo bug: `department` sí existe en `catalog.products` pero **NO** en la vista compat `public.products`, que es un `SELECT *` **congelado al crearse** (mig `20260603150000`) y no expone columnas agregadas después (mig `20260615130000`). Se lee de `catalog.products`.
> - **Por qué no lo vio el smoke previo:** `test-newdb-receiving-auditor.js` **reimplementa** `computeVerdict` en JS ("mirror exacto") e inserta filas con knex — nunca llama `evaluate()`/`authorize()`. 17/17 verde con la ruta caída. Regla nueva del ADR: los cambios de la estación se prueban **por HTTP**.
> - **Mig `20260825120000`** (aditiva, idempotente): `receiving_lot_captures.receiving_line_id` + FK compuesta `(tenant_id, receiving_line_id)` + índice parcial. **Nullable**: la captura suelta sin vale sigue válida.
> - **Backend:** `evaluate` acepta y valida `receiving_line_id` (renglón existente · vale **abierto** · **mismo producto**); `listCaptures` filtra por `receiving_line_id`/`session_id`; `detailTx` deriva `declared_qty`/`held_qty`/`holds` por renglón y `declared_units`/`undeclared_units`/`held_units` en progress (**se deriva, no se denormaliza**); `close()` **409 si hay capturas `pending_authorization`**; `authorize`/`reject` pasan a **claim atómico** (UPDATE condicional + compensación) — antes dos supervisores concurrentes duplicaban stock.
> - **Frontend** `/almacen/inventory/recepcion-sesiones/:id`: columna *Declarado* con "faltan N", KPIs *sin declarar* / *retenidas*, banner de retenidos, y panel `app-side-peek` con mini-form repetible (foto→OCR→confirmar→cantidad del lote) + normalización `DD/MM/AAAA`/`MM/AAAA` + autorizar/rechazar en línea. Targets ≥44px en `pointer: coarse`.
> - **Indicador nuevo que antes no existía:** *piezas recibidas con lote+caducidad declarados* (`undeclared_units` es su complemento) — la mercancía que entra sin trazabilidad.
> - **Smoke HTTP real** `database/tests/http-receiving-lot-line-test.js` **37/37** (2 corridas, idempotente) + registrado en `run-all-tests` (90 suites). Regression de dominio verde: auditor 17/17 · sesión 18/18 · bin-level 18/18 · conteo 13/13. Builds api+view OK.
> - **Pendiente prod:** mig `20260825120000` a Railway + redeploy api+view. **Diferido:** cajas/piezas en el renglón (`expected_boxes`/`received_boxes` quedaron fuera de la mig original), put-away embebido, reconciliación automática vs `analytics.erp_goods_receipts`.
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
