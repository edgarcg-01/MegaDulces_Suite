# Revisión de Control — Finanzas: hallazgos + tablas de origen

> Doc de trabajo para **revisar detalladamente cada módulo de Finanzas**. Reúne, por módulo:
> (1) qué controla, (2) las **tablas fuente** en cada sistema (Kepler ERP, Caja/Base Movimientos Access,
> ContPAQi, y los espejos `analytics.*`/`finance.*` de la plataforma), y (3) los **hallazgos de control**.
> Estado a 2026-08-12. Marcar cada hallazgo al revisarlo: ⬜ por revisar · 🔎 en revisión · ✅ confirmado · ❌ descartado.

---

## 0. La cadena del dinero (marco de referencia)

Todo el control de ingresos y egresos se ordena sobre una sola cadena, de lo **físico/operativo** a lo **fiscal/contable**:

```
INGRESO:  Venta (POS) → CAJA (arqueo + venta diaria) → DEPÓSITO → BANCO (estado cuenta) → KEPLER 102 (tesorería) → ContPAQi (libros)
EGRESO:                 Compra/Gasto → PAGO (Kepler XD26/XD25) → BANCO (retiro) → KEPLER 102 → ContPAQi
```

**5 canales de verdad** (cada uno responde algo distinto; el gap entre canales = señal de control):

| Canal | Sistema / tabla | Naturaleza | Grano | Llave |
|---|---|---|---|---|
| **Venta** | Wincaja / Kepler POS | operativo | por tienda/ticket | — |
| **Caja** | Base Movimientos Access (`.245`) → `analytics.caja_*` | operativo **no-fiscal** | por sucursal | nombre de banco |
| **Banco** | Workbook Excel/Sheet → `finance.bank_movements` | real financiero | por cuenta | `account_label` |
| **Kepler tesorería** | `md.kdm1`/`kdb1` → `analytics.kepler_bank_movements` | operativo ERP | por sucursal **y** cuenta | `clave_banco`→`account_label` |
| **ContPAQi** | SQL Server `.35` → `analytics.contpaqi_*` | **fiscal/libros** | consolidado (~2% por sucursal) | cuenta `102xxx` |

> **Kepler tesorería es el HUB**: único canal con las dos llaves a la vez (número de cuenta *y* por sucursal). Puentea el extremo operativo (Caja) con el fiscal (ContPAQi) sin perder grano. Ver §3.

---

## 1. Mapa de tablas por sistema

### 1.1 Kepler ERP (Postgres sucursales `.245`, `postgres/kepler123`; DBs `md_00`..`md_05`, `kp.*` concentrada)

| Tabla | Qué es | Columnas clave de control |
|---|---|---|
| `md.kdm1` | **Encabezado de movimiento / tesorería** (≈200 cols) | `c1`=sucursal · `c2/c3/c4`=género/naturaleza/grupo (tipo doc) · `c6`=folio · `c9`=fecha-valor · `c16`=importe (siempre +) · `c24`=concepto · `c31`=método (Tra/Che/Cob/Ant) · `c32`=beneficiario · **`c45`=clave banco** (=kdb1.c1) · `c47`=destino traspaso · `c43`='C'=cancelado · **`c68`=fecha captura** |
| `md.kdm2` | Líneas del movimiento | `c7`=línea · `c8`=SKU · `c9`=cantidad · `c10`=nombre · `c12`=costo · `c13`=importe |
| `md.kdb1` | **Catálogo cuentas de banco** | `c1`=clave · `c2`=nombre · `c5`=cuenta contable `102-XXXX` · `c9`=RFC. banco/caja = `c5 LIKE '102%'` |
| `md.kdc2YYMM` | **Pólizas contables** (partida doble) | `c3`/`c5`=cuenta mayor. **Postea 100% a `102` pelón — NO desglosa por banco** (el desglose vive en kdm1) |
| `md.kdii` / `kdil` / `kdik` | productos / existencia / costo | (referencia; no finanzas directo) |
| `md.kdpv_folio_caja` | corte de caja POS | folio de caja |

**Tipos de documento kdm1 relevantes a Finanzas** (género-naturaleza-grupo):

| Doc | Significado | Dirección | Uso en control |
|---|---|---|---|
| `U-A-5` / `UA0501` | Cobro (PUE) — C 102 / A 115 | entrada | cobranza; `analytics.erp_collections` |
| `X-A-45` | (entrada tesorería) | entrada | ingreso |
| `X-D-26` / `XD2601` | Pago proveedor **transferencia** | salida | pago; `erp_supplier_payments` |
| `X-D-25` / `XD2501` | Pago proveedor **cheque** | salida | cheques en tránsito |
| `X-D-60` / `XD6001` | **Anticipo** a proveedor | salida | pago |
| `N-A-26` | Traspaso entre bancos | 2 piernas (−c45 origen / +c47 destino) | traspaso interno |
| `X-A-20` / `XA2001` | Orden de entrada (recepción) | — | compras/recepción |
| `X-D-40` / `X-D-55` | Devolución compra / Nota crédito | — | ajustes recepción |

