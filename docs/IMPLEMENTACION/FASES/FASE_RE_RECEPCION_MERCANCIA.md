# Fase RE — Recepción de Mercancía 360

> **Estado:** 🔨 DISEÑADO (planeación) · 2026-08-04 · flujo + causas del descuadre + canal de descuentos **VERIFICADOS** (3 PDFs + ~12 sondeos de datos)
> **Tesis:** convertir la bitácora manual (Excel "Reporte Recepción de Mercancía MD 2026", Google Form→Sheet) en un **motor de control** de recepción sobre Kepler + Wincaja: read-only sobre el ERP, el motor decide / el humano valida (hereda ADR-016 / ADR-028 / patrón CC).
> **ADR propuesto:** ADR-041 — Recepción 360: orquestación read-only multi-fuente (CEDIS md_00 + sucursales Kepler md_01-05 + Wincaja); vencimiento desde `c18`; enlace a pago heurístico (Kepler no lo liga estructuralmente).

---

## 1. Contexto

El Excel legacy (~910 recepciones ene–ago 2026, 23 columnas) es un **log pasivo**: se captura y ya. Su valor real eran dos controles — **cuadre Factura vs Compra** (que fallaba el **41%**, incl. un typo de $183M invisible) y **vencimiento de pago** (que estaba **roto**: 89 filas con −46,238 días por fecha de vence vacía). Ya tenemos la base digital: `/compras/entradas` (`goods-receipt-proofs`) sobre XA2001 con OCR + cuadre + validación restringida (`COMPRAS_VALIDAR`) + búsqueda inteligente. Esta fase la vuelve el módulo insignia de Compras.

**El cambio de sistema se justifica con:** deja de perderse el typo de millones, deja de haber vencimientos sin control, hay trazabilidad auditable, y **cubre lo que el Excel cubría y más** (hoy el feed digital ve MENOS que el Excel — ver §4).

## 2. El flujo verificado (end-to-end, 2026-08-04)

```
Requisición X-A-30 → OC X-A-35 → Vale X-A-37 → Orden entrada X-A-40 → APLICA X-A-20 (XA2001) ← ancla
                                                       (mueve inventario)   proveedor firma · remisión · póliza
```

En la **XA2001** (`md.kdm1`): `c6`=folio · `c9`=fecha recepción · `c10`/`c32`=proveedor · `c16`=**total con IVA (=Compra)** · **`c30`=condición de pago** (contado / "N días fecha factura") · **`c18`=FECHA DE VENCIMIENTO** (columna limpia = c9+días) · `oc_folio`/`vale_folio` (cadena c39).

**Fuera de Kepler / por join / heurístico:**
- **Total Factura** del proveedor = externo → lo pone el **OCR** (el número de factura en el Excel era caótico: `S/N`, `0`, fechas).
- **Póliza (4 díg)** = contabilidad `kdc2YYMM` → JOIN (patrón `expense_doc_chain` de Maat).
- **Pago (X-D-26/25/60)** = NO referencia la entrada (`c37/c39` vacíos, monto agregado, `kdxrevcxp` vacío) → **match heurístico** proveedor+monto+fecha.

**Ajustes de compra = por qué Factura ≠ Compra (verificado con 3 PDFs + data, 2026-08-04):** el descuadre NO se adivina — Kepler lo registra en **dos doctypes**, ambos con **motivo en `c24`**, SKU+qty en `kdm2`, ref factura `c11`/`c28`, ligados a `XA2001`:
- **`X-D-40` "Devolución compra"** (132/2026, $563k) = **OPERACIONAL**: faltante ("FALTARON 2 CAJAS"), no-solicitado ("NO SE SOLICITÓ"), mal-estado, llegó-cambiada. Sin IVA. → explica el descuadre de recepción.
- **`X-D-55` "Nota crédito"** (1,154/2026, **$20.3M**) = **mayormente COMERCIAL**: descuento ("DESCUENTO 4%"), pronto pago ("1.8% PRONTO PAGO 45"), **apoyo de marca** ("GRANELES 10% APOYO", "APOYOS MKTD"), plan ("PLAN Q01"). Con IVA (`c82`). → los 3 tipos de descuento **con el tipo escrito en `c24`**.
- ⚠️ **El doctype NO es el clasificador** — hay X-D-55 operacionales (ej. "DESCONTAR DEVOLUCIÓN BOLSA MAL ESTADO"). **La causa se lee del `c24`** (keyword + Haiku), no del tipo de documento.
- **Descuento al PAGAR (`c84` del X-D-26):** además ~**7.41% estándar** se captura al pagar ($10.2M/2026), condicional al timing. Puede solaparse con las notas X-D-55 → reconciliar.
- El Excel capturó **45** de los **1,286** ajustes de Kepler → el sistema ve TODAS.

