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
| CC.4 Three-way match (abono real en banco, CB) | ✅ 2026-08-04 | smoke 28/28; builds api+view OK; sin migración (read-only) |
| CC.5 Persistir conciliación (bank_recon_matches) | ✅ 2026-08-04 | smoke 31/31; builds api+view OK; sin migración |
| CC.6 Caso B — abonos en banco sin cobro (bank-first) | ✅ 2026-08-04 | smoke 34/34; builds api+view OK; sin migración |
| CC.7 Ficha-first (foto → OCR → busca el cobro solo) | ✅ 2026-08-04 | smoke 35/35; builds api+view OK; sin migración |
| PROD migraciones | ✅ 2026-08-04 | Railway **batch 158** (CC.3 `20260804190000` + 4 aditivas RA/smart-search) |

### CC.7 — Ficha-first (optimización de tiempos de captura)

Invierte el flujo para el caso común. Antes: elegir cobro → subir ficha. Ahora: **botón "Capturar ficha"** → tomar foto/archivo → OCR lee monto+fecha → `matchCobrosByOcr()` **busca el cobro solo** (mismo monto ±$1, fecha ±7d, prioriza los sin comprobante) → el capturista da un tap en el cobro sugerido → revisa campos → guarda. Solo si el OCR no encuentra match (o leyó mal el monto — editable + "Buscar cobro"), cae a **búsqueda manual** por folio/cliente/monto. Endpoint `POST /match-cobro` (VER). El diálogo de adjuntar se reusó: soporta `attachTarget=null + captureMode`, muestra el matcher y al elegir cobro aparecen los campos + Guardar. Elimina el paso de buscar el cobro a mano en el flujo feliz. **Pendiente prod CC.7:** redeploy api+view.

### CC.6 — Caso B: el dinero entró pero NO hay cobro (bank-first)

El inverso del three-way (banco → cobro). Nueva vista "Abonos sin cobro" en `/finanzas/cobranza` (toggle de modo): lista los movimientos de banco **clasificados como cobranza** (categoría CB `cobranza`, `amount_in>0`) que **NO están ligados** a ningún cobro (`whereNotExists bank_recon_matches`). Cada fila marca `tiene_candidato` (hay un cobro de mismo monto ±$1 y fecha cercana, sin ligar → **linkable**) vs **huérfano** (sin cobro → investigar, resaltado). Endpoints `GET /bank/unmatched`, `GET /bank/:id/candidates`, `POST /bank/:id/link` (bank-first, reusa `writeReconMatch`). KPIs: abonos sin ligar, $ sin conciliar, huérfanos.

**Realidad de los datos (enero prod):** 2,906 abonos de cobranza sin ligar · **242 con candidato** (quick wins) · 2,664 "sin cobro". ⚠️ Ese 2,664 está **inflado por la granularidad banco-vs-Kepler** (banco = depósito en bulto que cubre N cobros; Kepler = por cobro) — NO son 2,664 huérfanos reales. El match 1:1 por monto solo caza los depósitos que casualmente = un cobro. El **Caso B preciso** necesita match por **suma de cobros = monto del abono** (agrupación), diferido. **Pendiente prod CC.6:** redeploy api+view.

### CC.5 — Persistir la conciliación (el cobro queda ligado a su abono, y CB lo ve)

CC.4 solo **sugería**. CC.5 **cierra el lazo**: el revisor confirma cuál abono es y se persiste en `finance.bank_recon_matches` (la tabla de CB) con `kepler_doc_tipo='UA0501'`, `kepler_doc_folio=folio`, `kepler_cuenta='102'`, `kepler_amount=cobro_monto`, `match_type` (`exact` si cuadra ±$1, si no `manual`). El movimiento pasa a `recon_status='matched'`. Endpoints `POST /:id/bank-match` (confirmar) y `POST /:id/bank-unmatch` (deshacer, revierte a `pending` si el abono queda libre), permiso **GESTIONAR**. `detail()` lee las conciliaciones vía `linkedBankMovements()` y muestra "Conciliado con el banco" (verde, por quién/cuándo, con botón deshacer) en vez de los candidatos. Idempotente (`onConflict...merge`). Modelo a **nivel cobro**: un abono puede ligarse a N cobros (multi-folio), cada uno una fila. **Integra con CB**: el cobro conciliado desde Cobranza aparece como movimiento `matched` en la conciliación bancaria. **Pendiente prod CC.5:** redeploy api+view + re-login.

