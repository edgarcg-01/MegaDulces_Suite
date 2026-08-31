# Fase CXC — Cartera de clientes / Partidas vivas (Cuentas por Cobrar)

> **Estado:** 🟢 CONSTRUIDO (beta local) · 2026-08-21/22 · **CXC.0–12 ✅** · builds api+view verde · saldo cuadra al peso vs PDF + drill exacto (kdm5) + valor agregado (límite/gerencial/riesgo/contacto/360/proyección/tendencia). Commits: `0825f91f` `c9ffc47e` `0b07d01f` `eb4bfb47` (MVP) · `d0e0394e` (6+8) · `5c07a0ea` (7) · `c9efa7b6` (9) · `0d9e288a` (10-12).
> **CXC.10** proyección de cobranza (cashflow: vencido/≤7d/8-15/16-30/>30d en `/resumen`) + priorización `sort=vencido` (cola de cobranza). **CXC.11** export CSV de la cartera. **CXC.12** snapshots diarios (`analytics.customer_receivable_snapshots`, mig `20260822120000`) capturados por el scanner (@Cron) + `GET /tendencia` + `POST /snapshot-now` + mini-barras de tendencia; habilita histórico real de DSO/vencido. **CXC.13** compromisos de pago (`finance.collection_promises` RLS, mig `20260822130000`): registrar promesa (monto/fecha/nota) en el drill; el scanner marca las vencidas `incumplida` + hallazgo `cxc_promesa_incumplida`. Flujo que Kepler no tiene; escribe SOLO en tablas propias (ADR-016).
> **Estado CXC.0–13 ✅.** Commit CXC.13 `77d66d06`. **Migs pendientes prod (4):** `20260821160000` (tabla + todas las columnas) · `20260821160100` (permiso) · `20260822120000` (snapshots) · `20260822130000` (promesas).
> **CXC.17 ✅ 2026-08-31 — higiene (sin migración):** el drill dice si carga y si falló (antes un error dejaba el diálogo sin abrir, en silencio, con botón Reintentar) · `/resumen` acepta `search`/`vendedor` y el front le pasa la búsqueda, así el panel gerencial habla del mismo universo que la tabla · `colspan` 10→9 en la fila vacía · el scanner usa `set_config('app.tenant_id', ?, true)` en vez de interpolar el uuid en el SQL. **Nota multi-tenant:** la vista estampa el uuid de mega_dulces como literal (convención de toda la capa ODS-derivada, 59 migs) → el `where tenant_id` del service es forma, no aislamiento; queda documentado en el header del service.
> **Valor agregado (más allá del reporte de Kepler):** **CXC.6** límite de crédito (kdud.c15) → uso de línea + flag/KPI sobre-línea + `GET /resumen` gerencial (DSO, %vencido, concentración top-10, cartera por vendedor/zona). **CXC.7** detector de riesgo → bandeja Maat (`finance.findings`): `cxc_cliente_vencido` + `cxc_sobre_limite` (@Cron 08:30 MX + `/scan-now`); se ven en `/finanzas/hallazgos`. **CXC.8** contacto en el drill: teléfono (kdud.c7) → llamar + recordatorio WhatsApp prellenado. **CXC.9** puente 360 CXC↔Cobranza(CC): cobros del cliente + evidencia (ficha/validada en banco) por `cliente_code`.
> **CXC.4** = filtros grupo/zona (decode `kdud.c13`=grupo/`c14`=zona). **CXC.5** = drill EXACTO: `saldo_documento` + `aplicaciones` (jsonb) desde `kdm5` (tipos 7/21/25) reemplazan el FIFO; el detalle muestra los cobros/notas aplicados a cada factura (como el PDF). Fix clave: `doc_code` usa la letra del DOCTYPE (`UD08`/`UA07`, folio digital), NO la naturaleza contable `c29`.
> **Pendiente prod:** aplicar migs `20260821160000` (tabla, incluye grupo/zona/saldo_documento/aplicaciones) + `20260821160100` (permiso) a Railway · correr `import-customer-receivables.js` desde la LAN (lee POS remotos md_01..06 + kdm5 + kdud; local le falta md_03) · re-login · agendar el importer (cron). **Diferido:** vista live sobre `kepler_ods.kdue` · UUID CFDI en el drill (no está en kdue) · verificación visual del `/finanzas/cartera`.
> **Tesis:** replicar la pantalla Kepler **Crédito y cobranza → Estados de cuenta → Partidas vivas** como estado de cuenta de CxC (cada documento a crédito con su **saldo vivo** + aging, por cliente/sucursal/vendedor/zona/grupo). **Read-only sobre Kepler**, espejo exacto del módulo CxP (`supplier-invoice-ledger`, CXP.8): motor computa / humano lee (hereda ADR-016 / ADR-028).
> **ADR propuesto:** ADR-048 — Cartera de clientes: el saldo por partida **NO se materializa en ninguna tabla de Kepler → se COMPUTA** (documentos `kdue` − aplicaciones `kdm5`/cobros `erp_collections`), con la balanza contable (`gl_115`) como cuadre de control. Mismo patrón que CxP contra la 201.

