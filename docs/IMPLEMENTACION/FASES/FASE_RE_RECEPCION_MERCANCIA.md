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

### RE.30–RE.34 — Obligaciones: la entrega de Compras a Finanzas · 🔨 RE.30–RE.32 EN CÓDIGO 2026-09-29

**El flujo real (Francisco, 2026-09-29):** Compras recibe (requisición → OC → vale → orden → aplicación), arma el expediente y le **entrega a Finanzas** lo recibido con el compromiso de cada documento; Finanzas paga al vencimiento y **regresa** el pagado al archivo del proveedor. Roles: jefe de compras, analista de catálogo, analista de entradas (corporativo, audita costos y expediente virtualmente) y staff de zona en Morelia/Zamora/La Piedad (recibe, valida inventario y envía la documentación física). **El plazo lo negocian el comprador o dirección; cuando una factura llega con plazo adicional, quien la extiende es el auxiliar de compras** → dos llaves: `COMPRAS_PLAZOS_AUTORIZAR` (negociar el plazo del proveedor) ≠ `COMPRAS_OBLIGACIONES_GESTIONAR` (operar y extender una factura).

**Dos fechas por recepción:** factura (Kepler, `c9` — que la vista llama `receipt_date`, **nombre equivocado**) y recepción física (**no existe en Kepler**: medido, el 89% de la cadena comparte una sola fecha → la captura la zona). **Plazo por proveedor** en días exactos + base factura/recepción; Kepler (`c30`/`c18`) queda como comparación porque su "contado" es plazo no capturado.

| Item | Qué | Estado |
|---|---|---|
| RE.30 | Plazo por proveedor (días + base + interno) en `catalog.suppliers` + historial; pestaña en `/compras/obligaciones`; reparte `COMPRAS_OBLIGACIONES_*` (estaban en 0 roles) + `COMPRAS_PLAZOS_AUTORIZAR` | 🔨 código, sin migrar |
| RE.31 | Fecha de recepción = **captura del vale de entrada en Kepler** (`kdm1.c68/c69/c67`), en `analytics.erp_goods_receipts.fecha_recepcion`. Árbitro: 417 fotos de `/compras/entradas`, 0 anteriores a la captura. La captura manual por la zona deja de hacer falta para Kepler (Wincaja pendiente) | 🔨 código, sin migrar |
| RE.32 | Entrega a Finanzas: pendientes por fecha (recepción/factura) con brinco por sucursal y proveedor A-Z, check del auxiliar (constancia, no bloquea por evidencia), folio `ENT-YYYY-NNNNN`, quién entrega / quién recibe (Finanzas, derivado), PDF con firmas, Finanzas confirma y rechaza **por renglón** | 🔨 código, sin migrar |
| RE.33 | Al confirmar Finanzas nace la obligación en el Calendario con el vencimiento del plazo (RE.30); regreso: fecha de pago, NC descontadas, días recepción→pago y vs vencimiento (liga EXACTA hacia adelante; lo histórico sigue heurístico RE.8) | ⬜ |
| RE.34 | Extensión de plazo POR FACTURA: la registra el auxiliar (`negotiated_date` ya existe) con **quién la negoció** (comprador/dirección) + motivo; no cambia el plazo del proveedor | ⬜ |

### RE.35–RE.41 — El expediente de la factura: lo que cuadra pasa solo, y lo que no, enseña · 🔨 RE.35–RE.35.5 EN CÓDIGO 2026-10-06 (en PR) · RE.36–RE.41 ⬜ diseñado (ADR-085)

**El proceso real (Francisco, 2026-10-06).** El **auxiliar de entradas** de Compras valida cada entrada en `/compras/costo-por-compra` (la misma pantalla que `/compras/entradas`, lente del dinero): factura, orden de compra, fecha, RFC, método de pago y que la entrada cuadre con la factura del proveedor. Con el expediente armado se lo **entrega en un listado a Finanzas** (RE.32), que programa y paga, y regresa al archivo del proveedor. Hoy RE.32 lee las mismas entradas que costo-por-compra (llave `sucursal + folio XA2001`), pero su check de entrega **no está atado** a la validación.

**Qué revisa el auxiliar, por tipo de documento (Francisco):**
- **Remisión:** que cuadre con la entrada, la orden de compra y la fecha de recepción.
- **Factura:** lo mismo **más** RFC del emisor, nombre del emisor, RFC del receptor, régimen fiscal, uso CFDI, forma de pago y método de pago.

