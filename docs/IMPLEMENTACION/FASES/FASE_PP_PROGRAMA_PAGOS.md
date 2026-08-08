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
- **PP.6** Maat: tool `maat_programa_pagos` + detectores (duplicado, EFOS pagado, concentración banco, PP desaprovechado).

MVP = PP.0 + PP.2 + PP.3.

## Aporta a

Finanzas/Tesorería (libro + calendario + flujo proyectado) · Bancos/CB (liga pago↔movimiento) · Cuadre
y deuda (cierra debe→paga→sale, expone kepler_flag) · Compras/RA (días crédito + PP → timing pedido y
pronto-pago vs costo del dinero) · Maat (anomalías de pago) · Fiscal/materialidad (pago↔factura↔recepción).

## Riesgos

Headers cambian mes a mes → mapeo por nombre no posición · proveedor texto-libre lowercase → motor de
búsqueda compartido, dejar supplier_text crudo + supplier_id nullable · KEPLER=false en mes en curso es
esperado (lag, no error) · términos escasos en Excel → completar con Kepler c30 · anti-churn/RLS/tenant
explícito (reglas de la casa).