### CC.4 — Three-way match: ¿el dinero ENTRÓ al banco?

La ficha (CC.3) prueba que se **depositó**, no que **entró**. CC.4 cierra el eslabón cruzando el depósito contra el **estado de cuenta real** (`finance.bank_movements`, fase CB):

```
cobro Kepler  ↔  ficha OCR (CC.3)  ↔  abono real en banco (CC.4)
```

`bankMatch()` (en `detail()`, momento de revisión) busca el abono por **cuenta propia** (`bank_account` cuyo `account_label` es sufijo de `ocr_cuenta_dest`) + **monto del depósito** (OCR, tol $1) + **ventana de fechas** (−1/+6 días de la fecha de la ficha). Sin clave SPEI en el feed CB, el match es por (cuenta, monto, fecha). Estados: `confirmado` (1 abono), `multiple` (varios candidatos → humano elige), `sin_match` (no aparece → bandera), `sin_dato` (falta monto/fecha). Read-only: **informa**, no escribe la conciliación (persistir en `bank_recon_matches` con `kepler_doc_tipo='UA0501'` es el siguiente paso natural). UI: bloque semáforo en el diálogo de ver con los movimientos candidatos (banco/cuenta/fecha/monto/concepto).

**Limitación conocida:** el feed CB local es enero-2026; en prod el match solo aplica a periodos cargados. Multi-folio (1 depósito = N cobros) casa a nivel **depósito** (la ficha trae el total), no por cobro individual. **Pendiente prod CC.4:** redeploy api+view (sin migración nueva).

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

---

## SP.1–SP.5 — Pago a proveedor al nivel de Cobranza (✅ local + PROD mig batch 161, 2026-08-05)

Grounded en comprobantes BBVA reales (`Z:\Datos Usuarios\0Finanzas\Pagos\2026\<mes>\...`, organizados por banco/cuenta y por proveedor; nombre = factura "F 451", "F 906-907-908"). El comprobante trae mejor llave que la ficha de cobranza: **Concepto de pago = folio(s) de factura**, y el pago Kepler **ya trae ese mismo concepto** (`erp_supplier_payments.concepto` = kdm1.c24).

- **SP.1 OCR dedicado** `extractSupplierPayment` (`SupplierPaymentFields`): lee `concepto` (factura), `cuenta_origen` (retiro propia), `cuenta_destino` (prov.), `beneficiario`, `clave_rastreo`, `banco_destino`, `metodo`. Semántica INVERSA a `extractDepositSlip` (pago saliente; la empresa ordena). Mig `20260805210000`: columnas `ocr_concepto`, `ocr_cuenta_origen`, `cuenta_propia` + `ref_norm` GENERATED (clave normalizada) + índice parcial.
- **SP.2 Controles**: `cuenta_propia` = la cuenta de ORIGEN ∈ `finance.bank_accounts` (el pago debe salir de cuenta de la empresa; ej. retiro 5712) + dedup de `ref_norm` (transferencia repetida). Badges en tabla, tags en el diálogo ver, KPI "Alertas de control".
- **SP.3 Ficha-first**: botón "Capturar comprobante" → OCR → `matchPaymentsByOcr` (monto ±$1 + fecha ±7d + boost por token de factura en el concepto) → tap → guarda. Fallback a búsqueda manual. Endpoint `POST /match-pago`.
- **SP.4 Three-way**: `bankMatch` contra el **CARGO** (`amount_out`) de la cuenta de origen; `confirmBank`/`unlinkBank` persisten en `finance.bank_recon_matches` con `kepler_doc_tipo = doc_prefix` (XD2601/2501/6001). Endpoints `/:id/bank-match` + `/bank-unmatch` (GESTIONAR).
- **SP.5 Carga masiva** `database/importers/finance/bulk-ingest-supplier-payments.js` (HTTP, reusa OCR→match→upload→attach; **dry-run** por default; `--month`, `--limit`, `--apply`). El nombre del archivo = hint de concepto. Corre desde LAN contra el API.