---

## 1. Contexto

La pantalla es un reporte de parámetros de **Partidas vivas**: la **cartera de Cuentas por Cobrar** — cada factura de venta **a crédito** con su **saldo pendiente** y aging, filtrable por sucursal, rango de fecha, cliente, vendedor, zona y **grupo**. El grupo del ejemplo (`1M001 TELEMARKETING LA PIEDAD`) confirma que el uso real es la **cartera del mayoreo/telemarketing** (canal U-A-5), justo lo que hoy no tenemos digitalizado del lado cliente.

Es el **espejo del lado proveedor** que ya construimos en la Fase CXP:
- CxP: `supplier-invoice-ledger` (FIFO por factura) + `supplier-ledger` (saldo corrido) + cuadre contra cuenta **201 (Proveedores)**.
- CxC (esta fase): lo mismo con **cliente** en vez de proveedor, **facturas de venta** en vez de entradas, **cobros** en vez de pagos, cuenta **115 (Clientes)** en vez de 201.

**El cambio de sistema se justifica con:** hoy la cartera solo vive en Kepler (un reporte que hay que imprimir con parámetros manuales); aquí queda como pantalla viva, filtrable, con aging automático, y **cruzada con nuestra evidencia de cobranza** (Fase CC: fichas de depósito + conciliación bancaria). Cierra el 360 de cobranza: quién debe, cuánto, desde cuándo, con qué respaldo entró el pago.

## 2. Mapeo de parámetros (pantalla Kepler → nuestro modelo)

| Parámetro Kepler | Nuestro modelo | Notas |
|---|---|---|
| De / A la sucursal | `sucursal` (kdue.c1) | Cartera es **por sucursal** (kdue vive en cada rama) |
| Desde / Hasta | fecha del documento (kdue.c7) | |
| Incluir doc. **saldados** | `saldo = 0` sí/no | Default "partidas vivas" = solo `saldo > 0` |
| Incluir doc. **cancelados** | filas con `total = 0` / flag | kdue conserva filas canceladas con total 0 |
| Incluir **ventas de contado** | `c4 = 10` (mostrador) | Crédito real = `c4 = 8`; contado neteará ~0 |
| De / A la **moneda** (DLLS→PESOS) | somos peso-only | N/A en beta (ignorar; kdue.c8='PESOS') |
| Ordenar por: Cliente | orden UI | |
| Del / Al **cliente** | `kdue.c2` → `kdud` (nombre/RFC) | c2 = cuenta cliente (`C1012`, `10448`, `CR1021`) |
| **Vendedor** inicial/final | `kdue.c18` (caja/vendedor) o cruce `commercial.customers` | decode c18 en CXC.0 |
| Del / Al **grupo** (1M001 TLMKT) | segmento/escritorio | decode del "grupo" en CXC.0 |
| De / A la **zona** | zona/ruta (`commercial.customers.sales_route`) | cruce comercial |

## 3. Decode de la fuente — VERIFICADO 2026-08-21

Sondeo real sobre los réplicas lógicos locales (`kepler_md_01` = Padre Hidalgo, la sucursal `01` del ejemplo) y `analytics.gl_poliza_lines` (postgres_platform).