**Multi-fuente (crítico):** el feed hoy es **CEDIS `md_00` únicamente** (sucursal '00', 8,373). Las recepciones reales están en: CEDIS md_00 + **sucursales Kepler** (md_03/8Esq=833, md_01/PH=313 en 2026, mismo doctype) + **Wincaja** `movimiento_proveedores` (7,356 filas, con `fecha_vencimiento`+`saldo` nativos, para Morelia Abastos/Madero/Canindo). El almacén top del Excel = **Morelia Abastos 348 (Wincaja)** → hoy invisible.

Detalle verificado en memoria `reference_kepler_reception_flow`.

## 3. Estado actual (qué ya existe)

| Pieza | Estado |
|---|---|
| Espejo `analytics.erp_goods_receipts` (XA2001) + `_lines` | ✅ (solo md_00) |
| `/compras/entradas` + `finance.goods_receipt_proofs` (adjuntar + OCR + cuadre) | ✅ |
| Validación restringida `COMPRAS_VALIDAR` | ✅ |
| Búsqueda inteligente (unaccent+trgm) | ✅ |
| OCR `LlmExtractorService.extractRemision()` | ✅ |

## 4. Paridad con el Excel (los 23 campos → destino)

| Campo Excel | Destino digital | Fase |
|---|---|---|
| Fecha rec/factura, Almacén, Proveedor, Nº Factura | espejo (Kepler) + OCR (nº factura) | RE.0/RE.2 |
| Folio Aplicación entrada (K) | ancla XA2001 | ✅ |
| Folio OC (J), Vale (L) | `oc_folio`/`vale_folio` | ✅ |
| **Póliza 4 díg (S)** | join `kdc2` | RE.1 |
| **Total Factura vs Total Compra (G/H)** | OCR vs `c16` vs OC + **auto-explain `X-D-40`/`X-D-55`** | RE.2 |
| **Fecha Vence + Días vencidos** | `c18` + Wincaja `fecha_vencimiento` | RE.3 |
| Evidencias (4 links Drive) | Cloudinary + roles | RE.5 |
| **Devolución/NC (col P)** | import `X-D-40`+`X-D-55` (motivo `c24`) | RE.5/RE.2 |
| **Almacenes branch/Wincaja** | multi-fuente | **RE.0** |

## 5. Fases

