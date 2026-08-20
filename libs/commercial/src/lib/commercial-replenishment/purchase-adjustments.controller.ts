import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PurchaseAdjustmentsService } from './purchase-adjustments.service';
import { PurchaseAdjustmentsFindingsBridgeService } from './purchase-adjustments-findings-bridge.service';

/**
 * RE.10 — Descuentos y ajustes de compra (X-D-40 / X-D-55). Proyecto Compras.
 * Read-only sobre `analytics.erp_purchase_adjustments`. VER = lectura.
 * Hace visible el canal de descuentos/apoyos ($20M) + facturas duplicadas ($6.7M)
 * que el Excel de recepción nunca capturó.
 */
@ApiTags('commercial-purchase-adjustments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/purchase-adjustments')
export class PurchaseAdjustmentsController {
  constructor(
    private readonly svc: PurchaseAdjustmentsService,
    private readonly findingsBridge: PurchaseAdjustmentsFindingsBridgeService,
  ) {}

  @Get('summary')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — resumen: total + por grupo (comercial/operacional/error de captura) + por categoría + por doctype. Filtros: doctype, categoria, grupo, search, date_from, date_to.' })
  summary(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    return this.svc.summary({ doctype, categoria, grupo, search, date_from, date_to });
  }

  @Get()
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — lista paginada de ajustes de compra. Filtros: doctype, categoria, grupo, search, date_from, date_to, page, pageSize.' })
  list(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.svc.list({ doctype, categoria, grupo, search, date_from, date_to, page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined });
  }

  @Get('for-entrada')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.2 — ajustes (X-D-40/55) que EXPLICAN el descuadre de una entrada: por entrada_folio exacto (cuando existe) o por proveedor + ventana de fecha (window_days, default 15). Params: proveedor_code, entrada_folio, date, window_days.' })
  forEntrada(
    @Query('proveedor_code') proveedor_code?: string,
    @Query('entrada_folio') entrada_folio?: string,
    @Query('date') date?: string,
    @Query('window_days') window_days?: string,
  ) {
    return this.svc.forEntrada({ proveedor_code, entrada_folio, date, window_days: window_days ? Number(window_days) : undefined });
  }

  @Get('duplicates')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — posibles facturas DUPLICADAS: entradas del mismo proveedor con el MISMO monto exacto repetido dentro de N días (window_days, default 30). Control proactivo HITL sobre las entradas reales.' })
  duplicates(@Query('window_days') window_days?: string) {
    return this.svc.potentialDuplicates(window_days ? Number(window_days) : undefined);
  }