**Fuente de los datos fiscales: `fiscal.cfdis`** (los CFDI recibidos que sincroniza ContPAQi, Fase LC), **no el OCR**. El OCR acierta el RFC en el 49% (RE.25) y no lee régimen, uso ni forma; el CFDI los trae del XML timbrado. ⛔ **Kepler no guarda el UUID** (medido en `[GX.40]`), así que la liga exacta entrada → CFDI sale del **papel**: el UUID impreso en la factura.

**¿La entrada ya está ligada a su CFDI? No — medido 2026-10-06 (prod, sólo lectura):**
- **Kepler:** 3,000 órdenes XA2001 recientes, ninguna columna de `kdm1` con forma de UUID. `kdfe33docprv` («documentos de proveedor», 5,595 filas) **no es de compras**: liga tickets de venta `U-D-10` con su factura de venta `U-D-5`.
- **Costo por compra:** el auxiliar ya sube **588 PDF de factura** desde el 4-ago (sólo PDF: la pantalla acepta `application/pdf`), pero el OCR lee folio, RFC y totales; **el UUID no se guarda**. Validados: 8.
- **`fiscal.cfdi_assignments`** (MAT.1, la tabla hecha justo para CFDI ↔ XA2001): **0 filas**.
- **ContPAQi** (`aso_contabilidad`): asocia el CFDI a una **póliza**, no a una entrada, y va a la baja: 85% de las facturas `G01` en may–jun, 19% en septiembre.

→ **Intención (Francisco, 2026-10-06):** al subir el **papel físico que entrega el repartidor** (escaneado o foto), el sistema lo liga solo a los CFDI que trae ContPAQi, para **identificar más rápido**. Un escaneo normalmente no trae texto, así que la llave tiene que salir de lo que toda factura trae impreso:
1. **El código QR del SAT** (obligatorio en la representación impresa): trae UUID, RFC emisor, RFC receptor y total. Se decodifica de forma determinista → liga **exacta**. ⚠️ **Sin medir** (hay que probarlo sobre los archivos, que viven en el almacenamiento de objetos).
2. **Si no hay QR legible, el OCR** (el que ya corre) lee además UUID, serie y folio. Un UUID mal leído se corrige contra los existentes (≤3 caracteres distintos y candidato único).
3. **Si no hay UUID:** RFC (del OCR o el aprendido del proveedor) + folio o total → candidato **sugerido** que confirma una persona.
4. **Al revés también:** desde la factura identificada se proponen las entradas que cubre (mismo emisor, total, fecha), que es lo que acelera la búsqueda en «Subir factura».

📏 **Medido sobre los 588 comprobantes de factura ya subidos (lecturas del OCR actual, sin QR):**
| Llave | Encuentra su CFDI único |
|---|---|
| UUID leído y existente | 35 (6.0%) · se leyó en 70; **22 más** se recuperan corrigiendo ≤3 caracteres, 0 ambiguos |
| RFC + folio | 98 (16.7%) |
| Folio + total | 216 (36.7%) |
| Total + fecha ±3 d | 259 (44.0%) |
| RFC (OCR o Kepler) + folio o importe de la entrada | 233 (39.6%) |
| **Cualquiera** | **322 (54.8%)** |

**Por qué fallan las 266 restantes:** **141 sin RFC** (ni el OCR ni Kepler lo traen → lo resuelven el QR o el RFC aprendido del proveedor) · **66 de emisores sin ningún CFDI en ContPAQi** (remisión subida como factura, o proveedor que no se sincroniza → se declara, no se liga) · 36 el emisor sí factura pero no cuadra folio ni total · 16 hoja ilegible · 6 ambiguas · 1 sin folio ni total. Techo estimado con QR + RFC aprendido: **~80%**, a confirmar midiendo el QR.

La liga se guarda en **`fiscal.cfdi_assignments`** (MAT.1, existe y está vacía): no se crea otra tabla.

**Regla de fuentes (Francisco, 2026-10-06): el papel identifica, el CFDI informa.** Del papel del repartidor sólo se leen las **llaves** para encontrar la factura (QR, UUID, serie/folio, RFC, total). **Todo dato fiscalmente sensible se muestra y se valida desde el CFDI que sincroniza ContPAQi, nunca desde el OCR.** Medido en las 1,821 facturas `G01` de jul–oct 2026: ContPAQi trae al **100%** UUID, fecha de timbrado, RFC/nombre/régimen del emisor, RFC/régimen/uso del receptor, subtotal, descuento, total, moneda y tipo de cambio, método y forma de pago, lugar de expedición, retenciones e **impuestos desglosados por tasa** (IVA 0/16, IEPS 8…, con sus bases). Trae parcial los conceptos (17.4%) y **no trae el estatus de cancelación (0%)** → se declara «sin verificar».

