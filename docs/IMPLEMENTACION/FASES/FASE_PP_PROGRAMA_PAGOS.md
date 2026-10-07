# Fase PP — Programa de Pagos / Tesorería

> **Tesis:** el Excel "PROGRAMA PAGOS 2026" es el **libro de ejecución de pagos** que falta en la
> plataforma. Integrarlo cierra el triángulo de Cuentas por Pagar:
> **Deuda** (cuánto se debe: 201 Kepler + 2120 ContPAQi) → **Programa** (qué se paga, a quién, de qué
> banco, cuándo) → **Banco** (qué salió: CB). Read-first (importer idempotente), luego captura en app.
> Mismo patrón que CB y Compras 360. Hereda ADR-016/028 (motor decide, LLM fuera del camino del dinero).

## Fuente

`C:\Users\Sistemas\Downloads\PROGRAMA PAGOS 2026 (1).xlsx` (Tesorería, manual).
- Hoja `PROVEEDORES` (289): NOMBRE · FISCAL/REMISIÓN · DÍAS DE CRÉDITO · DESCUENTO PP (llenado parcial ~24/5).
- 8 hojas mensuales (0126…AGOSTO 2026): 1 fila/pago. Headers CAMBIAN mes a mes (17→50 cols).
  Campos: FECHA · ALMC (sucursal) · TIPO (C compra/G gasto) · MOVIM/TRANFER (CH-####/trans/factoraje/
  anticipo/5###) · PROVEEDOR/CONCEPTO · F. FACTURA (f-###) · $TOTAL/$VALOR · BANCO (BBVA/Bajío/Banorte/
  Santander/Factoraje) · FECHA COBRO/PAGO · KEPLER (true/false, jul/ago). ~300-400 pagos/mes, $45-55M/mes.

## Crosswalk (lo que tenemos ↔ Excel)