  @Post('sync-findings')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_GESTIONAR)
  @ApiOperation({ summary: 'RE.10 — empuja las posibles facturas duplicadas a la bandeja unificada de hallazgos (finance.findings / Maat). Idempotente por dedup_key, respeta la auto-supresión L2, best-effort. Devuelve { pushed, inserted, skipped }.' })
  syncFindings() {
    return this.findingsBridge.syncCurrent();
  }

  @Get('discount-reconciliation')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — reconciliación de descuento por proveedor: canal PAGO (c84 pronto pago) vs NOTA (X-D-55 comercial) + total + % vs compras + canal (pago/nota/ambos). "ambos" = posible solapamiento del mismo descuento. Filtros: date_from, date_to, search.' })
  discountReconciliation(
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.discountReconciliation({ date_from, date_to, search });
  }

  @Get('discount-leakage')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — "descuento no capturado": proveedores que dan descuento (política) con pagos SIN descuento (c84=0) → fuga = tasa esperada × monto pagado completo. Ordenado por $ perdido. Filtro: search.' })
  discountLeakage(@Query('search') search?: string) {
    return this.svc.discountLeakage({ search });
  }

  @Get('compras-360/filters')
  @RequirePermissions(Permission.COMPRAS_360_VER)
  @ApiOperation({ summary: 'CXP.3 — catálogo de filtros de Compras 360: sucursales presentes (con conteo) + monto máximo, para poblar los dropdowns.' })
  compras360Filters() {
    return this.svc.compras360Filters();
  }

  @Get('compras-360')
  @RequirePermissions(Permission.COMPRAS_360_VER)
  @ApiOperation({ summary: 'CXP.3 — "Compras 360" (el Excel): fila = orden de entrada/factura + OC + ajuste ligado exacto + neto. Filtros: search (prov/OC/folio/vale/concepto), sucursal, proveedor_code, date_from, date_to, ajuste (con|sin), con_oc (con|sin), comprobante (sin|con|validado|por_validar|rechazado), monto_min, monto_max, sort+dir (whitelist), page, pageSize, all (export ≤5000). con_ajuste sigue por back-compat.' })
  compras360(
    @Query('search') search?: string,
    @Query('sucursal') sucursal?: string,
    @Query('proveedor_code') proveedor_code?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('con_ajuste') con_ajuste?: string,
    @Query('ajuste') ajuste?: string,
    @Query('con_oc') con_oc?: string,
    @Query('comprobante') comprobante?: string,
    @Query('monto_min') monto_min?: string,
    @Query('monto_max') monto_max?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('all') all?: string,
  ) {
    return this.svc.compras360({
      search, sucursal, proveedor_code, date_from, date_to,
      con_ajuste: con_ajuste === 'true' || con_ajuste === '1',
      ajuste, con_oc, comprobante,
      monto_min: monto_min != null && monto_min !== '' ? Number(monto_min) : undefined,
      monto_max: monto_max != null && monto_max !== '' ? Number(monto_max) : undefined,
      // El servicio valida `sort` contra una whitelist; acá sólo se normaliza la dirección.
      sort, dir: dir === 'asc' ? 'asc' : 'desc',
      page: page ? Number(page) : undefined, pageSize: pageSize ? Number(pageSize) : undefined,
      all: all === 'true' || all === '1',
    });
  }

  @Get('compras-360/evidence')
  @RequirePermissions(Permission.COMPRAS_360_VER)
  @ApiOperation({ summary: 'RE.9 — evidencia (comprobante + OCR) adjunta a una orden de entrada, con URL de lectura prefirmada, para el visor lado-a-lado del detalle de Compras 360. Read-only.' })
  receiptEvidence(@Query('sucursal') sucursal: string, @Query('folio') folio: string) {
    return this.svc.receiptEvidence(sucursal, folio);
  }

  @Get('poliza-for-receipt')
  @RequirePermissions(Permission.COMPRAS_360_VER)
  @ApiOperation({ summary: 'CXP.6 — póliza contable (Kepler) de una recepción/factura: header (¿cuadra?) + patas (cuenta/cargo-abono/importe). Confirma el asiento en libros (102/201/gasto). Params: sucursal, folio, tipo_pol (default XA2001).' })
  polizaForReceipt(@Query('sucursal') sucursal?: string, @Query('folio') folio?: string, @Query('tipo_pol') tipo_pol?: string) {
    return this.svc.polizaForReceipt({ sucursal: sucursal || '', folio: folio || '', tipo_pol });
  }

  @Get('supplier-ledger')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'CXP.7 — cuadre contable por proveedor (estado de cuenta 201 de Kepler): facturado (XA2001/XA1001) vs pagado (XD2601/XD2501) vs notas (XD5501) vs devoluciones (XD4001) + Δ del periodo. Oculta cuentas internas (SUCURSAL/caja chica/viáticos) salvo include_internal=true. Filtros: date_from, date_to (acotan por mes), search.' })
  supplierLedger(@Query('date_from') date_from?: string, @Query('date_to') date_to?: string, @Query('search') search?: string, @Query('include_internal') include_internal?: string) {
    return this.svc.supplierLedger({ date_from, date_to, search, include_internal: include_internal === 'true' || include_internal === '1' });
  }

  @Get('supplier-ledger/detail')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'CXP.7 — desglose (auxiliar 201) de un proveedor: movimientos individuales (factura/pago/nota/devolución) con folio, fecha, importe (con signo) y saldo corrido. Params: proveedor, date_from, date_to.' })
  supplierLedgerDetail(@Query('proveedor') proveedor?: string, @Query('date_from') date_from?: string, @Query('date_to') date_to?: string) {
    return this.svc.supplierLedgerDetail({ proveedor, date_from, date_to });
  }

  @Get('supplier-invoice-ledger')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'CXP.8 — cuadre POR FACTURA (documental) de un proveedor: cada entrada real (erp_goods_receipts) con ajuste ligado + estado de pago FIFO (pagada/parcial/pendiente) + cross-check vs saldo contable 201 (expone póliza Kepler incompleta). El link factura↔pago es estimación FIFO, no estructural. Params: proveedor_code (o proveedor por nombre).' })
  supplierInvoiceLedger(@Query('proveedor_code') proveedor_code?: string, @Query('proveedor') proveedor?: string) {
    return this.svc.supplierInvoiceLedger({ proveedor_code, proveedor });
  }

  @Get('supplier-fiscal-ledger')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'CXP.9 — tercera lente: FISCAL (ContPAQi). Compara al proveedor en los 3 libros: Kepler operativo (facturas/pagos) vs Kepler contable (201) vs ContPAQi fiscal (cuenta proveedores 2120*, match por nombre normalizado) + movimientos ContPAQi. Los 3 NO atan al peso (distinto alcance/periodo). Param: proveedor (nombre).' })
  supplierFiscalLedger(@Query('proveedor') proveedor?: string) {
    return this.svc.supplierFiscalLedger({ proveedor });
  }

  @Get('contpaqi-payables')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'CXP.10 — "Lo que se debe" a proveedores según ContPAQi: saldo REAL de la cuenta 2120 (balanza contpaqi_ledger_monthly, con apertura) por proveedor + total + flag stale (saldo viejo sin movimiento). Filtros: search, only_stale.' })
  contpaqiPayables(@Query('search') search?: string, @Query('only_stale') only_stale?: string) {
    return this.svc.contpaqiPayables({ search, only_stale: only_stale === 'true' || only_stale === '1' });
  }

  @Get('landed-cost')
  @RequirePermissions(Permission.COMPRAS_COSTO_NETO_VER)
  @ApiOperation({ summary: 'CXP.4 — Costo neto (landed cost) por proveedor: compras − descuento efectivo (pago c84 + notas comerciales) = costo real. rate=desc/compras. anomalo si rate>20% (probable devolución/error). Filtros: min_compras, search, date_from, date_to (acotan compras/pagos/notas al periodo), only_anomalo.' })
  landedCost(
    @Query('min_compras') min_compras?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
    @Query('only_anomalo') only_anomalo?: string,
  ) {
    return this.svc.landedCost({
      min_compras: min_compras ? Number(min_compras) : undefined, search, date_from, date_to,
      only_anomalo: only_anomalo === 'true' || only_anomalo === '1',
    });
  }

  @Get('by-supplier')
  @RequirePermissions(Permission.COMPRAS_DESCUENTOS_VER)
  @ApiOperation({ summary: 'RE.10 — top proveedores por $ de ajustes (apoyos/descuentos/duplicadas). Mismos filtros que summary.' })
  bySupplier(
    @Query('doctype') doctype?: string,
    @Query('categoria') categoria?: string,
    @Query('grupo') grupo?: string,
    @Query('search') search?: string,
    @Query('date_from') date_from?: string,
    @Query('date_to') date_to?: string,
  ) {
    return this.svc.bySupplier({ doctype, categoria, grupo, search, date_from, date_to });
  }
}
