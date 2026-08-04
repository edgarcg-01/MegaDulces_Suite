# Fase CC — Comprobantes de Cobranza (depósito + OCR)

> Adjuntar el comprobante de **depósito** (imagen/PDF) a un **cobro de Kepler**, con **OCR**, ligado por `(sucursal, folio)`. Digitalización de archivos = evidencia **read-only** sobre el ERP (no crea ni escribe cobros). Captura en oficina (`/finanzas`).

## Tesis

Un cliente a crédito paga con transferencia/depósito y manda la ficha. Hoy esa ficha vive en WhatsApp/papel, sin ligarse al cobro. CC digitaliza ese adjunto: el capturista **elige el cobro** (de la lista de Kepler), **sube la ficha**, corre **OCR** (Claude vision), el sistema **compara el monto** OCR vs el del cobro (chip de cuadre) y guarda la evidencia. Validación/rechazo HITL. Hereda ADR-016 (motor/humano decide, LLM fuera del dinero) y el patrón de `finance.expense_proofs` (GX.7).

## Dónde vive el cobro en Kepler (decode)

- Documento **`Collect1`** (taxonomía `md.doctype`), folio serie **`UA0501`**.
- En `md.kdmm` = **`U-A-5-1` "Cobro PUE"**, clave `KFUA0501`, asiento **C 102 Bancos / A 115 Clientes**.
- Filtro exacto en `md.kdm1`: `c2='U' AND c3='A' AND c4=5` (NO todos los abonos nat A — grupos 20/21/25/26/30/35 = devoluciones/notas de crédito → cuenta 403, no son cobros). Hermano fiscal `U-A-7-1` "Cobro CFDI" (0 filas en CEDIS).
- Cols header: `c1`=suc · `c6`=folio (**único**, 23771/23771) · `c9`=fecha · `c10`=cliente_code · `c24`=concepto · `c16`=monto · `c32`=beneficiario.
- Fuente = **CEDIS `md_00`** (centraliza la cobranza; sumar sucursales duplica). Total UA0501 = $369.5M. Con ficha (depósito/transferencia/tarjeta) = **5,227** de 23,771.

## Arquitectura

| Capa | Qué |
|---|---|
| `analytics.erp_collections` | Espejo read-only de los cobros de Kepler (PK `(tenant, suc, folio)`, sin RLS, filtro tenant explícito). Lo puebla el importer. |
| `finance.collection_deposits` | Nuestro registro: adjunto `files` jsonb + campos OCR + `monto_match` + estado `recibido→validado\|rechazado`. RLS forzado (calca `expense_proofs`). |
| `import-collections.js` | CEDIS `md_00`, filtro U-A-5, deriva forma_pago + tipo_cuenta, UPSERT aditiva sin churn. |
| `LlmExtractorService.extractDepositSlip()` | Claude Haiku vision, imagen **y PDF nativo** (bloque `document`); campos ficha MX (monto/fecha/banco/cuenta_dest/referencia SPEI/ordenante/metodo). Degrada sin `ANTHROPIC_API_KEY`. |
| `libs/finance/.../collection-deposits` | Backend: `listCobros` ⋈ evidencia + KPIs, `uploadFile` (Cloudinary), `runOcr` (preview), `attach` (calcula cuadre, tolerancia $1), `validate`/`reject`. Endpoints `/finance/collections`. |
| `/finanzas/cobranza` | Frontend Operations: tabla densa de cobros + chip de cuadre + panel adjuntar (subir → OCR → editar → guardar) + validar/rechazar. |
| Permisos | `FINANCE_COLLECTIONS_VER` (capturista adjunta) / `FINANCE_COLLECTIONS_GESTIONAR` (revisor valida). Independencia por módulo. |

## Estado

| Slice | Estado | Verificación |
|---|---|---|
| CC.0 Fundación (mig + importer + OCR) | ✅ commit `6fccdffb` | importer 23,771 cobros / $369.5M / 5,227 con ficha; build api |
| CC.1 Backend (módulo + permisos + wire) | ✅ commit `9577b1ca` | smoke `test-newdb-collection-deposits` 18/18; build api |
| CC.2 Frontend (`/finanzas/cobranza`) | ✅ commit `9a83bbd9` | build view OK; validación visual manual pendiente |
| CC.3 Controles (cuenta propia + folio electrónico dedup) | ✅ 2026-08-04 | mig `20260804190000`; smoke 26/26; builds api+view OK |
| PROD migraciones | ✅ 2026-08-03 | Railway batch 154 (5 migs); tablas + RLS + 21 roles con VER verificados |

### CC.3 — Controles derivados de fichas reales (Comprobante Universal de Sucursales)

Dos comprobantes reales (Banorte, cuenta `1326933041` titular Luis Francisco López Gutiérrez, depósitos de efectivo de ruta ~$8,850) destaparon dos controles:

- **Cuenta destino propia** (`finance.collection_deposits.cuenta_propia`): `ocr_cuenta_dest` termina en un `account_label` de una cuenta `bank` de `finance.bank_accounts` (fase CB). Ej.: `1326933041` → termina en `3041` = BANORTE 3041 ✓. Depósito a cuenta NO reconocida = bandera roja. Lo calcula el servicio al `attach`; backfill en la migración.
- **Folio electrónico como llave de dedup determinista** (`ref_norm`, columna GENERATED STORED = solo dígitos de `ocr_referencia`, índice parcial vivo). Estructura decodificada: `DDMMYYYY·sucursal·claveBanco(311)·ventanilla·No.Tran·HHMM`. Misma referencia en dos cobros = mismo depósito → **se informa** (multi-folio legítimo: un depósito cubre varios cobros, ej. manuscrito "448/441/761") **o** ficha repetida. HITL: el revisor decide, no se bloquea.