### 1.2 Caja — Base Movimientos Access (`\\192.168.0.245\D` = `Z:`)

Ver [`reference_movimientos_finanzas_access`]. Dos sistemas:

**A) Arqueo de caja** — `BMovimientosCajas.mdb` (backend). Solo caja **20** viva (29.6k, 2013→hoy); 70 murió jun-2024.
- `0 T Movimientos`: cada arqueo/retiro/corte/depósito/fondo con **desglose por denominación** (B1000..Centavos) + totales por forma de pago + `MovimientoTotal`. Tipos: 1=Arqueo 2=Retiro 3=Corte 4=Depósito 5=Fondo.

**B) Base Movimientos SI/NO** — `Base Movimientos {SI,NO}.mdb` (SI operativa, NO nómina; entidad real = col `Empresa`, no el folder).
- `4 T VentasDiarias` (38.9k): **venta del día por sucursal** partida por forma de pago (Efectivo/Morralla/Cheques/Tarjeta/CajaChica/SobreGiro), cada una con contraparte `*Deposito`. `Desglose`.
- `4 T VentasDiarias 1 Depositos` (218k): **ledger de cada depósito bancario** — `BancoDepositado`, `BancoCuenta`, `FechaDeposito` vs `FechaDepositoReal`, `TotalDeposito` vs `TotalDepositoReal`, `Comision`, `IVA`.
- `1 T Compras` · `2 T Gastos` · `3 T Transferencias` · `6 T Nomina` · `8 T Conciliacion` (VACÍA — la concilia el workbook, no aquí).
- Catálogos: `0 T Tipos Bancos` (crosswalk a bancos), `0 T Tipos Pagos`, `0 T Sucursales`, `0 T Almacenes`.

### 1.3 ContPAQi (SQL Server 2022, instancia `COMPAC` @ `192.168.0.35`, RO `platform_ro`)

Ver [`project_fase_cp_contpaqi`]. Empresa única `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ` (persona física, consolidada).
- Balanza mensual · Pólizas (`MovimientosPoliza`, join CFDI por `AsocCFDIs.GuidRef=MovimientosPoliza.Guid`) · Bancos (Egresos/Cheques **muertos desde 2019** → ledger vivo = movs de póliza en `102xxx`) · Proveedores (RFC → EFOS 69B).

### 1.4 Plataforma — `analytics.*` (espejos read-only, SIN RLS, filtro tenant explícito)

| Tabla | Fuente | Módulo |
|---|---|---|
| `analytics.kepler_bank_movements` | md.kdm1/kdb1 | Bancos, Caja (hub) |
| `analytics.caja_ventas_diarias` / `caja_depositos` / `caja_arqueos` | Base Movimientos | Caja General |
| `analytics.caja_bancos_catalog` / `caja_sucursales_catalog` | Base Movimientos catálogos | crosswalk |
| `analytics.contpaqi_ledger_monthly` / `contpaqi_bank_movements` / `contpaqi_suppliers` | ContPAQi | Bancos vs ContPAQi, Fiscal |
| `analytics.gl_poliza_lines` | Kepler kdc2 + ContPAQi | Pólizas, conciliación |
| `analytics.erp_collections` | Kepler UA0501 | Cobranza |
| `analytics.erp_supplier_payments` / `erp_goods_receipts` | Kepler XD26/XA20 | Pagos, Compras |

### 1.5 Plataforma — `finance.*` (operativo, RLS forzado vía `TenantKnexService.run()`)

| Tabla | Módulo |
|---|---|
| `finance.bank_accounts` · `bank_movements` · `bank_statements` · `bank_recon_matches` · `movement_categories` · `bank_classify_rules` | Bancos (CB) |
| `finance.collection_deposits` | Cobranza |
| `finance.supplier_payment_proofs` · `goods_receipt_proofs` | Pagos / Recepción |
| `finance.payment_program` | Programa de Pagos |
| `finance.findings` · `proposed_actions` | Hallazgos (Maat) |
| `finance.knowledge` | Maat chat |

---

## 2. Llaves de join / crosswalks