Smoke `test-newdb-supplier-payment-controls` **13/13** (en regression). Builds api+view OK. Mig `20260805210000` en Railway (batch 161).

**Pendiente prod (SP):** redeploy api+view (código pusheado) + re-login + correr el bulk ingest desde LAN con dry-run → revisar match → `--apply`. Requiere `ANTHROPIC_API_KEY` en el API para el OCR. Diferido: matching por CFDI (`serie F`/`folio 451` vs `fiscal.cfdis`) y liga a la orden de entrada/factura vía `erp_purchase_adjustments.factura_ref` (c11).

---

## Observaciones de diseño UI — revisión del plan (2026-10-26)

> **Con qué se miró: el plan, no la pantalla** (nivel C). Nada visual se da por medido; lo que
> sólo se comprueba con la pantalla viva va como criterio a verificar. La ley es
> [`ESTANDAR_DE_INTERFACES.md`](../../ESTANDAR_DE_INTERFACES.md) (§ = sus secciones) y su
> implementación [`DESIGN.md`](../../../DESIGN.md). Severidad: 🔴 la pantalla afirmaría algo falso,
> escondería lo que importa o perdería trabajo — **bloquea pasar C3 a 🚀** · 🟠 se resuelve dentro
> de la fase · 🟡 mejora; si no entra, queda como deuda con nombre.
> La pantalla existe (`/finanzas/cobranza`, `/finanzas/pagos-comprobantes`, `/finanzas/entradas`):
> cada observación es un criterio a verificar en ella, no un defecto medido.

**La pregunta que contesta (prueba de la frase, §4.0b):**

- *`/finanzas/cobranza`, modo cobros:* *«¿Qué cobros de crédito siguen sin su evidencia completa
  (ficha de depósito → abono en el banco)?»* — una sola; la cadena cobro → ficha → banco es su
  evidencia. Bien.
- *`/finanzas/cobranza`, modo «Abonos sin cobro»:* *«¿Qué dinero entró al banco sin un cobro en
  Kepler?»* — es otra pregunta, y por eso está bien que sea otro modo; el corte con `app-segmented`
  es el correcto.
- *`/finanzas/pagos-comprobantes` y `/finanzas/entradas`:* la misma pregunta para el pago a proveedor
  y para la entrada de mercancía. Bien partidas, pero son tres copias de una pantalla (CC.UI.9).

**Jerarquía propuesta (§3.7 · DESIGN §Q.5), cobranza:** primario = **cobros sin evidencia completa:
cuántos y cuánto dinero, separados en «sin ficha» y «con ficha, sin abono en el banco»** · secundario
= la tabla de cobros con el chip de cuadre y el estado de banco · terciario = referencia SPEI, cuenta
destino, folio.