**Señales fiscales extra que el expediente puede marcar con ese dato** (facturas `G01` de 2026, 5,458):
| Señal | Facturas | Efecto propuesto |
|---|---|---|
| Emisor en lista 69-B del SAT (EFOS) | 0 | Bloquea: no pasa sola nunca |
| Emisor en lista 69 (créditos firmes / cancelados) | 89 (2 emisores, $196k) | Aviso, no bloquea |
| **IEPS por cuota** | 22 | Aviso a contabilidad: se acredita, no se va al costo (hallazgo de la Fase LC) |
| Moneda distinta de MXN | 3 | Revisar (tipo de cambio) |
| Con retenciones | 1 | Revisar (no es normal en mercancía) |
| Con descuento | 1,717 (31%) | Sólo informa; cuenta para el cuadre contra la entrada |

#### Los valores esperados — medidos, no supuestos

Prod en sólo lectura, 2026-10-06: facturas recibidas de 2026 y entradas Kepler de jul–sep 2026 (3,195 entradas, $158.5M).

| Check | Esperado | Evidencia |
|---|---|---|
| F1 RFC receptor | `LOGL851014AQ5` | 11,227 de 11,227 facturas recibidas de 2026 |
| F2 Régimen receptor | `612` | 100% en mercancía; los 63 `606` son gastos `G03` ($5.3M) |
| F3 Uso CFDI | `G01` | 100% de las ligadas a una entrada; en proveedores de mercancía 2,813 `G01` contra 57 de otro uso |
| F4 Régimen emisor | Coherente con el tipo de persona (RFC de 12 → `601`/`603`/`620`/`626`…; de 13 → `612`/`621`/`626`…) **y** ya usado antes por ese emisor (≥10% de su historia) | 206 de 209 emisores con un solo régimen; el que alterna (`612`/`621`) es legítimo |
| F5 Método ↔ forma | PPD → `99`; PUE → nunca `99` (regla del SAT) | PPD sin `99`: **0**. PUE con `99`: **9 facturas, $1.9M** en 2026 |
| F6 Método | El habitual del emisor (si ≥90% de su historia es uno); sin historia, PPD | 95% PPD; 152 emisores siempre PPD, 23 siempre PUE, 34 mixtos |
| F7 Nombre emisor | Igual al de Kepler **o** al que ese RFC usa siempre en sus CFDI (el 4.0 no trae «SA DE CV») | Las fallas eran tecleo en Kepler: `LUCHETTI`/`LUCCHETTI`, `ALCARRUZZ`/`ALCARUZZ` |
| F8 Estatus | No cancelada | ⚠️ las 13,142 que llegan de ContPAQi tienen `estatus_sat = desconocido` → se **declara** «sin verificar», no «vigente» |

⛔ **Dos fuentes que NO sirven de esperado:**
- **La condición de pago de Kepler:** 120 de 138 entradas «Pago de contado» llegaron con factura **PPD**.
- **El plazo de RE.30:** 0 proveedores con plazo confirmado entre los ligados.

⛔ **El RFC de Kepler no es identidad:** 1,366 entradas (43%) sin RFC y ~555 (17%) con error de captura (`BALO20930EL9` por `BAL020930EL9`, `NAL73213BKA`, `PTE120913`). El RFC correcto por proveedor **se aprende** de las ligas confirmadas; `catalog.suppliers` no tiene columna de RFC.

#### La regla de auto-aprobación v1 (decisiones de Francisco, 2026-10-06)

Una entrada con factura **pasa sola** si cumple **F1–F8**, **tiene OC**, **tiene fecha de recepción** y **cuadra**: la diferencia factura − entrada es **menor al 0.25% Y menor a $200**. Una remisión pasa con OC + fecha + cuadre.
- **Sin OC no hay excepción.** No es omisión tolerable: cae al auxiliar y deja **trazabilidad de quién capturó sin OC**.
- **Fuera de alcance:** las entradas cuyo proveedor es la propia empresa (146 en el trimestre, $2M).

**Cobertura medida de la v1** (emparejamiento aproximado por importe, porque hoy no hay UUID):