### RE.0 — Multi-fuente [RUTA CRÍTICA] · ✅ COMPLETO (Kepler + Wincaja) 2026-08-10 (LOCAL + PROD)
- **Objetivo:** el feed cubre lo mismo que el Excel: CEDIS md_00 + sucursales Kepler md_01-05 + Wincaja. **Logrado.**
- **✅ Kepler multi-sucursal:** `import-goods-receipts.js` recorre las 6 DBs Kepler (mismo mapa de conexiones que `import-branch-stock-live`), con el **gotcha anti-réplica** confirmado en vivo (md_03 arrastraba **501 filas c1='02'** + 2 de '01'; md_02 traía 2 de '01') → se filtra `ap.c1 = <sucursal propia derivada del dbname md_XX>`. `sucursal` REAL ('00'..'05'), `source_branch`='md_XX'. **Sin migración** (`sucursal`/`source_branch` ya existían; PK `(tenant, sucursal, folio)` no colisiona: cada sucursal tiene código distinto). Δ Kepler: +2,809 recepciones / +$79.6M.
- **✅ Wincaja (RE.0-b):** `import-wincaja-receipts.js` — transform **newdb→newdb** (lee la landing `wincaja.movimiento_proveedores`, ya poblada por `import-wincaja.js`; **NO toca el .mdb ni la LAN**, corre hasta desde Railway). Solo tiendas **solo-Wincaja** = crosswalk `wincaja.branches` con `kepler_code IS NULL AND warehouse_code LIKE 'MD-%'` (excluye las que ya cubre Kepler y las RUTAS) → **30 Morelia Abastos, 32 Morelia Madero, 50 Canindo**. Tipos `CR` (crédito) + `CC` (contado) = recepción; `NP` ("Por Devolución") excluido. `dataset='actual'` (más fresco; no mezcla 'concentrada'). monto = valor+iva+ieps (total c/IVA, comparable a c16). proveedor: `tercero`→`wincaja.proveedores.nombre`. En el espejo: `sucursal`='30'/'32'/'50', `source_branch`='wincaja_XX', `doc_prefix`='WCJ-CR/CC'. **Sin migración** (reusa columnas; `source` diferido — el prefijo de `source_branch` ya distingue kepler/wincaja). Δ Wincaja: **+2,971 recepciones / +$133.5M** (Morelia Abastos sola 2,149/$79.6M = el almacén #1 del Excel, antes invisible).
- **✅ Mapeo código→nombre:** `compras360Filters()` devuelve `name` por sucursal (CEDIS Irapuato/Padre Hidalgo/La Piedad Abastos/8 Esquinas/Yurécuaro/Zamora Centro/Morelia Abastos/Morelia Madero/Canindo); Compras 360 muestra el nombre en el filtro y en la columna sucursal (code en `title`). Builds api+view OK.
- **Estado PROD (2026-08-10):** `analytics.erp_goods_receipts` = **9 sucursales / 14,377 recepciones / ~$654M** (antes 1 suc / 8,373 / $427M). Sin redeploy para la data; el **mapeo de nombres SÍ requiere redeploy** de api+view.
- **Notas operacionales:** el feed Kepler corre desde la **máquina de feeds** (LAN; Railway no alcanza las DBs de sucursal) con `DATABASE_URL_NEW=<prod>`; el feed Wincaja puede correr desde cualquier lado (newdb→newdb) pero depende de que `import-wincaja.js` haya corrido antes (ese sí desde LAN por el .mdb). **Pendiente:** agregar ambos a la rotación de feeds para frescura; `payments` sigue CEDIS-only (correcto, centralizado).

### RE.1 — Enriquecer el ancla (paridad de campos) · ✅ COMPLETO (LOCAL) 2026-08-31
- **Objetivo:** traer los campos del Excel que faltan.
- **Entregable:** `fecha_vence` (`c18`), `condicion_pago` (`c30`), `dias_credito`, `poliza` (join `kdc2`). En `erp_goods_receipts` + importer.
- **✅ Hecho (mig `20260831190000`):** las 3 primeras columnas se agregan **al final** de la vista viva con `CREATE OR REPLACE` (verificado que ninguna vista depende de ésta). Expuestas en la lista y en el detalle de `goods-receipt-proofs`, más `dias_para_vencer` calculado. Smoke `test-newdb-goods-receipts-vencimiento` en la regression. `tsc` api+view en 0.
- **Decode verificado contra 12,200 documentos, no supuesto:** `c18` poblada **12,200/12,200**; `c30` en 12,199; el vencimiento casa con el plazo declarado en **99.92%** (±3 días).
- **⚠️ Hallazgo de decode — "30 días" en Kepler es UN MES DE CALENDARIO, no 30 días.** La condición *"30 días fecha factura"* da **31** días en 711 documentos y **28** en 111: es el largo del mes de origen. Por eso `c18` **se guarda cruda y no se deriva del texto** — derivar `fecha + 30` habría inventado un vencimiento distinto al que el ERP y el proveedor tienen, en **822 documentos**.
- **Dato que dimensiona RE.3:** el **68%** (8,323/12,200) es *"Pago de contado"* → vence el mismo día y **no genera cuenta por pagar a plazo**. El aging corre sobre las ~3,874 restantes, no sobre las 12,200.
- **`dias_credito` puede ser negativo** (2 documentos con −1). Se deja crudo: es calidad de dato del ERP y clamparlo a 0 lo escondería.
- **⬜ Wincaja (30/32/50): mapeado pero SIN VERIFICAR.** `movimiento_proveedores.fecha_vencimiento` existe en el esquema, pero la tabla está **vacía en local** (0 filas) → cobertura y formato sin comprobar. `condicion_pago` va NULL a propósito: Wincaja no tiene equivalente y poner "contado" sería inventarlo.
- **⬜ La póliza NO entró a la vista.** `analytics.gl_polizas` está **vacía en local** (join inverificable); `polizaForReceipt` ya la sirve bajo demanda para el detalle; y una subconsulta correlacionada correría **12,200 veces** en el listado para un dato que sólo se mira al abrir un documento. Si se quiere en la lista, va como agregado, no como join.
- **Reuso:** `expense_doc_chain` para la póliza.

### RE.2 — Cuadre 3-vías + AUTO-explicación del descuadre
- **Objetivo:** automatizar el control G-vs-H (41% descuadre; typo $183M) **y explicar el porqué** desde el dato, no solo pintar rojo.
- **Entregable:** (a) OCR factura → compara **factura vs entrada (`c16`) vs OC** → `discrepancy_amount`; (b) **auto-explicación**: jalar los `X-D-40`+`X-D-55` ligados a la entrada (por factura `c11`/proveedor) y clasificar `c24` → `discrepancy_kind` ∈ {faltante, no_solicitado, mal_estado, cambiada, descuento_comercial, pronto_pago, apoyo_marca, typo, iva}; (c) reglas para **typo** (Δ>70%) e **IVA** (Δ≤2% / ratio ≈1.16); chip/semáforo + motivo en UI.
- **Clasificación `c24`:** keyword primero, **Haiku** para los tersos (~$13.2M "sin clasificar"); mismo patrón que Maat.
- **✅ Backend auto-explain (2026-08-05):** endpoint `/commercial/purchase-adjustments/for-entrada` — link exacto por `entrada_folio` (~12/132) o heurístico proveedor+ventana; cada match etiquetado `exacto`|`proveedor+fecha`. Verificado (Mondelez 2026-06-29 → "faltó 1 caja de…"). Commit `0cb4666c`.
- **✅ Integración UI (2026-08-05):** en el diálogo de detalle de `/compras/entradas` — sección **"¿Por qué no cuadra? — ajustes del proveedor"**: al abrir una entrada carga `adjustmentsForEntrada({ proveedor_code, entrada_folio, date, ±15d })` y lista devoluciones/notas de crédito con doctype + folio + motivo + grupo (Descuento-apoyo / Operativo / Error de captura) + badge `exacto`/`≈ prov+fecha` + monto. Empty-state honesto ("la diferencia suele ser IVA o captura"). Build view OK. Commit `e1dae914`. **Falta:** reglas typo(Δ>70%)/IVA(≤2%) sobre la remisión OCR + persistir `discrepancy_kind`; **QA visual** (Edgar).
- **Reuso:** OCR `extractRemision`, cuadre actual, `LlmExtractorService`, espejo `erp_purchase_adjustments`.

### RE.3 — CxP / vencimientos (aging + worklist) · 🔨 PARCIAL (LOCAL) 2026-08-31 — **recortado a propósito**
- **Objetivo:** lo que el Excel tenía roto.
- **Entregable:** aging buckets (por vencer / vencidas) sobre `c18` + Wincaja `fecha_vencimiento`/`saldo`; worklist "por pagar esta semana"; tab/página. Días vencidos calculado bien (nunca −46,238).
- **⛔ El "aging de cuentas por pagar" NO se puede construir hoy, y el orden del plan está invertido.** RE.3 depende de RE.8, no al revés: **no existe la liga recepción→pago**. `analytics.erp_supplier_payments` (4,436 pagos) **no trae folio de entrada**, y `analytics.expense_doc_chain` —que sí lo tendría— está **vacía**. Sin eso no hay forma de saber qué ya se pagó.
- **El número que lo prueba:** **10,940** recepciones tienen vencimiento pasado, por **$507.8M**. Casi todo está pagado (los datos arrancan en ago-2024). Una pantalla de "CxP" publicaría esos $507M como deuda vencida.
- **✅ Lo que sí se entregó — `GET /finance/goods-receipts/aging` + página `/compras/vencimientos` ("Qué vence"):** sólo **lo que todavía no vence**, donde la pregunta *"¿ya se pagó?"* casi no aplica. Ventana configurable 7/30/90d, buckets hoy · semana · ventana, respeta alcance por sucursal, excluye descartadas y **excluye gemelas** (`dup_of_folio`) — pagar dos veces la misma compra es el riesgo. Medido: **289 órdenes / $24.8M** en 30 días.
- **Lo vencido se DECLARA, no se lista.** 1,023 órdenes de los últimos 30 días aparecen como un número con su explicación (*"no sabemos cuáles siguen sin pagarse"*), sin tabla. Listarlas mandaría a perseguir facturas mayormente pagadas: eso es daño operativo, no una funcionalidad incompleta.
- ✅ Smoke `test-newdb-goods-receipts-aging` en la regression — afirma sobre todo **lo que no debe pasar**: que no se publique el histórico, que no se cuele un vencido en la lista, que lo declarado esté acotado a 30 días y que las gemelas queden fuera. `tsc` api+view en 0.
- **⬜ Falta (bloqueado por RE.8):** abrir lo vencido de verdad, el saldo nativo de Wincaja (tabla vacía en local) y el worklist accionable "pagar esta semana" con estado.
- **Reuso:** `c18` (limpio), Wincaja saldo nativo.

### RE.4 — Bandeja de excepciones + alertas
- **Objetivo:** de log pasivo a motor proactivo.
- **Entregable:** scanner `@Cron` → `finance.findings` (sin evidencia / descuadre>umbral / por vencer / sin validar) + push WS al responsable.
- **Reuso:** patrón detectores Maat + `FINANCE_NOTIFIER_PORT`.

### RE.5 — Evidencia con roles + Devolución/NC
- **Entregable:** roles tipados (remisión / factura sellada / vale firmado / póliza / NC) + **importar los `X-D-40`/`X-D-55` de Kepler ligados a la recepción** (monto + motivo `c24` + SKU) — el Excel adjuntaba el PDF a mano; aquí llega del ERP (1,286 vs 45). Adjunto manual queda como complemento. Cloudinary (adiós links Drive muertos).
- **✅ Multi-foto con roles (2026-08-10):** el diálogo "Adjuntar" de `/compras/entradas` ahora acepta **varias fotos** (lo normal 3–4: remisión/factura + vale de recepción firmado + Aplica Orden Entrada + ticket de compra), no una sola. Cada foto lleva un **rol** editable (`RECEIPT_FILE_ROLES` = remision/factura/vale/orden_entrada/ticket/evidencia; `evidencia_1` back-compat) y se marca con **★** cuál se lee con OCR. Cada archivo sube a Cloudinary en paralelo (estado por foto + reintento); `saveAttach` usa `forkJoin` y adjunta **todas en UNA evidencia** (`finance.goods_receipt_proofs.files[]`, que ya era array). Sin migración (backend ya aceptaba `files[]`; solo se ampliaron los roles permitidos).
- **✅ Foto-primero + auto-enlace (2026-08-10, como Cobranza):** botón **"Adjuntar por foto"** — subís las fotos SIN preseleccionar entrada; la **1ª foto = Aplica Orden Entrada** (★, se lee con OCR), su **folio** (0008625) **enlaza** contra `erp_goods_receipts`. Backend `GET /finance/goods-receipts/match` (`matchByOcr`): **FOLIO primero** (tolerante a ceros "8625"="0008625", evita falso positivo por monto), **MONTO ±$2 solo como fallback** si el OCR no leyó folio, y **búsqueda manual** (proveedor/folio/OC) si no reconoce. 1 match → auto-selecciona; varias → el usuario elige; 0 → busca manual. Verificado prod: OCR folio 8625 → **1 match exacto** BOLSAS DE LOS ALTOS $32,900.15. **Requiere redeploy.**
- **⚠ Frescura + DQ (2026-08-10):** el feed de entradas Kepler no es real-time (la 0008625 del día no estaba hasta re-correr `import-goods-receipts.js`; falta agendarlo en la rotación). Y hay **fechas de captura atípicas** en Kepler (una entrada CEDIS con `receipt_date`=Dic-29-2026 flota arriba del listado ordenado por fecha desc) → considerar clamp/orden por folio.
- **Falta:** importar los X-D-40/55 del ERP (parte NC) + `role`/`credit_note_ref` en el schema. Requiere redeploy.

### RE.6 — Trazabilidad de cadena (timeline)
- **Entregable:** OC→vale→orden entrada→aplicación→póliza→**pago (heurístico)** en el detalle.
- **Reuso:** `expense_doc_chain`.

### RE.7 — Dashboard / KPIs + compliance/SLA
- **Entregable:** recepciones por día/almacén/proveedor, **%evidencia, %validadas, $descuadre, aging CxP, SLA captura→validación**. Export XLSX/PDF (patrón SellOutExport).

### RE.8 — Enlace a pago (heurístico)
- **Entregable:** match proveedor+monto+ventana → marca "pagada (aprox)" + link a `erp_supplier_payments`. **Etiquetado honesto** (aproximado, no 1:1).

### RE.9 — Migración histórico Excel (opcional)
- **Entregable:** importar las ~910 filas (match por folio K contra XA2001; evidencias Drive→Cloudinary; sanea `S/N`/`0`/año 2025).

### RE.10 — Descuentos y apoyos (pronto pago / comercial / apoyo de marca) [nuevo · alto valor]
- **Objetivo:** visibilizar y clasificar el descuento de proveedor — **$20.9M en notas `X-D-40/55` + $10.2M en pagos `c84`** (2026), hoy invisibles.
- **✅ Base construida (2026-08-05):** migración `analytics.erp_purchase_adjustments` + importer `import-purchase-adjustments.js` con clasificador `c24` (**aplicada + poblada en newdb local, 1,286 filas, idempotente**) + **backend** `purchase-adjustments` (service+controller `summary`/`list`/`by-supplier`, `COMPRAS_VER`, en módulo Compras, build OK). `/summary by_grupo` = comercial $8.29M · error/duplicadas $6.94M · sin_clasificar $5.04M · operacional $645k. Dry-run vs Kepler md_00: **1,286 ajustes / $20.9M**, breakdown verificado:
  - **Comercial ≈ $8.2M** (descuento $6.4M + apoyo de marca $1.05M + pronto pago $718k).
  - **Facturas duplicadas $6.74M** ⚠️ = error de captura, **NO descuento** → control aparte.
  - Sin motivo $4.0M (c24 en blanco → Haiku/manual) · operacional/otro ~$1.8M. El "otro" bajó de $9.18M a $924k.
- **✅ Frontend (2026-08-05):** página `/compras/descuentos` (Operations: KPIs por grupo + filtros grupo/doctype/search + tabla + panel top proveedores) + ruta lazy + nav (`COMPRAS_VER`). Build view OK. → **vertical completo LOCAL: data → backend → frontend.**
- **✅ Detector de duplicadas (2026-08-05):** endpoint `/duplicates` + vista "Posibles duplicados" en `/compras/descuentos` (mismo proveedor + monto exacto repetido ≤N días → posible captura doble; verificado **176 grupos / $4.3M** en riesgo, ventana 30d). Build api+view OK. Commit `df420698`.
- **✅ Duplicadas → bandeja de hallazgos (2026-08-05):** `PurchaseAdjustmentsFindingsBridgeService` empuja los duplicados a la bandeja unificada de Maat (`finance.findings`) vía `FINANCE_FINDINGS_SINK_PORT` (`@Optional`, best-effort, mismo patrón que el bridge fiscal). Regla `compra_factura_duplicada` (clase `riesgo`, severity por monto), **idempotente por `dedup_key`**, respeta auto-supresión L2. `@Cron` nocturno (gate `ENABLE_DUP_FINDINGS_SCAN`) + endpoint `POST /commercial/purchase-adjustments/sync-findings` (`COMPRAS_GESTIONAR`). **Sin migración nueva** (reusa `finance.findings`; la regla se auto-registra al primer sync). Smoke `test-newdb-purchase-adjustments-findings` **6/6** (172 hallazgos/$4.32M, idempotente, dedup único) en la regression suite. Build api OK. Commit `6d386556`. → los $4.3M de riesgo de doble pago aparecen en `/finanzas/hallazgos` con triage.
- **✅ Descuento 2 canales (pago c84 + nota) — reconciliación (2026-08-05):** verificado contra Kepler que el descuento de proveedor vive en **DOS canales**: (a) capturado **al pagar** = `kdm1.c84` (pronto pago, sobre el monto pagado; 2026: **1,742 pagos / 43% / $12.6M**, 69.8% exactamente 7.41% tarifa de la casa; De la Rosa 7.3–7.4%, Mondelez 3.95%), (b) vía **nota de crédito** X-D-55 comercial ($8.17M). `c81≈c82` = par contable, NO descuento aparte. Mig `20260805140000` (columna `analytics.erp_supplier_payments.descuento`, aditiva idempotente) + importer `import-supplier-payments.js` lee `c84`. Endpoint `GET /commercial/purchase-adjustments/discount-reconciliation`: por proveedor descuento canal PAGO vs NOTA + total + % vs compras + `canal` (pago/nota/**ambos**); "ambos" = posible solapamiento del mismo descuento (HITL). Smoke `test-newdb-supplier-discount-recon` **6/6**: **$20.78M total** (pago $12.61M + nota $8.17M), **64 proveedores usan ambos canales** (top De la Rosa $3.62M = 6.4% de compras). Build api OK. Commit `49a1902a`.
- **✅ Detector "descuento NO capturado" + UI (2026-08-05):** `commercial.supplier_discount_policy` poblada por `import-supplier-discount-policy.js` (tasa OBSERVADA = mediana del rate capturado por proveedor, ≥2 pagos → 147 políticas). `discountLeakage` cruza pagos `c84=0` de proveedores con política → fuga = tasa × monto pagado completo; el bridge de hallazgos empuja `descuento_no_capturado` (clase **oportunidad**) junto a las duplicadas en el mismo sync/cron. Endpoint `GET /discount-leakage`. Smoke `test-newdb-discount-leakage` **6/6**: **$5.1M dejado en la mesa** (117 proveedores; top De la Rosa 31/104 pagos sin descuento = $1.04M), 98 hallazgos, idempotente. **UI (2026-08-05):** `/compras/descuentos` +2 vistas — **Reconciliación** (pago vs nota + canal pago/nota/ambos + %compras) y **Descuento no capturado** (fuga por proveedor). `/compras/entradas` muestra el `discrepancy_kind` en el detalle de la remisión. Build view OK. Commits `a6a9d1ae` (backend) + `2cff45b7` (UI).
- **✅ Tail clasificado (Haiku + doctype) — 2026-08-05:** columna `categoria_source` (`keyword`|`llm`|`doctype_default`, mig `20260805200000`) + el importer **preserva** el enriquecimiento al re-importar (CASE + WHERE sin `categoria`). Script `classify-adjustments-llm.js`: (1) Haiku clasifica los `otro` con texto → **132/147 motivos** (diferencia_monto $339k, descuento $318k, apoyo $145k…); (2) default por doctype para X-D-55 en blanco → comercial ($4.02M) y X-D-40 → devolución. **Tail sin clasificar $5.04M → $90k (−98%)**. Re-import preservación verificada (llm=140/doctype_default=310 intactos). Commit `5b004870`. Efecto: el grupo comercial sube a ~$10.7M (el $4M de X-D-55 antes invisible ahora reconocido). **Solo local; falta correr en prod (cambia los números del resumen).**
- **Falta (prod/next):** aplicar migración + importer en Railway/LAN + redeploy api/view + **QA visual** (`/compras/descuentos` + sección auto-explain en `/compras/entradas`) · importar `c84` del pago · reconciliación notas vs `c84` (solapamiento) · Haiku para el tail sin-motivo · persistir duplicadas a `finance.findings` (bandeja + cron) · reglas typo/IVA + persistir `discrepancy_kind`.
- **Hallazgo:** **$6.74M/año de facturas duplicadas** revertidas por NC → detector de control (patrón Maat).
- **Reuso:** `LlmExtractorService` (Haiku), detectores Maat, `erp_supplier_payments`.

#### Runbook de despliegue RE.10 + RE.2 (prod) — track operacional (Edgar)

> Sin permisos nuevos (RE.10/RE.2 reusan `COMPRAS_VER`) → **no requiere re-login**. Migración aditiva/idempotente.

1. **Migraciones** (newdb Railway, `npm run migrate:new` con `DATABASE_URL_NEW=<prod>`): `20260805120000` (tabla ajustes) + `20260805140000` (`descuento` en pagos) + `20260805160000` (RE.2: `discrepancy_kind`/`_amount`) + `20260805170000` (tabla política de descuento) + `20260805200000` (`categoria_source` en ajustes). Todas aditivas/idempotentes.
2. **Importers** (`DATABASE_URL_NEW=<prod>`): (a) desde LAN (Railway no alcanza Kepler): `import-purchase-adjustments.js --apply` (~1,287/$20.9M, `ADJ_SRC` md_00); `import-supplier-payments.js --apply` (backfill `c84`: ~1,742/$12.6M). (b) **computados (leen solo la newdb)**: `import-supplier-discount-policy.js --apply` (147 políticas) + `classify-adjustments-llm.js --apply` (tail: Haiku para `otro` + default doctype; usa `ANTHROPIC_API_KEY`; corre desde LAN por la key) — ambos DESPUÉS de (a).
3. **Redeploy** api + view (push de los commits locales `3e49be9a`·`93c6e55c`·`beb1b3ae`·`c15b64f6`·`df420698`·`0cb4666c`·`e1dae914`·`6d386556`·`49a1902a` + docs). El bridge de duplicadas→hallazgos **no lleva migración** (reusa `finance.findings`; la regla se auto-registra).
4. **Poblar hallazgos** (una vez): `POST /commercial/purchase-adjustments/sync-findings` (o esperar el `@Cron` 00:30 MX) → **duplicadas** (~$4.3M riesgo) + **descuento no capturado** (~$5.1M oportunidad) aparecen en `/finanzas/hallazgos`. (Requiere el importer de política ya corrido para la parte de fuga.)
5. **QA visual**: `/compras/descuentos` (4 vistas: Ajustes · Duplicados · **Reconciliación** · **Descuento no capturado**) + `/compras/entradas` → abrir una entrada de un proveedor grande (Mondelez/Canel) → sección **"¿Por qué no cuadra?"** + el tag `discrepancy_kind` en el detalle de la remisión + `/finanzas/hallazgos` reglas `compra_factura_duplicada` / `descuento_no_capturado`.

## 6. Schema nuevo (consolidado)
- `analytics.erp_goods_receipts`: `+ source, fecha_vence, condicion_pago, dias_credito, poliza, total_factura, total_compra`. Sucursal real (RE.0).
- `finance.goods_receipt_proofs`: `+ discrepancy_kind (CHECK), discrepancy_amount` ✅ mig `20260805160000` (RE.2 — persiste el veredicto del auto-explain). Pendiente aún: `role, credit_note_ref`.
- **Nueva `commercial.supplier_discount_policy`** ✅ mig `20260805170000` (RLS forzado): `(tenant_id, proveedor_code)`, `expected_discount_rate, discount_days, discount_type (CHECK), source (kepler/observed/manual), active` + audit. Base del detector "descuento no capturado" (RE.10).
- **Nuevo espejo `analytics.erp_purchase_adjustments`** (X-D-40 + X-D-55): `doctype, folio, entrada_ref (XA2001), factura_ref (c11), proveedor, sku, qty, monto, iva, motivo (c24), categoria`. Alimenta RE.2 (auto-explain) y RE.10 (descuentos/apoyos).
- `analytics.erp_supplier_payments`: `+ descuento` (kdm1.c84 — pronto pago capturado al pagar). Segundo canal de descuento; alimenta la reconciliación pago-vs-nota (RE.10).
- Reusar `finance.findings` (bandeja) — sin tabla nueva.

## 7. Qué reusamos (feasibilidad alta)
OCR `LlmExtractorService`, `expense_doc_chain` (Maat), `finance.findings`+scanner, `erp_supplier_payments` (enlace a pago), smart-search, Cloudinary, `FINANCE_NOTIFIER_PORT`, permisos `COMPRAS_VER/GESTIONAR/VALIDAR` ya listos, `STOCK_BRANCH_MAP` + feeds Wincaja.

## 8. Decisiones abiertas
- **MVP:** RE.0 → RE.1 → RE.2 (**con auto-explicación X-D-40/X-D-55**) → RE.3. Supera al Excel en sus dos controles centrales. RE.4 (alertas) = siguiente golpe de efecto.
- **RE.10 (descuentos/apoyos):** $20.3M+$10.2M hoy invisibles — ¿entra al MVP o va después? (dinero grande, pero es análisis, no control de recepción).
- **Clasificación `c24`:** keyword vs Haiku — arrancar keyword, Haiku para el ~$13.2M terso.
- **Histórico (RE.9):** ¿migrar las 910 filas o arrancar limpio desde hoy?
- **ADR-041:** aceptar el enfoque read-only multi-fuente + pago heurístico + **ajustes `X-D-40`/`X-D-55` clasificados por `c24`**.
- **[RE.23] Alcance de quien captura Morelia:** el defecto de código está cerrado (la dimensión `warehouse` ya sabe nombrar `30`/`32`), pero falta la decisión de datos — **acotar a `janette_garcia` de `all` a `listed ['30','32']`** desde `/admin/usuarios`. Es *restringir* a una persona, así que lo decide Edgar. Vale para los otros 73 con `all` heredado de `[ID.3]`: la regla trae la nota *"Candidato a recortar"* y nadie la ha recortado.
- **`zone_id` NULL en los almacenes de Morelia:** asignarle la sucursal a alguien no le deriva la zona (el alta la toma de `warehouses.zone_id`). La zona *"MORELIA ABASTOS"* existe y tiene 9 usuarios; el almacén no la apunta. ¿Se liga?

## 9. Riesgos / notas
- **Pago heurístico** (no estructural) — comunicar como "match aproximado", no trazabilidad exacta.
- **LAN**: los feeds de sucursales Kepler (md_01-05) y Wincaja corren desde la máquina de feeds (Railway no alcanza la LAN) — igual que los demás importers.
- **Póliza** por join a contabilidad — verificar el enlace doc→póliza en `kdc2` en RE.1.
- **Data quality del histórico** (RE.9) — normalizar en la migración, no arrastrar el caos.