### 3.1 `kdue` = registro de documentos de venta CON vencimiento (NO trae saldo)
Sucursal 01: **38,699 filas** (jun–ago 2026). Columnas decodificadas:
- `c1`=sucursal · `c2`=**cuenta cliente** (`CONTADO` genérico, o `C1012`/`10448`/`CR1021` = `kdud.c2`; `kdud.c3`=nombre, `kdud.c10`=RFC) · `c4`=**grupo doc**: `10`=mostrador contado (36,487), `8`=venta crédito (754), `12`, `7`=nota crédito (nat A), `21`/`25`=devoluciones · `c6`=folio · `c7`=fecha doc · `c8`=moneda · **`c10`=fecha de vencimiento** (crédito = c7+9d; contado = c7) · `c11`=`c17`=**total del documento** · `c13`≈IVA · `c18`=caja/vendedor (`10001`/`10002`/`10003`) · `c28`='U' género · `c29`='C' cargo(venta) / 'A' abono(nota/devolución).
- ⚠️ **HALLAZGO CLAVE: `kdue` NO tiene columna de saldo vivo.** `c11 = c17 = total` **siempre** (0 filas con `c11 ≠ c17`); `c12` casi siempre 0 (49 nonzero = interés/moratorio, no saldo). Todas las filas del cliente conservan su total **original**, incluidas las ya cobradas. Es el registro de **documentos**, no de saldos.
- ✅ **Pero es la ÚNICA fuente con `fecha de vencimiento` (c10) y granularidad por documento** — imprescindibles para aging real ("partidas vivas").

### 3.2 `kdm5` = aplicaciones (un documento aplica $ a otro) — NO replicado aún
Sucursal 01: 566 filas. `c1`=suc · `c2/c3/c4/c5`=tipo del **aplicador** (ej. `U-A-7`=nota crédito) · `c6`=folio aplicador · `c8/c9/c10`=tipo del **aplicado** (`D-8`=venta crédito) · **`c11`=folio del documento aplicado** · `c12/c13`=**importe aplicado** · `c14`=estado (`EMBARCADO`). → es la tabla que **reduce el saldo** de cada partida (notas/devoluciones, y a confirmar: cobros). **NO está en el set de replicación ODS** (`kdue` sí, `kdm5` no) → hay que agregarla.

### 3.3 `gl_115` (cuenta Clientes, contable) = control total, no grid por-partida
`analytics.gl_poliza_lines cuenta_mayor='115' source='kepler'` (local solo 2026-05..07): **C** (cargo=factura/deuda) 7,726 filas $202M vs **A** (abono=cobro) 10,244 filas $166M → **saldo neto $36.1M / 809 refs**. Pero `referencia` = **texto libre** (nombre de cliente o "P.V. Sucursal Canindo"), domina **CONTADO $28.2M** (netea ~0 con lag), y está centralizado en sucursal `00`. Sirve como **cuadre de control agregado**, no para el aging por documento.

### 3.4 `erp_collections` (cobros UA0501) = las aplicaciones de cobro (ya lo tenemos)
Vista viva sobre `kepler_ods.kdm1`: **23,771 cobros / $369.5M**, centralizado CEDIS, 109 cuentas. Es el equivalente a `erp_supplier_payments` del lado CxP.

### 3.5 Veredicto de fuente (la decisión que pediste investigar)
**El saldo por partida no existe como columna — se computa. Y `kdue` es AUTOSUFICIENTE para computarlo** (VERIFICADO contra el PDF real de Kepler, 2026-08-21 — ver §3.6). `kdue` guarda **tanto las facturas (cargo) como las aplicaciones (abono) como filas separadas**, todas con su `c11`:

| c4 | c29 | Etiqueta en el reporte | rows (md_01) | Rol |
|---|---|---|---|---|
| 8 | C | **Factura Telemarketing** (crédito, `UD08`) | 754 | cargo |
| 10 | C | **Ticket Contado Caja N** (`UD05`/mostrador) | 36,494 | cargo (contado) |
| 12 / 13 | C | otras ventas | 927 | cargo |
| 7 | A | **Cobro CFDI** (`UA07`) | 344 | abono |
| 21 | A | **Nota Créd/Dev TeleMarket** (`UA21`) | 127 | abono |
| 25 | A | devolución (`UA25`) | 60 | abono |