| Entradas con factura (1,823) | n | % |
|---|---|---|
| **Pasan solas** | **1,022** | **56.1%** (68.7% de las emparejadas) |
| Caen por cuadre | 270 | 14.8% |
| Caen por falta de OC | 195 | 10.7% |
| No se emparejan 1 a 1 (una factura cubre varias entradas: Bolsas de los Altos, 123 entradas / 29 facturas) | 335 | 18.4% |
| Caen por lo fiscal (F1–F8) | 1 | — |

- **Las notas de crédito explican poco:** de 327 fuera de tolerancia, sólo **53** con explicación coherente (factura mayor + NC: 41 del SAT, 10 de Kepler; factura menor + devolución XD40: 2). Quedan ~233 diferencias de precio reales: **136 por arriba (+$419k)** y **97 por abajo (−$266k)**.
- **Sin OC, concentrado:** 437 entradas (13.7%); un solo usuario de captura de Kepler (`USR-A`; el código real vive en la base, no se publica en el repo) captura **221 (~$10M)**: 60% de las suyas en el CEDIS y 80% en la `08`. ⚠️ Kepler registra quién **capturó**, no quién **pidió**.
- **Meta de arranque: 60–70% automático** (con el UUID del PDF/XML resolviendo la factura que cubre varias entradas). El 90% no se busca abriendo la tolerancia ni la OC.
- **Límites declarados:** sólo Kepler (Wincaja fuera), un trimestre, emparejamiento por importe, y las NC de Kepler sólo traen la sucursal `00`.

#### RE.35.6 — El CFDI manda sobre el OCR (Francisco, 2026-10-06)

Cuando el OCR pifia el total del papel pero el CFDI de ContPAQi está ligado de forma **exacta** y cuadra con Kepler (`E1_cuadre` ok, vía factura), la entrada **va para adelante**: aviso verde en el panel, chip de la fila según el expediente y **Aprobar N** la acepta (`validateBulk`, tercera puerta `cubo = auto`). La lectura del OCR se muestra tachada como descartada. El OCR sigue sirviendo para **identificar** (UUID, folio, RFC); no es árbitro del importe. Una liga sugerida (no exacta) **no** manda.

#### RE.35.7 — Archivar varias facturas a la vez: el papel vale por su sello y su firma (Francisco, 2026-10-06)

El papel escaneado no aporta datos fiscales (esos los da el CFDI): aporta la **prueba de la entrega**, el **sello de recibido** y la **firma** de quien recibió. Por eso se archiva y por eso el OCR los lee.

- **Captura por lote** en costo por compra (botón *Varias* o soltar 2+ PDF en la barra; varias fotos soltadas ahí siguen juntándose en una factura), con el patrón de pagos a proveedores: una recepción por archivo; las fotos se convierten a un PDF cada una.
- **Identificación** (`POST identificar`): lo leído (UUID, RFC, folio, total) → su CFDI con `ligarCfdi` → las entradas cuyo monto cuadra (tolerancia R-v2) y cuyo proveedor es el emisor (RFC o nombre). **Listo** sólo con CFDI exacto + una sola entrada libre + proveedor confirmado + sello y firma vistos. Lo demás se propone sin pre-marcar o se elige.
- **Expediente R-v2:** checks *Sello de recibido* y *Firma de quien recibió*. `false` bloquea; sin dato (lecturas anteriores) se informa sin bloquear.
- **Medición (2026-10-06):** Medido en prod (sólo lectura) sobre las **576 facturas ya archivadas**, dándole al identificador sólo lo que leyó cada papel: propone la entrada correcta en **262** (133 vendrían «listas» con sello y firma), entre gemelas la fecha elige bien en 19, en 25 la correcta queda entre las opciones, 276 van a búsqueda a mano y **0 «listas» equivocadas**. La regla se endureció con esa medición: con entradas gemelas (mismo proveedor e importe cada semana) nunca se pre-marca, y una sola candidata lejos de la fecha de la factura tampoco.
- Pendiente: medir con papeles reales cuántas veces el OCR distingue sello y firma, y si conviene un hallazgo «recibió sin sellar/firmar» por sucursal.

#### Lo que se queda en manos del auxiliar enseña — sin dejar huecos (ADR-085)