| Excel | Nuestra fuente | Uso |
|---|---|---|
| PROVEEDOR (texto) | catalog.suppliers, 201 referencia, contpaqi_suppliers (RFC) | resolver supplier_id (token+RFC) |
| F. FACTURA (f-###) | erp_goods_receipts.folio, gl folio, expense_doc_chain | ligar pago→factura→recepción |
| $TOTAL | erp_supplier_payments, 201 XD2601/XD2501 | conciliar monto |
| BANCO | finance.bank_accounts + bank_movements (CB) | casar con estado de cuenta |
| MOVIM | erp_supplier_payments.metodo_pago | método |
| FECHA / F.COBRO | payment/clearing date | timing + flujo de caja |
| KEPLER true/false | ¿existe póliza XD2601 en gl_poliza_lines? | flag "pagado no registrado" |
| PROVEEDORES.DÍAS CRÉDITO | (nuevo) suppliers.credit_days — o Kepler c30 | timing de pago |
| PROVEEDORES.DESCUENTO PP | (nuevo) suppliers.pp_discount_pct | decisión pronto-pago |

## Schema (finance.*, RLS forzado)

- `finance.payment_program` — 1 fila/pago: source_month, client_uuid (idempotencia UPSERT), pay_date,
  clearing_date, supplier_id (NULL)+supplier_text, sucursal_code, tipo, method, method_ref,
  bank_account_id (NULL)+bank_text, amount, invoice_folios, kepler_flag, concepto, recibio,
  bank_movement_id (recon diferido), audit.
- `catalog.suppliers` += credit_days, pp_discount_pct, invoice_type (idempotente hasColumn).

## Sprints

- **PP.0** decode + schema + importer `import-payment-program.js` (exceljs, headers tolerantes, UPSERT
  por client_uuid, resolución de proveedor token+RFC). **Ruta crítica.**
- **PP.1** términos de proveedor → suppliers (credit_days/pp_discount/invoice_type); completar gaps con
  Kepler c30.
- **PP.2** backend `libs/finance/payment-program` (list+filtros+KPIs+per-pago) · perms FINANCE_PAYMENTS_*.
- **PP.3** frontend `/finanzas/programa-pagos` (Operations, tabla densa/mes + KPIs banco/método/tipo + chip KEPLER).
- **PP.4** conciliación programa↔Kepler XD2601 (verifica kepler_flag) + programa↔banco (CB) → finance.findings
  (pagado-no-registrado / programado-sin-salida / pago-sin-factura). Tolera lag del mes en curso.
- **PP.5** forward-looking: de bitácora a **planificador** — proyecta pagos desde deuda (2120 aging) ×
  días de crédito → calendario + flujo de caja proyectado por banco/semana.
  **✅ Absorbido por la Fase TP (Calendario de Pagos, ADR-064, 2026-09-14)** — construida completa en
  [`FASE_TP_CALENDARIO_PAGOS.md`](FASE_TP_CALENDARIO_PAGOS.md). PP sigue siendo la bitácora
  retrospectiva (lo ya pagado, del Excel); TP es la mitad prospectiva (capacidad por día + asignación +
  preparación de ejecución), con sus propias tablas (`budget.*`, `finance.payment_allocations`, etc.) —
  no reutiliza `finance.payment_program` porque ese es un espejo de EJECUCIÓN histórica, no un registro
  de obligaciones autorizadas con saldo pendiente.
- **PP.6** Maat: tool `maat_programa_pagos` + detectores (duplicado, EFOS pagado, concentración banco, PP desaprovechado).
- **PP.7 ✅ 2026-10-05** — *la pantalla declara de cuándo son sus datos.* Medido en prod: último mes
  cargado **2026-08**, último write del importer **2026-08-08** (58 días), y **cero** menciones de
  frescura en el componente y el service. Dos eslabones con `composeFreshness` (`pp_cobertura` = hasta
  qué mes de negocio llega el libro, que es el que manda; `pp_import` = cuándo entregó), tolerancia 30
  días por ser libro mensual, `FRESHNESS_UNKNOWN` si la medición falla. Más `GET /cobertura` con los
  **meses faltantes enumerados** — sin eso un mes ausente es invisible dos veces: el filtro de Mes se
  arma desde lo cargado y en los totales llega como cero. `coberturaLibro()` pura + spec 9/9 con 4
  pruebas negativas y el borde de año. Detalle en el tracker.
- **PP.8 ⬜ RUTA CRÍTICA** — *que alguien cargue el libro.* PP.7 hace visible el problema; no lo
  resuelve. Hoy `import-payment-program.js` lee un `.xlsx` desde `C:/Users/Sistemas/Downloads/` a
  mano, **sin agenda y sin latido**, así que su estado normal es congelado. Dos salidas, ninguna
  inventada: (1) subida web del libro, calcando `POST /finance/bank-captures/upload` de CBW.8 — es el
  mismo gesto que Tesorería ya hace con la ficha de depósito; o (2) carril agendado con
  `cron-heartbeat` + umbral en `CRON_JOBS`, si el archivo vive en una ruta estable de `Z:`.
  ⚠️ Lo que NO se puede dejar como está: el libro es **el único lugar de la plataforma** donde existen
  la forma de pago real y los folios de factura cubiertos por cada pago.

MVP = PP.0 + PP.2 + PP.3.

---

## Lo que esta fase descubrió sobre el proceso de pago (2026-10-05)

Investigando el circuito de **pago de órdenes de entrada** (el que hoy pasa por el Access `Control`),
el Excel de Tesorería resultó ser el eslabón que faltaba. Lo medido, para que no se vuelva a
descubrir:

- **Un pago cubre VARIAS facturas.** `F. FACTURA = f-852-853-854`. De 1,677 pagos: 583 cubren una
  factura y **296 cubren de 2 a 6+**. Es la razón estructural de que los conteos de Kepler y Control
  no cuadren nunca: cada sistema desagrupa a su criterio.
- **La columna `KEPLER` (True/False) es Tesorería llevando a mano el control de la doble captura.**
  Ya saben que el problema existe.
- ⛔ **El folio `f-###` NO se puede ligar al folio de la orden de entrada.** Probado con placebo:
  match real **86.7 %** contra **83.7 %** de números aleatorios — 3 puntos, o sea ruido. El folio de
  entrada es de 3-4 dígitos y se reusa por sucursal. Además sólo 267 de 952 casan con UNA sola
  entrada. *No volver a intentarlo por número.*
- **CFDI ↔ entrada por RFC + monto exacto ± 15 d:** señal 16.3 % contra placebo 4.9 % (3.3×) — real,
  pero cubre apenas el **7.8 %** de las entradas, porque **5,987 de 11,480 entradas (52 %, $189.2M)
  no tienen RFC**.
- ⭐ **El criterio de "a quién se le paga en efectivo", que nadie tenía escrito:** es si el proveedor
  **factura o no**. De los 109 proveedores que siempre cobran en efectivo, **uno solo emite CFDI**
  (contra 39 de 126 en banco). Encaja con los conceptos que se teclean en `Control`: `"rem cueritos"`,
  `"rem palomitas"` — **"rem" es REMISIÓN**. Es la misma distinción FISCAL/REMISIÓN que el catálogo
  del propio Excel ya trae, en una columna que nunca se conectó a nada.
- ⚠️ **Para contabilidad, no para sistemas:** $53,782,608 pagados en efectivo a proveedor en 2026, de
  los cuales **$53.16M (98.8 %) en pagos individuales mayores a $2,000** (89 de ellos arriba de
  $100,000, por $23.89M), a proveedores que mayormente no emiten CFDI. El art. 27 fr. III de la LISR
  condiciona la deducibilidad de pagos > $2,000 a que sean por medio bancario. **No es un dictamen —
  es un dato que debe revisar contabilidad antes de rediseñar el proceso**, porque puede cambiar el
  diseño entero.

## Aporta a

Finanzas/Tesorería (libro + calendario + flujo proyectado) · Bancos/CB (liga pago↔movimiento) · Cuadre
y deuda (cierra debe→paga→sale, expone kepler_flag) · Compras/RA (días crédito + PP → timing pedido y
pronto-pago vs costo del dinero) · Maat (anomalías de pago) · Fiscal/materialidad (pago↔factura↔recepción).

## Riesgos

Headers cambian mes a mes → mapeo por nombre no posición · proveedor texto-libre lowercase → motor de
búsqueda compartido, dejar supplier_text crudo + supplier_id nullable · KEPLER=false en mes en curso es
esperado (lag, no error) · términos escasos en Excel → completar con Kepler c30 · anti-churn/RLS/tenant
explícito (reglas de la casa).