```
saldo_cliente  = Σ(c11 · signo)   signo = +1 si c29='C' (cargo),  −1 si c29='A' (abono)
partida viva   = saldo_documento > 0        aging por c10 (vencimiento)
cross-check    = saldo por cliente  vs  gl_115 neto (opcional, como CxP vs 201)
```

- **Cartera + saldo + aging por cliente = `kdue` SOLA.** Sin `kdm5`, sin `erp_collections`.
- **`kdm5` solo se necesita para el DRILL por-factura** (mostrar qué cobro/nota aplicó a cada factura = las líneas "Cobro CFDI" indentadas bajo cada factura + el "Saldo del documento").
- **Corrección vs la hipótesis inicial:** el cobro a nivel SUCURSAL es **`UA07` "Cobro CFDI"** (dentro de `kdue`), **NO `UA0501`** (eso es la representación centralizada en CEDIS de `erp_collections`). `erp_collections` **queda fuera del camino crítico** de este reporte.
- `gl_115` pasa de "cross-check necesario" a **opcional** (kdue ya cuadra solo).

### 3.6 VERIFICACIÓN contra el PDF real de Kepler (2026-08-21) — CUADRA AL PESO
`Reporte de partidas vivas`, sucursal 01, grupo 1M001, ago-2026 (93 págs). Reproduje el `saldo_cliente` desde `md.kdue` (Σ c11 con signo por c29) para 8 clientes y **coincide exacto** con el "Saldo total" del PDF:

| Cliente | `kdue` calc | PDF |
|---|---|---|
| 10001 | 4,306.66 | 4,306.66 ✓ |
| C1012 | 85,614.57 | 85,614.57 ✓ |
| C1047 | 194,316.40 | 194,316.40 ✓ |
| C1083 | 299,274.94 | 299,274.94 ✓ |
| C1088 | 12,358.17 | 12,358.17 ✓ |
| C1100 | 0.00 | (en blanco) ✓ |
| C1101 | 53,785.00 | 53,785.00 ✓ |
| CR1021 | 124,912.88 | 124,912.88 ✓ |

8/8 exacto. El PDF también fija el layout objetivo de la UI: por cliente, tabla `Sucursal · Descripción · Folio · Fecha · Referencia · Abono · Cargo · Vencimiento · Folio digital · UUID`, con la factura y sus cobros/notas indentados + "Saldo del documento" + "Saldo total" del cliente. El **folio digital** (`01UD0801-XXXX` = suc+doctype+folio) y la **UUID CFDI** salen de `kdue`.

## 4. Estado actual (qué ya existe)

| Pieza | Estado |
|---|---|
| Cobros `analytics.erp_collections` (UA0501, vista viva) | ✅ |
| Catálogo `analytics.erp_customers` (code/name/rfc/city, vista viva sobre `kdud`) | ✅ (sin zona/vendedor/grupo) |
| Contable `analytics.gl_poliza_lines` cuenta 115 | ✅ (control total) |
| Zona/ruta/vendedor por cliente `commercial.customers.sales_route` + `vendor_cartera` | ✅ (cruce) |
| **Patrón a copiar**: `supplierInvoiceLedger`/`supplierLedger` (CXP.8) | ✅ `libs/commercial/.../purchase-adjustments.service.ts` |
| Evidencia de cobranza (fichas + conciliación banco) Fase CC | ✅ `/finanzas/cobranza` |
| **`kdue` en el ODS** (documentos con vencimiento) | ⚠️ replicado a prod `kepler_ods.kdue`, **sin consumir** |
| **`kdm5` en el ODS** (aplicaciones) | ❌ **no está en el set de replicación** |
| Módulo/endpoint CxC (customer-ledger, aging, cartera) | ❌ no existe |

## 5. Plan por sprints