Superficie: badge de alerta (`pi-flag-fill`) en la tabla, tags "Cuenta propia/NO reconocida" + "Referencia duplicada" en el diálogo de ver, KPI "Alertas de control", toasts al adjuntar. Backend: flags en `listCobros`/`detail`/`attach`. Deferred (sigue en pie): three-way match contra el abono bancario real (CB) — este slice NO prueba que el dinero entró, solo que la ficha va a cuenta propia y no está repetida.

**Pendiente prod (CC.3):** aplicar mig `20260804190000` a Railway + redeploy api+view + re-login.

## Decisiones fijadas

- Ancla = cobro Kepler `UA0501` (grupo 5), read-only. Captura = oficina. Fuente = CEDIS `md_00`. Match de monto = sugerencia, valida humano (tolerancia $1).
- `RolesGuard` chequea clave exacta; ability.factory solo para god-mode admin (NO requiere mapear FINANCE_*).

## Pendiente prod (feature vivo)

1. **Redeploy código** api+view a Railway (git push → rebuild) — commits locales sin push.
2. **Correr `import-collections.js`** desde máquina LAN con `DATABASE_URL_NEW=<prod>` para poblar `analytics.erp_collections` (Railway no alcanza CEDIS `md_00`).
3. **Re-login** (permisos en el JWT).
4. Rotar la credencial prod de Railway (expuesta en sesión).

## Diferido

- Cron del importer (agendar como los otros feeds).
- Conciliación automática cobro↔ingreso bancario (CB `finance.bank_movements`) y cobro↔abono Kepler.
- Captura desde campo (vendedor `apps/vendor`) / cliente (WhatsApp/portal).
- Grupo 7 "Cobro CFDI" (0 filas en CEDIS hoy) + complemento de pago CFDI `kdfe33pagm2`.

---

## CC ext — Pago a proveedor + Orden de entrada (✅ local 2026-08-03)

El mismo patrón (adjunto + OCR + HITL, evidencia read-only sobre Kepler) para dos papeles más de compras. **Dos módulos dedicados** (calcan Cobranza; decisión Edgar 2026-08-03).

### Decode (probe en vivo Kepler `md_00`, 2026-08-03)

| Papel | Doc Kepler | Filtro `kdm1` | Universo | Columnas clave |
|---|---|---|---|---|
| Pago a proveedor (transferencia) | **`XD2501`** "Payment1" (C 201 / A 102) | `c2='X' AND c3='D' AND c4=25` | 619 / $42.5M (162 c/RFC) | c6 folio · c9 fecha · c10 código prov · c32 razón social · c22 RFC · c16 monto |
| Orden de entrada (recepción) | **`X-A-40`** "EntryOr1" (mueve inventario) ⋈ vale **`X-A-37`** | `oe c2='X' c3='A' c4=40 AND c37='37'`, `v.c6=oe.c39` | 8,361 / $451.8M (join vale 8360/8360) | oe.c6 folio · oe.c9 fecha · oe.c16 monto · vale.c32 razón social · vale.c22 RFC · oe.c39 vale · vale.c39 OC |

- ⚠️ **`XD2601` NO es transferencia a proveedor**: es caja chica / gastos NF (códigos GG*, c16 a menudo 0). Eso es Egresos (Fase GX), no este módulo.
- El vale `X-A-37` trae el mejor dato del proveedor (RFC + razón social completa + link a la OC `X-A-35`); por eso la orden de entrada se enriquece con él.

### Entregado

- **Schema** mig `20260803130000`: 2 espejos `analytics.erp_supplier_payments` / `analytics.erp_goods_receipts` (sin RLS, GRANT SELECT) + 2 evidencias `finance.supplier_payment_proofs` / `finance.goods_receipt_proofs` (RLS forzado). Perms `20260803130100`: `FINANCE_PAYMENTS_VER/GESTIONAR` (backfill ancla a Bancos). **Órdenes de entrada NO tiene permiso propio**: vive en el proyecto **Compras** y reusa `COMPRAS_VER/GESTIONAR`.
- **Importers** `import-supplier-payments.js` (XD2501) + `import-goods-receipts.js` (X-A-40⋈X-A-37, dedupe por `(suc,folio)`). UPSERT aditiva, sin DELETE, fuente CEDIS `md_00`.
- **OCR** pagos reusan `extractDepositSlip` (un SPEI es una transferencia); entradas usan `extractRemision()` nuevo (folio, fecha, proveedor, RFC, subtotal, IVA, total). El cuadre de la entrada acepta **total o subtotal** (IVA variable en dulce a granel).
- **Backend** `libs/finance/supplier-payment-proofs` (`/finance/supplier-payments`) + `libs/finance/goods-receipt-proofs` (`/finance/goods-receipts`).
- **Frontend** `/finanzas/pagos-comprobantes` + `/finanzas/entradas` (tabs + sidebar). Calcan la página de Cobranza.
- Smoke `test-newdb-supplier-receipt-proofs` **30/30** (en regression). Builds api+view verdes.

### Pendiente prod (CC ext)

1. Aplicar migs `20260803130000` + `20260803130100` a Railway.
2. Correr `import-supplier-payments.js` + `import-goods-receipts.js` desde LAN con `DATABASE_URL_NEW=<prod>` (Railway no alcanza CEDIS).
3. Redeploy api+view + re-login.