| De → A | Llave | Estado |
|---|---|---|
| Kepler tesorería `clave_banco` → cuenta | `kdb1.c5` = `102-XXXX` = `account_label` | ✅ en feed (`analytics.kepler_bank_movements.account_label`) |
| Banco (CB) `bank_accounts` ↔ Kepler | `account_label` (`kepler_link`) | ✅ CB.28 |
| Banco (CB) ↔ ContPAQi | `bank_accounts.contpaqi_cuenta` (102xxx) | ✅ CP.2 |
| **Caja `banco_code` → cuenta** | `caja_bancos_catalog.bank_account_label` | ❌ **NULL — pendiente** (hoy conciliación fuzzy por nombre) |
| Caja depósito ↔ Kepler tesorería | (sucursal + monto + fecha) — **no hay id compartido** | ❌ pendiente (sprint de match de depósitos) |
| CFDI ↔ póliza | `AsocCFDIs.GuidRef = MovimientosPoliza.Guid` | ✅ |

> **El enganche crítico** es poblar `caja_bancos_catalog.bank_account_label` **vía Kepler tesorería** (el hub): mata la conciliación fuzzy-por-nombre y habilita el cuadre 4 vías exacto.

---

## 3. Hallazgos de control transversales (checklist de revisión)

| # | Hallazgo | Impacto | Estado |
|---|---|---|---|
| H1 | **Kepler contabilidad (kdc2) NO desglosa por banco** — postea 100% al `102` pelón. El desglose por banco solo vive en tesorería (kdm1/kdb1). | Bancos debe leer kdm1, no kdc2, para atribuir por banco | ⬜ |
| H2 | **Bancos hoy solo concilia EGRESOS** — "ingresos = memo" (sin contra-lado). Caja General provee el contra-lado del **depósito de tienda**. | El ~50% del estado de cuenta (ingresos) estaba sin conciliar | ⬜ |
| H3 | **Caja explica solo ~11% del ingreso bancario** (ene-2026: $9.5M de ~$89M). El grueso es **cobranza + transferencias de cliente** → requiere el cruce con Cobranza para cerrar el memo. | El memo se descompone, no desaparece con solo Caja | ⬜ |
| H4 | **Descuadre venta→depósito ~$11.1M (ene-2026)** — venta $25.4M vs depositado $14.3M (columnas) / $9.5M (ledger). Las 3 vistas no coinciden. | Fuga de efectivo / rezago — señal de fraude | ⬜ |
| H5 | **Kepler captura menos que el banco** (ej. 6544 movs banco vs 3208 docs Kepler). | Gap de captura del ERP = señal, no bug | ⬜ |
| H6 | **Cheques en tránsito** (Kepler emite X-D-25 pero banco no cobró). | Gap de timing banco↔Kepler | ⬜ |
| H7 | **ContPAQi consolidado** (~2% por sucursal) → Caja↔ContPAQi solo cuadra **agregado/por banco**, no por tienda. | El gap fiscal (operativo vs libros) se mide consolidado | ⬜ |
| H8 | **ContPAQi Egresos/Cheques muertos desde 2019** → el ledger vivo es movs de póliza en `102xxx`. | No usar tablas de bancos de ContPAQi directas | ⬜ |
| H9 | **`Desglose` de Base Movimientos NO es el descuadre real** (= −VentaDiariaTotal). Calcular descuadre de tenders vs depósito. | No exponer `Desglose` como descuadre | ⬜ |
| H10 | **Fechas basura** en la fuente Access (año 0130..8020) → guardar rango 2009-2027. | Ruido si no se filtra | ✅ (importer ya filtra) |
| H11 | **Gap fiscal estructural ~$12M/mes** (libros vs operación, Maat `maat_libros_vs_operacion`). | El número de riesgo — Caja↔ContPAQi lo aterriza | ⬜ |

---

## 4. Módulos de Finanzas — revisión detallada

Para cada módulo: **qué controla · tablas fuente · hallazgos · estado · pendientes**.

### 4.1 Bancos (`/finanzas/bancos`) — 10 apartados

**Controla:** el estado de cuenta bancario, su clasificación, y el cuadre contra Kepler/ContPAQi. Fuente: `finance.bank_*` + `analytics.kepler_bank_movements` + `analytics.contpaqi_*`.

| Apartado | Qué hace hoy | Hallazgos / pendientes |
|---|---|---|
| **Comparador** (Excel↔Kepler) | movs banco vs pólizas 102 con match_key | agregar Caja + ContPAQi (par operativo↔fiscal). H1, H7 |
| **Cierre** (saldos) | inicial+dep−ret=final + "¿por qué no cuadra?" | descomponer depósitos: explicado por Caja vs sin origen. H2 |
| **Movimientos** | grid + drill `flow` (cadena compra→pago) | `flow` de ingreso debe llegar a Caja (origen). H2 |
| **Concentrado** | pivote cuenta×grupo | sub-split de Ingresos (Caja/Cobranza/otros). H3 |
| **Conciliación** | **solo egresos** (retiro↔pago Kepler); ingresos=memo | conciliar ingresos (banco↔Caja). H2, H3 — *el cambio grande* |
| **vs ContPAQi** | Banco↔ContPAQi (libros) + huérfanos | sin cambio estructural. H8 |
| **Cuadre 3 vías** | Workbook/Kepler/ContPAQi por cuenta | → 4 vías en ingresos (+Caja). H1 |
| **Cuentas** | catálogo + saldos | **enlace `bank_account_label` vía Kepler** — desbloquea todo. §2 |
| **Capturas WhatsApp** | captura de fichas | sin cambio |
| **Admin** | categorías/reglas/cuentas/enlace ContPAQi | + sección "Enlace Caja" |