| # | Sev | Observación (desde la silla de quien la usa) y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| CC.UI.1 | 🔴 | **El chip de cuadre puede ponerse verde por lo que tecleó la persona, no por lo que dice la ficha.** El flujo es subir → OCR → **editar** → guardar, y el cuadre compara el monto contra el del cobro con tolerancia de $1. Si el OCR leyó mal y quien captura corrige el monto mirando el cobro de al lado, el chip dice «cuadra» con un número que nadie leyó del papel. Es el control de los 5,227 cobros con ficha. | §1.1 · DESIGN §X.3 y §X.4 | Lo que propuso el OCR se ve como del motor (fondo y borde `--ember-soft`/`--ember-border` con el sello de IA de DESIGN) y lo corregido a mano se marca: «corregido a mano · el OCR leyó $X». El chip compara el monto leído; si se editó, dice «Cuadra con lo capturado a mano, no con lo leído», en `warn`, no en `ok`. |
| CC.UI.2 | 🔴 | **«Cuenta propia» se decide por los últimos 4 dígitos.** `cuenta_propia` = que `ocr_cuenta_dest` termine en el `account_label` de una cuenta de la empresa (`…3041` → BANORTE 3041). El control existe para cazar depósitos a una cuenta que no es nuestra, y cualquier cuenta de un tercero que termine igual sale en verde. Lo mismo para `cuenta_origen` en pagos a proveedor (SP.2). | §1.1 · §2.3 | El tag no dice «Cuenta propia»: dice «Termina en 3041, como BANORTE 3041», con el número completo que leyó el OCR al lado. Verde sólo si coincide la cuenta completa (o la CLABE) contra `finance.bank_accounts`. |
| CC.UI.3 | 🔴 | **«Huérfano» se pinta resaltado sobre 2,664 abonos que el plan dice que no son huérfanos.** El conteo está inflado por la granularidad: el banco registra un depósito en bulto que cubre N cobros, y el cruce 1:1 por monto sólo caza los que casualmente valen un cobro. Contra 242 con candidato (lo accionable), 2,664 filas gritan «investigar» y entierran a las 242. | §1.1 · §4.0 B (ruido) · §3.1 | Rótulo «Sin cobro del mismo monto (puede ser un depósito que cubre varios cobros)», en tono neutro. El modo abre filtrado en «con candidato» (242) y el KPI separa las dos cifras. «Huérfano» se reserva para cuando exista el cruce por suma de cobros que el plan difiere. |
| CC.UI.4 | 🔴 | **«Confirmado» llama confirmación a un solo candidato por monto y fecha.** `bankMatch()` dice `confirmado` cuando encuentra **un** abono de la misma cuenta, monto ±$1 y fecha −1/+6 días; nadie confirmó nada, y sin clave SPEI el cruce no tiene control placebo. Con depósitos de ruta de montos parecidos (~$8,850 en los casos reales del plan), un candidato único puede ser el depósito de otro cobro. | §1.1 · DESIGN §X.3 y §X.4 | Estados: «Un candidato en el banco» (sugerencia, con su razón: cuenta, monto, días de diferencia) → «Conciliado por ‹persona› el dd-mmm» sólo al confirmar (CC.5). El verde se reserva para el segundo. |
| CC.UI.5 | 🔴 | **Desde el 1-oct la lista de cobros puede no traer los de las plazas, y no lo diría.** El plan fija «Fuente = CEDIS `md_00` (centraliza la cobranza; sumar sucursales duplica)»: la premisa del régimen que terminó el 30-sep. La Fase PO encontró `erp_collections` anclada a Oficinas (`PO.3` pendiente). En el flujo ficha-first, la ficha de un cliente de plaza termina en «no se encontró el cobro» y se lee como «no existe en Kepler». Y el plan dice que la tabla la llena un importer sin agenda (cron diferido): su edad no se conoce. | §1.6 · §1.3 · §3.6 · cruce con PO | Encima de la tabla, el universo y la edad: `app-freshness-pill` con la última lectura y, hasta que `PO.3` se mida, «Cobros de Oficinas; desde el 1-oct pueden faltar los de las plazas (Fase PO)». «No se encontró el cobro» dice también «la lista llega hasta dd-mmm hh:mm». La sucursal del cobro, por nombre (`\| sucursal`). |
| CC.UI.6 | 🟠 | **Sin la llave del OCR, los campos vacíos se leen como «la ficha no dice nada».** El extractor «degrada sin `ANTHROPIC_API_KEY`», y SP lo exige en el API. Mientras lee (imagen o PDF, segundos), el plan no describe qué se ve. | §1.3 · §3.5 · DESIGN §X «estado de trabajo honesto» | Tres estados distintos: «Leyendo la ficha…» (con lo ya leído), «La lectura automática no está disponible: captura los datos a mano» y «El OCR no encontró el monto». Ninguno deja campos vacíos sin decir por qué. |
| CC.UI.7 | 🟠 | **La misma bandera marca un posible fraude y un caso legítimo.** «Referencia duplicada» (`pi-flag-fill`) sale igual para un depósito que cubre varios cobros (el manuscrito «448/441/761» del plan) que para una ficha repetida en dos cobros; las dos suman al KPI «Alertas de control». | §1.1 · §4.0 B · §2.3 | Dos estados con texto: «Un depósito para N cobros» (informativo, fuera de alertas) y «La misma ficha ya está en el cobro ‹folio›» (alerta, navegable a ese cobro). El KPI cuenta sólo el segundo. |
| CC.UI.8 | 🟠 | **El cobro que sugiere el matcher se acepta con «un tap» y sin ver la competencia.** Ficha-first (CC.7) busca por monto ±$1 y fecha ±7 días; con montos repetidos, el primero de la lista es una apuesta. El plan habla de «tap»: pantalla táctil. | DESIGN §X.3 y §X.6 · DESIGN Fitts | Con un solo candidato, se muestra con su razón («mismo monto, 2 días antes, sin comprobante»). Con dos o más, ninguno preseleccionado: «Hay N cobros de $X en la semana: elige el que corresponde». Objetivos de ≥44 px en `pointer: coarse`. |
| CC.UI.9 | 🟠 | **Tres pantallas «calcan» la de Cobranza, y una de ellas entra al circuito de PGP.** `/finanzas/cobranza`, `/finanzas/pagos-comprobantes` y `/finanzas/entradas` repiten el mismo panel (subir → OCR → editar → validar): cada arreglo de CC.UI.1, .6 y .8 habría que hacerlo tres veces. Además PGP cuenta «Pagos a proveedor (evidencia)» entre las pantallas que absorbe su estación, y su O3 escribe el `X-D-26`: el mismo pago quedaría ligado a Kepler por dos caminos (el match por OCR de SP.3 y la asignación del Calendario), que pueden responder distinto. | §5.4 · §1.5 · cruce con PGP | El panel de evidencia + OCR vive una vez en `apps/view/src/app/shared/components/` y lo usan las tres pantallas. Para el pago a proveedor, una sola liga pago ↔ documento de Kepler: la del Calendario cuando el pago nació ahí; el match por OCR sólo para lo que no pasó por el Calendario, y la fila dice cuál de los dos la hizo. |
| CC.UI.10 | 🟠 | **«Pagos a proveedor» no dice qué pagos.** La vista cubre `X-D-25/26/60` con `c10 LIKE 'C%'` (mercancía); quedan fuera gastos (`GG*`), bancos (`GB*`) y nómina (`GN*`). Y este plan conserva la línea que dice que `XD2601` «NO es transferencia a proveedor», refutada después (es el 96 % de los pagos, $338M, según PO §10). Quien busca el pago de un gasto concluye que no se pagó. | §1.4 · §1.6 | Subtítulo fijo: «Pagos a proveedores de mercancía. No incluye gastos, créditos bancarios ni nómina». Se corrige la línea de `XD2601` en este plan. |
| CC.UI.11 | 🟡 | **«Validación visual manual pendiente» desde el 4-ago, y los pendientes apuntan a la prod vieja.** La lista habla de redeploy a Railway y de los batch 158/161 de Railway; prod vive en `md` desde el 22-sep. Por el plan no se sabe qué parte de CC.3–CC.7 y SP.1–SP.5 llegó a la pantalla que se usa. | método §4 · §2.4 | Revisión en nivel A con `auditoria-diseno` de las tres pantallas (claro, oscuro y `forced-colors`) y los pendientes reescritos contra `md`, con lo verificado en `/api/health` y en la pantalla. |

**Lo que esta revisión no cubre:** la exactitud del OCR por campo (el plan no la mide), el texto
definitivo de los avisos (se valida con Crédito y Cobranza) y la pantalla viva.
