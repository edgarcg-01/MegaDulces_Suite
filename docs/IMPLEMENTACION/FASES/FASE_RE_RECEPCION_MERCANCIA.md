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

### RE.0 — Multi-fuente [RUTA CRÍTICA]
- **Objetivo:** el feed cubre lo mismo que el Excel: CEDIS md_00 + sucursales Kepler md_01-05 + Wincaja.
- **Entregable:** extender `import-goods-receipts.js` a multi-branch (reusa `STOCK_BRANCH_MAP`/BRANCHES) + nuevo feed desde `wincaja.movimiento_proveedores` (tipo compra). `erp_goods_receipts.sucursal` deja de ser siempre '00'.
- **Schema:** `+ source` (kepler/wincaja) + sucursal real; mig aditiva.
- **Verificado:** md_03=833, md_01=313 XA2001; wincaja.movimiento_proveedores=7,356.

### RE.1 — Enriquecer el ancla (paridad de campos)
- **Objetivo:** traer los campos del Excel que faltan.
- **Entregable:** `fecha_vence` (`c18`), `condicion_pago` (`c30`), `dias_credito`, `poliza` (join `kdc2`). En `erp_goods_receipts` + importer.
- **Reuso:** `expense_doc_chain` para la póliza.

### RE.2 — Cuadre 3-vías + AUTO-explicación del descuadre
- **Objetivo:** automatizar el control G-vs-H (41% descuadre; typo $183M) **y explicar el porqué** desde el dato, no solo pintar rojo.
- **Entregable:** (a) OCR factura → compara **factura vs entrada (`c16`) vs OC** → `discrepancy_amount`; (b) **auto-explicación**: jalar los `X-D-40`+`X-D-55` ligados a la entrada (por factura `c11`/proveedor) y clasificar `c24` → `discrepancy_kind` ∈ {faltante, no_solicitado, mal_estado, cambiada, descuento_comercial, pronto_pago, apoyo_marca, typo, iva}; (c) reglas para **typo** (Δ>70%) e **IVA** (Δ≤2% / ratio ≈1.16); chip/semáforo + motivo en UI.
- **Clasificación `c24`:** keyword primero, **Haiku** para los tersos (~$13.2M "sin clasificar"); mismo patrón que Maat.
- **Reuso:** OCR `extractRemision`, cuadre actual, `LlmExtractorService`.

### RE.3 — CxP / vencimientos (aging + worklist)
- **Objetivo:** lo que el Excel tenía roto.
- **Entregable:** aging buckets (por vencer / vencidas) sobre `c18` + Wincaja `fecha_vencimiento`/`saldo`; worklist "por pagar esta semana"; tab/página. Días vencidos calculado bien (nunca −46,238).
- **Reuso:** `c18` (limpio), Wincaja saldo nativo.

### RE.4 — Bandeja de excepciones + alertas
- **Objetivo:** de log pasivo a motor proactivo.
- **Entregable:** scanner `@Cron` → `finance.findings` (sin evidencia / descuadre>umbral / por vencer / sin validar) + push WS al responsable.
- **Reuso:** patrón detectores Maat + `FINANCE_NOTIFIER_PORT`.

### RE.5 — Evidencia con roles + Devolución/NC
- **Entregable:** roles tipados (remisión / factura sellada / vale firmado / póliza / NC) + **importar los `X-D-40`/`X-D-55` de Kepler ligados a la recepción** (monto + motivo `c24` + SKU) — el Excel adjuntaba el PDF a mano; aquí llega del ERP (1,286 vs 45). Adjunto manual queda como complemento. Cloudinary (adiós links Drive muertos).

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
- **Falta (prod/next):** aplicar migración + `--apply` en Railway/LAN + redeploy api/view + **QA visual** · importar `c84` del pago · reconciliación notas vs `c84` (solapamiento) · Haiku para el tail sin-motivo · persistir duplicadas a `finance.findings` (bandeja + cron) · RE.2 auto-explain en `/compras/entradas`.
- **Hallazgo:** **$6.74M/año de facturas duplicadas** revertidas por NC → detector de control (patrón Maat).
- **Reuso:** `LlmExtractorService` (Haiku), detectores Maat, `erp_supplier_payments`.

## 6. Schema nuevo (consolidado)
- `analytics.erp_goods_receipts`: `+ source, fecha_vence, condicion_pago, dias_credito, poliza, total_factura, total_compra`. Sucursal real (RE.0).
- `finance.goods_receipt_proofs`: `+ role, credit_note_ref, discrepancy_kind, discrepancy_amount`.
- **Nuevo espejo `analytics.erp_purchase_adjustments`** (X-D-40 + X-D-55): `doctype, folio, entrada_ref (XA2001), factura_ref (c11), proveedor, sku, qty, monto, iva, motivo (c24), categoria`. Alimenta RE.2 (auto-explain) y RE.10 (descuentos/apoyos).
- Reusar `finance.findings` (bandeja) — sin tabla nueva.

## 7. Qué reusamos (feasibilidad alta)
OCR `LlmExtractorService`, `expense_doc_chain` (Maat), `finance.findings`+scanner, `erp_supplier_payments` (enlace a pago), smart-search, Cloudinary, `FINANCE_NOTIFIER_PORT`, permisos `COMPRAS_VER/GESTIONAR/VALIDAR` ya listos, `STOCK_BRANCH_MAP` + feeds Wincaja.

## 8. Decisiones abiertas
- **MVP:** RE.0 → RE.1 → RE.2 (**con auto-explicación X-D-40/X-D-55**) → RE.3. Supera al Excel en sus dos controles centrales. RE.4 (alertas) = siguiente golpe de efecto.
- **RE.10 (descuentos/apoyos):** $20.3M+$10.2M hoy invisibles — ¿entra al MVP o va después? (dinero grande, pero es análisis, no control de recepción).
- **Clasificación `c24`:** keyword vs Haiku — arrancar keyword, Haiku para el ~$13.2M terso.
- **Histórico (RE.9):** ¿migrar las 910 filas o arrancar limpio desde hoy?
- **ADR-041:** aceptar el enfoque read-only multi-fuente + pago heurístico + **ajustes `X-D-40`/`X-D-55` clasificados por `c24`**.

## 9. Riesgos / notas
- **Pago heurístico** (no estructural) — comunicar como "match aproximado", no trazabilidad exacta.
- **LAN**: los feeds de sucursales Kepler (md_01-05) y Wincaja corren desde la máquina de feeds (Railway no alcanza la LAN) — igual que los demás importers.
- **Póliza** por join a contabilidad — verificar el enlace doc→póliza en `kdc2` en RE.1.
- **Data quality del histórico** (RE.9) — normalizar en la migración, no arrastrar el caos.