### 4.2 Caja General (`/finanzas/caja`) — NUEVA (CG.0-5)

**Controla:** venta diaria→depósito por sucursal, arqueo por denominación, conciliación 3 vías (Caja/Workbook/Kepler).
**Fuente:** `analytics.caja_ventas_diarias` · `caja_depositos` · `caja_arqueos` · catálogos. 286k filas en prod.
**Hallazgos:** H2 (es el contra-lado de ingresos), H4 (descuadre = fuga), H9 (Desglose ≠ descuadre).
**Pendientes:** crosswalk `bank_account_label` (§2), instancia NO, bandeja de fugas, arqueo vs venta del día. **Deploy pendiente** (código no pusheado).

### 4.3 Cobranza (`/finanzas/cobranza`)

**Controla:** ficha de depósito + OCR ligada al cobro Kepler `UA0501`. Fuente: `finance.collection_deposits` + `analytics.erp_collections`.
**Hallazgo:** H3 — la ficha de Cobranza y `caja_depositos` son el **mismo evento** visto de dos lados; cruzarlos cierra "cobré→deposité→entró al banco". **Es el módulo que cierra el memo de ingresos** junto con Caja.

### 4.4 Pagos a proveedor (`/finanzas/pagos-comprobantes`)

**Controla:** pagos a proveedor (XD26 transfer / XD25 cheque / XD60 anticipo) + comprobante. Fuente: `analytics.erp_supplier_payments` + `finance.supplier_payment_proofs`. **Eje EGRESOS** — poca interacción con Caja.

### 4.5 Programa de Pagos (`/finanzas/programa-pagos`)

**Controla:** ejecución de pagos de Tesorería (espejo Excel) vs Kepler. Fuente: `finance.payment_program`. **Eje EGRESOS** — sin cambio por Caja.

### 4.6 Hallazgos / Maat detector (`/finanzas/hallazgos`)

**Controla:** motor de detección → `finance.findings` (triage + feedback L2). **Mayor upside con Caja:** detectores nuevos — venta sin depósito (H4), depósito sin venta, arqueo cancelado sospechoso, comisión anómala, banco con ingreso sin depósito de caja.

### 4.7 Maat chat (`/finanzas/maat`)

**Controla:** chat tool-use (números del motor, no del LLM). Nuevas tools: `maat_caja_conciliacion`, `maat_venta_vs_deposito`, `maat_arqueo`.

### 4.8 Egresos contables (`/finanzas/egresos`) · Tareas · Reembolsos · Comprobación

Eje EGRESOS / gastos (GX). Sin cambio por Caja; Tareas puede generar items desde descuadres de caja.

---

## 5. Orden de revisión sugerido

1. **Bancos › Cuentas** — verificar catálogo + preparar enlace `bank_account_label` vía Kepler (§2). Desbloquea el resto.
2. **Bancos › Conciliación** — confirmar H2 (solo egresos hoy) y diseñar el cuadre de ingresos banco↔Caja.
3. **Caja General › Conciliación** — validar la 3 vías (ya construida) contra los números reales.
4. **Cobranza** — confirmar H3 (cruce ficha↔caja_depositos↔banco) para cerrar el memo.
5. **Hallazgos** — priorizar detectores de fuga (H4).

---

## 6. Preguntas abiertas

- ¿El match Caja↔Kepler tesorería se hace por (sucursal+monto+fecha) o conviene otro criterio?
- ¿ContPAQi consolidado permite algún desglose por sucursal aprovechable, o se asume 100% agregado?
- ¿Cobranza (fichas) y Caja (`caja_depositos`) se unifican en una sola tabla de "depósitos" o se cruzan como fuentes separadas?
- Instancia **NO** de Base Movimientos (nómina + 2ª entidad): ¿entra al alcance de control o queda fuera?

---

> **Fuentes verificadas en sesión 2026-08-12:** decode Base Movimientos (§1.2), conciliación 3 vías ene-2026 (H3, H4), feed `kepler_bank_movements` (§1.1). El resto proviene de las memorias de referencia del proyecto (verificadas al escribirse) y debe re-confirmarse contra la BD durante la revisión módulo por módulo.