- **CXC.0 — Decode fino (ruta crítica menor; el saldo YA está verificado §3.6).** Falta solo: decode del **"grupo"** (1M001 TLMKT) y de la **zona** (`kdud` — hoy no en `erp_customers`), y confirmar `c18`=vendedor. `kdm5` (linkage cobro→factura, para el drill) se agrega al set de replicación ODS (`KP_ODS_TABLES`/`ODS_CTID_TABLES`) — **ya no es bloqueante del saldo**, solo del drill por-factura.
- **CXC.1 — Vista derive-no-copy `analytics.customer_receivables`.** Fila por documento de `kepler_ods.kdue`: `(sucursal, doc_tipo, doc_label, folio, cliente_code, fecha, vencimiento, importe, cargo_abono, saldo_documento, aging_bucket, folio_digital, uuid)`. `saldo_cliente` = Σ importe con signo por `cargo_abono` (VERIFICADO cuadra al peso). **No copia** (patrón `erp_collections` vista viva). Enriquecida con nombre/RFC (`erp_customers`) y zona/vendedor/grupo (`commercial.customers` + decode CXC.0). `kdm5` alimenta el drill por-factura (qué cobro aplicó a cuál), no el saldo.
- **CXC.2 — Backend `libs/finance/customer-ledger`.** `GET /finance/receivables` (cartera con **todos los filtros del reporte** = sucursal/fecha/cliente/vendedor/zona/grupo/incluir-saldados/incluir-contado) + KPIs (total vivo, vencido, por bucket) · `GET /finance/receivables/:cliente` (auxiliar: saldo corrido + FIFO cobros vs facturas, calcado de `supplierInvoiceLedger`) + cuadre contra `gl_115`. Permiso nuevo `FINANCE_RECEIVABLES_VER` (recipe de 6 touch-points; ancla a `FINANCE_BANK`). Smoke `test-newdb-customer-receivables`.
- **CXC.3 — Frontend `/finanzas/cartera`.** Operations DESIGN-compliant (leer `DESIGN.md` + `tokens.css`): tabla densa + master-detail (fila = cliente con saldo/vencido; drill = sus partidas vivas con aging), MetricStrip de KPIs, filtros = parámetros del reporte, export CSV. Calca `/compras/cuadre-proveedor`. Link cruzado a `/finanzas/cobranza` (evidencia del cobro).
- **CXC.4 (opcional) — Aging report + antigüedad de saldos.** Buckets 0-30/31-60/61-90/90+ por cliente/zona/vendedor (el hermano "Antigüedad de saldos" del mismo menú Kepler). Alimenta un detector Maat `cliente_vencido` (hereda patrón `finance.findings`).

**MVP = CXC.0–CXC.3.**

## 6. Riesgos / decisiones abiertas

1. **kdm5 y cobros**: si UA0501 no liga estructural en kdm5, el saldo por-documento usa FIFO (aproximación aceptada, igual que CXP.8; el cuadre agregado vs gl_115 lo valida). Confirmar en CXC.0.
2. **Centralización**: cobros centralizados en CEDIS (`md_00`) vs facturas por-sucursal (`kdue` en cada rama) — el FIFO de cobros debe agrupar por cuenta-cliente, no por sucursal. Verificar cómo casan cuentas TLMKT (c10 desk) con las cuentas `Cxxxx` de sucursal.
3. **"Grupo" y "zona"**: no decodificados aún (CXC.0). Fallback = derivar de `commercial.customers.sales_route`.
4. **Alcance beta**: multi-moneda (DLLS) fuera; empezar peso-only.
5. **Sin escritura a Kepler** (ADR-016): la plataforma lee y agrega; nunca aplica cobros ni cancela partidas en el ERP.

## 7. Relacionado
- Patrón espejo: `docs/IMPLEMENTACION/FASES/FASE_CXP_PAGOS.md` (CXP.7/8/9 = estado de cuenta proveedor).
- Cobranza / evidencia: `docs/IMPLEMENTACION/FASES/FASE_CC_COMPROBANTES_COBRANZA.md`.
- Conciliación bancaria: `docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md`.
- ADR-016 (motor decide / LLM fuera del dinero), ADR-028 (Maat), ADR-046 (ingesta canónica / derivar-no-copiar).