Pedido de Francisco: *«lo que se quede comience a estudiar al usuario para aplicar correctivos y scripts que usen interpretación en código para ajustar criterios que aporten a ir aumentando, sin dejar huecos por detrás»*. Es el patrón de ADR-021 (Horus.L) y Maat (L2), aplicado a la recepción: **el motor aprende con reglas tipadas y auditables; el LLM no decide.**

| Item | Qué | Estado |
|---|---|---|
| RE.35 | **Motor v1 + veredicto único por entrada.** Función pura y versionada (patrón `receipt-match.ts`): cada entrada cae en **exactamente un** cubo — `auto` · `revisar(motivos[])` · `sin_cfdi_aun` (ContPAQi sincroniza diario; **no** es falla) · `fuera_de_alcance`. Tolerancia en `finance.receipt_settings`. Expediente con los checks en costo-por-compra (columnas Kepler · papel · CFDI) y la entrega a Finanzas generada desde ahí (RE.32 se reusa) | ⬜ |
| RE.36 | **Subir el papel del repartidor liga solo con ContPAQi:** (1) QR del SAT → UUID exacto; (2) OCR ampliado a UUID/serie/folio, con corrección del UUID contra los existentes; (3) RFC (OCR o aprendido) + folio o total → sugerida que confirma una persona; (4) de la factura identificada se proponen las entradas que cubre. También acepta XML. Liga en `fiscal.cfdi_assignments` con `match_source` = `qr` · `uuid_ocr` · `folio_rfc` · `importe_fecha` · `manual`; sólo `qr` y `uuid_ocr` exacto entran sin confirmación. Hoy, con el OCR actual: 54.8% de 588; techo estimado ~80%. Primero: medir el QR en una muestra | ⬜ |
| RE.37 | **Bitácora de decisiones humanas = el material de aprendizaje.** Cada decisión sobre una entrada `revisar` guarda la **foto de los checks** (valores, diferencia, proveedor, sucursal, usuario de captura), qué decidió (aceptar · devolver · corregir en Kepler) y un **motivo de lista cerrada** (p. ej. `precio_acordado`, `nc_pendiente`, `error_captura_kepler`, `factura_multiple`; `otro` exige texto). Sin motivo cerrado no hay patrón que aprender | ⬜ |
| RE.38 | **Minero de patrones (nocturno, determinista).** Agrupa decisiones por (check que falló × proveedor × motivo × signo y tamaño de la diferencia × usuario). Un grupo con soporte suficiente y aceptación consistente **propone una regla tipada** (alias de nombre, régimen alterno, tolerancia de redondeo por proveedor, factura múltiple conocida) — parámetros, no código libre. El LLM sólo puede clasificar el texto de `otro` en un motivo y redactar la explicación | ⬜ |
| RE.39 | **Banco de pruebas antes de activar.** La candidata se re-juega sobre **todo** el historial de decisiones: se exige **cero casos** donde el humano devolvió o corrigió y la regla habría aprobado; luego corre **en sombra** (registra lo que haría, no decide) y se compara contra el humano | ⬜ |
| RE.40 | **Promoción con dos llaves y versión.** El sistema propone; el jefe de compras aprueba (quien propone no aprueba). Tabla de reglas versionada: estado `propuesta → sombra → activa → retirada`, evidencia del banco de pruebas, quién aprobó. **Toda auto-aprobación queda sellada con la regla y versión que la decidió** | ⬜ |
| RE.41 | **Sin huecos por detrás.** (a) **Auditoría por muestreo:** un % al azar de lo auto-aprobado vuelve a un humano; si una se devuelve, la regla que la aprobó **se suspende sola** y abre hallazgo. (b) **Precisión por regla** (patrón Maat L2); si baja, regresa a sombra. (c) **Candado de cobertura diario:** `auto + revisar + sin_cfdi_aun + fuera_de_alcance = universo de Kepler`, con prueba negativa. (d) **Deriva:** RFC, régimen o nombre nuevos del proveedor → la regla aprendida no aplica, cae al humano. (e) **Lo que nunca se aprende:** F1, F3, F5, F8 y la **OC obligatoria** sólo cambian por decisión humana con ADR. (f) **Correctivos al origen:** tablero por usuario/sucursal de por qué se cae (sin OC, RFC mal tecleado, precio distinto) para corregir **la captura en Kepler**, no para aflojar la regla — hoy `USR-A` sería el primer caso | ⬜ |

**El KPI:** % automático semanal **con su denominador declarado**, más la tasa de devolución en la muestra auditada. Si el % sube y la muestra se ensucia, no es progreso.

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
