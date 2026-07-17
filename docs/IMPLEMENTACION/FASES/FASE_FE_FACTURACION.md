# Fase FE — Facturación Electrónica (Emisión / Timbrado CFDI 4.0)

> Cierra la última pata del ciclo CFDI: **emitir** (timbrar) nuestras propias facturas.
> Hasta ahora `libs/fiscal` solo **ingería/auditaba** CFDI (descarga masiva, listas, conciliación, DIOT…).
> Ahora también **emite** vía el PAC real de Mega Dulces: **SW SmarterWeb / Luna Soft** (revendido por **Conectia**, RFC PAC `IAD121214B34` — el mismo que ya timbra en Kepler).

Ver integración del PAC: memoria `reference_sw_smarterweb_timbrado`. Timbrado de prueba **verificado E2E** contra el sandbox de SW 2026-07-16 (UUID `fd024d05-…`).

Reglas heredadas (ADR-016): el motor determinista arma el JSON del comprobante; el LLM queda fuera del camino del dinero. Multi-tenant + RLS. English snake_case. Idempotente.

---

## Estado por sprint

Leyenda: ✅ hecho (código + build) · 🔨 en curso · ⬜ por construir · ⏳ parcial

### Track A · PAC + Emisión core (backend)
| Sprint | Qué | Estado |
|---|---|---|
| **FE.0** | Puerto `PAC_PORT` + `SwPacService` (auth dual token/user-pass, `stamp` `/v3/cfdi33/issue/json/v4`, `cancel`) en `libs/fiscal/emision`. Frontera respetada (no importa logistics). | ✅ |
| **FE.1** | Migración `20260716120000_fiscal_emision`: `fiscal.issuer_config`, `fiscal.invoice_sequences` (folio atómico), columnas `cfdis.xml/.pdf`, permisos `FISCAL_FACTURAR_VER/_GESTIONAR` (backfill anclado). | ✅ **aplicada Railway prod (Batch 124, 2026-07-16; 36 roles backfill)**; local pendiente si se prueba en dev |
| **FE.2** | `EmisionService` (config emisor, folio, armado CFDI 4.0, timbrado, persistencia a `fiscal.cfdis` rol=emitidas reusando `CfdiParserService`) + `EmisionController` `/fiscal/facturas` (emitir/list/issuer/xml/cancelar). Cubre **global mostrador** (InformaciónGlobal) y **nominativa**. | ✅ |

### Track B · Frontend
| Sprint | Qué | Estado |
|---|---|---|
| **FE.3** | Tab **Facturar** (`/contabilidad/facturar`): bandeja de emitidas + alta (global/nominativa, conceptos dinámicos, preview de totales) + config del emisor + descarga XML + cancelar. Operations (PrimeNG, tokens, dark-aware). Nav + tabs + authz-tree + perms frontend. | ✅ |
| **FE.4** | PDF (representación impresa). Vía servicio **GeneratePdf de SW** (`api.sw.com.mx/pdf/v1/api/GeneratePdf`, `templateId: cfdi40`) — no jsPDF; se cachea en `fiscal.cfdis.pdf`. `PacPort.pdf` + `EmisionService.getPdf` + `GET /fiscal/facturas/:uuid/pdf` + botón en el tab Facturar. | ✅ **código + build api+view verde** (sin migración — columna `pdf` ya existía); falta redeploy |

### Track C · Integraciones cross-domain (el valor)
| Sprint | Qué | Estado |
|---|---|---|
| **FE.5** | Auto-factura desde `commercial.orders` (fulfilled → CFDI). Puerto `INVOICE_ISSUER_PORT` (contracts) + adapter `OrderInvoiceIssuerService` (fiscal) + binding composition; hook best-effort en `fulfill`/`deliverNow` (nominativa si el cliente tiene datos fiscales, idempotente por `orders.cfdi_uuid`); endpoint manual `POST /commercial/orders/:id/facturar`; campos fiscales en `commercial.customers` (regimen_fiscal, uso_cfdi). Mig `20260716140000`. **UI FE.5 (build view verde):** datos fiscales en el form de cliente (dropdowns SAT régimen/uso + CP fiscal → `billing_address.zip`, catálogos en `shared/constants/sat-catalogs.ts`) + botón **Facturar (CFDI)** y chip CFDI en `/comercial/orders/:id` (visible en `fulfilled` sin CFDI, gateado `FISCAL_FACTURAR_GESTIONAR`). | ✅ **código + build api+view verde + mig aplicada Railway prod (Batch 125, 2026-07-16, columnas verificadas)**; falta redeploy API+view |
| **FE.6** | Factura global de mostrador. `issueDailyGlobal(date?)` agrega los pedidos entregados del día cuyo cliente NO tiene datos fiscales (los nominativos ya los facturó FE.5) → 1 CFDI global (conceptos por tasa de IVA), idempotente (marca `cfdi_uuid`). `POST /commercial/orders/global-invoice` + botón "Global del día". **Trigger MANUAL — cron diferido** (no timbra reales en automático hasta verificar en vivo). Fuente = `commercial.orders` (Wincaja/POS = FE.6.2 futuro). FE.5+FE.6 = 100% de ventas comerciales facturadas. | ✅ **código + build api+view verde** (sin migración); falta redeploy + activar cron tras verificación |
| **FE.7** | Portal B2B self-service ("Facturar mi pedido"). El puerto `INVOICE_ISSUER_PORT` gana `getXml`/`getPdf`; `commercial-orders` suma `selfInvoiceOrder` (solo `customer_b2b`, ownership forzado, captura/actualiza datos fiscales del cliente antes de timbrar, idempotente) + `getCfdiXml`/`getCfdiPdf` (descarga con ownership). Endpoints `POST /orders/:id/self-invoice` · `GET /orders/:id/cfdi-xml` · `GET /orders/:id/cfdi-pdf` (todos `COMMERCIAL_ORDERS_VER` + ownership). UI en `apps/portal` order-detail: sección **Factura** (form fiscal prefilled desde `customers/me` con dropdowns SAT régimen/uso + CP; descarga PDF/XML si ya emitida). Sin migración (reusa `orders.cfdi_uuid`). | ✅ **código + build api+portal verde**; falta redeploy portal+api |
| **FE.8** | **REP (Complemento de Pago) al cobrar una PPD.** `PaymentsService` YA existía (Fase LM — la deuda estaba saldada). `EmisionService.emitirRep(RepInput)` arma un CFDI tipo 'P' con **Pagos 2.0** (Totales + Pago + DoctoRelacionado + ImpuestosDR; base=monto/1.16, IVA 16%), resuelve la factura original por UUID y **devuelve null si es PUE** (contado no lleva REP). Puerto `INVOICE_ISSUER_PORT.issueRep` + adapter. Wire best-effort en `PaymentsService.recordPayment`/`deliverAndCollect` (post-commit; calcula parcialidad = nº de cobros y saldos ant/insoluto desde `orders.balance_due`+monto; mapea método→forma SAT). `buildInvoiceInput` ahora emite **PPD** si el cliente es a crédito (`payment_terms_days>0`), PUE si contado. Endpoint manual `POST /fiscal/facturas/:uuid/rep`. Badge **REP** en la bandeja. Sin migración (serie 'P' en `invoice_sequences`). | ✅ **código + build api+view verde**; **el JSON de Pagos 2.0 NO está verificado contra el PAC en vivo** (el CFDI más intrincado) — validar en el deploy. Diferido: reversa de REP al reversar un pago |

### Track D · Descarga + hardening
| Sprint | Qué | Estado |
|---|---|---|
| **FE.9** | Swap `SAT_SOAP_PORT` → `@nodecfdi` (arregla el botón Descarga en prod; flujo ya probado local). `SatSoapNodecfdiService` (firma WS-Security real + `FetchWebClient`) es el **default**; `FISCAL_SAT_CLIENT=reference` vuelve a la impl node:crypto. `@nodecfdi@2.0.0` bundleado por webpack (no external). | ✅ **código + build api verde**; falta redeploy API + FIEL en bóveda prod + **test de descarga en vivo** (build ≠ WS funcionando) |
| **FE.10** | Cancelación completa: motivo SAT 01–04 (01 exige UUID de sustitución, validado), acuse del SAT persistido (`fiscal.cfdis.cancel_*`), estatus real (vigente / **en_proceso_cancelacion** / cancelado), `status()` confirma contra el SAT. Endpoints `POST :uuid/cancelar` (motivo+sustitución+reason) · `GET :uuid/estatus` · `GET :uuid/acuse`. **+ fix: agregado el endpoint `GET :uuid/pdf` (FE.4) que faltaba en el controller** (el front lo llamaba → 404). UI: dialog de cancelación con motivo/sustitución/nota + columna estatus + botones "Consultar estatus" y "Acuse". Mig `20260716180000` (columnas cancel_*, aditiva). | ✅ **código + build api+view verde**; falta aplicar mig + redeploy + verificar endpoint SW de cancelación/estatus en vivo |
| **FE.13** | **Contingencia de facturación.** La auto-factura ya no falla en silencio: si el PAC falla con datos válidos, registra `cfdi_error`+`cfdi_attempts`+`cfdi_last_attempt_at` en la orden (mostrador sin datos fiscales = NO error, va al global). `retryPendingInvoices({days,limit})` reintenta los pedidos entregados sin CFDI con datos fiscales completos (idempotente, cap de intentos). `invoiceReconciliation({days})` = reporte: gap nominativa (con error) + mostrador pendiente de global por día. Endpoints `POST /commercial/orders/retry-invoices` · `GET /commercial/orders/invoice-reconciliation`. `InvoiceRetryCronService` @Cron horario **gated por `ENABLE_INVOICE_RETRY=true`** (off por default, mismo criterio que el global). UI: botón **Pendientes** en Facturar → consola (gap nominativa + reintentar todos, mostrador por día + facturar global por día). Mig `20260716200000` (cols cfdi_* + índice parcial). | ✅ **código + build api+view verde**; falta aplicar mig + redeploy (cron off hasta verificar) |
| **FE.12** | **Notas de crédito (CFDI de Egreso).** `TipoDeComprobante='E'` + `CfdiRelacionados` (TipoRelacion 01) al UUID original. `EmisionService.emitirNotaCredito(uuid, {conceptos,…})` deriva el receptor del CFDI original (RFC/nombre EXACTOS, requisito SAT), reusa el motor de `emitir` (que ahora acepta `tipo_comprobante` + `relacionados`; InformaciónGlobal se limita a Ingreso). Endpoint `POST /fiscal/facturas/:uuid/nota-credito`. UI: acción "Nota de crédito" (solo Ingreso vigente) + dialog con editor de conceptos + badge **NC** en la bandeja. Sin migración. | ✅ **código + build api+view verde**; falta redeploy + verificar timbrado NC en vivo |
| **FE.11** | CodAgrupador SAT (contabilidad electrónica 100% válida). Tabla `fiscal.cod_agrupador_map` (cuenta mayor → clave SAT, RLS forzado) + `catalogoXml` la lee (fallback placeholder si sin mapear) + endpoints `cod-agrupador` (list/suggest/PUT/DELETE) + perm `FISCAL_CONTAB_GESTIONAR` + UI: panel editable en `/contabilidad/contabilidad` (tabla mayores, input con datalist de catálogo SAT común, auto-sugerir faltantes, indicador de cobertura). Mig `20260716160000`. **Pólizas XML (PL) diferido** — `analytics.ledger_monthly` es agregado mensual, no tiene detalle póliza-a-póliza (Kepler `kdc2YYMM` sin importar). | ✅ **código + build api+view verde**; **falta aplicar mig `20260716160000` a prod** + redeploy + capturar el mapeo real |

---

## Cómo esto actualiza cada función existente
- **CFDI store** ahora guarda emitidas reales nuestras (rol=emitidas, source=manual), no solo descargadas.
- **DIOT / IVA**: el IVA trasladado cobrado sale de nuestras emitidas.
- **Conciliación**: cruza nuestras emitidas ↔ pedidos ↔ pagos.
- **Maat**: futuros detectores (pedido sin factura, global del día faltante, PPD sin REP).
- **Portal / Comercial / Última Milla**: self-service + auto-factura (Track C).

---

## Arquitectura (lo construido)

- **Puerto** `libs/fiscal/src/lib/emision/pac.port.ts` (`PacPort`, `PacStampResult`, `PAC_PORT`). Adapter `SwPacService` (SW). `PAC_PROVIDER` de facto = sw; Facturama sigue en logística para Carta Porte.
- **Servicio** `EmisionService`: emisor (`fiscal.issuer_config`), folio atómico (`fiscal.invoice_sequences`, patrón `commercial.order_sequences`), armado CFDI 4.0 determinista (IVA 16%, InformaciónGlobal para global), timbrado vía puerto, persistencia reusando `CfdiParserService` sobre el XML timbrado.
- **API** `/fiscal/facturas`: `POST` emitir · `GET` list emitidas · `GET/PUT issuer` · `GET :uuid/xml` · `POST :uuid/cancelar`. Guard `RolesGuard` + `FISCAL_FACTURAR_*`.
- **Frontend** `/contabilidad/facturar` (tab entre CFDI y Conciliación).

## Pendiente operacional para ir a PROD
1. ~~**Aplicar migración** `20260716120000_fiscal_emision` en Railway~~ ✅ **hecho (Batch 124, 2026-07-16)**. Local pendiente solo si se prueba en dev.
2. **Env** del API: `SW_BASE_URL` (`https://services.test.sw.com.mx` pruebas / `https://services.sw.com.mx` prod) + **`SW_TOKEN`** (infinito) **o** `SW_USER`/`SW_PASSWORD`. Cargar el CSD real de Mega Dulces en la cuenta SW (ya está vía Kepler en prod; en el sandbox se cargó el CSD público EKU de pruebas).
3. **Configurar el emisor** en la UI (Facturar → Emisor) con los datos EXACTOS de la CSF de `LOGL851014AQ5` (razón social, régimen, CP).
4. **Re-login** (para que el rol traiga `FISCAL_FACTURAR_*`) + **restart API** (módulo nuevo) + **redeploy view**.

## Decisión abierta
- Formalizar **ADR** del dominio Fiscal-Emisión (número siguiente disponible) + confirmar auth SW definitiva (token infinito vs user/pass) para prod.
