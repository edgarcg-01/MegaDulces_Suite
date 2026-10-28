import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  PaymentCalendarService, ObligationSource, CreateAllocationDto, AllocationItemDto,
  PrepareAllocationDto, CreateAgreementDto, ReprogramReason,
} from './payment-calendar.service';
import { PaymentCalendarDocumentService } from './payment-calendar-document.service';
import type { PayableEvidenceFile, PayableEvidenceRow, PaymentCalendarWeek, PaymentOriginAccount, SupplierCreditRow, SupplierPaymentHabit, SupplierUnappliedCreditRow } from '@megadulces/contracts';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * Fase TP.1 — Calendario de Pagos (ADR-064). Consumidor: lee obligaciones de los tres orígenes,
 * las asigna a un día dentro de la capacidad de Presupuestos, y prepara su ejecución. Reusa
 * FINANCE_PAYMENTS_VER/GESTIONAR (misma familia que Programa de Pagos / Pagos a proveedor).
 */
@ApiTags('finance-payment-calendar')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/payment-calendar')
export class PaymentCalendarController {
  constructor(
    private readonly svc: PaymentCalendarService,
    private readonly docs: PaymentCalendarDocumentService,
  ) {}

  /**
   * `[PGP.14]` El crédito a favor SIN aplicar, por acreedor. Va aparte de `obligations` porque esa
   * consulta tiene presupuesto de 500 ms y corre en 325-377; ésta cuesta 135-143 ms sola.
   */
  @Get('creditos-a-favor')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Notas de crédito, devoluciones, bonificaciones y anticipos que todavía NO se aplicaron contra ninguna factura, agrupados por acreedor. Medido el 2026-10-26: $8,264,176 en 201 documentos, de los cuales $4,484,249 son de 54 acreedores a los que además les debemos (eso es lo neteable). ⚠️ Es un PISO: kdxf sobre-cuenta lo aplicado por replicación de sucursal.' })
  listUnappliedCredits(): Promise<SupplierUnappliedCreditRow[]> {
    return this.svc.listUnappliedCredits();
  }

  /**
   * `[PGP.17]` El desglose de UN acreedor, con los DOS casos: lo que Kepler ya aplicó y lo que
   * no. Medido: 62 ms (el predicado por acreedor sí baja a la vista).
   */
  @Get('creditos-a-favor/:proveedor')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Todos los descuentos de un acreedor por tipo —nota de crédito, nota de crédito CFDI, devolución de compra, bonificación, anticipo, ajuste de abono— con su importe, lo que Kepler ya aplicó y lo que queda a favor. Incluye los YA APLICADOS a propósito: sin eso, un proceso que funciona (las notas de crédito se netean casi al 100%) se lee como que el sistema no hace nada. ⛔ Cheque y transferencia quedan fuera: son pagos, no descuentos.' })
  listSupplierCredits(@Param('proveedor') proveedor: string): Promise<SupplierCreditRow[]> {
    return this.svc.listSupplierCredits(proveedor);
  }

  /**
   * `[PGP.19]` La prueba documental de los documentos de un acreedor. Se pide EN DIFERIDO: la
   * vista tiene un piso MEDIDO de ~2.2-2.5 s que no baja con ningun filtro (ver nota de costo).
   */
  @Get('evidencia/:proveedor')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'La MEJOR prueba documental de cada documento por pagar de un acreedor: el PDF que Compras adjuntó, o el UUID fiscal del CFDI, o la razón por la que no hay ninguna. No elige un carril: puntúa todos los candidatos por cuántas de 5 señales coinciden (importe, fecha, folio, referencia, RFC), exige ancla de importe o RFC, y corta en puntaje 3. Medido 2026-10-27 sobre 2,917 documentos exigibles: 774 con PDF, 367 con sólo UUID, 1,776 sin nada; placebo del umbral = 0 (precisión 100%). ⛔ El umbral 2 daría 59.7% de cobertura con 45% de precisión: se descartó, serían facturas ajenas pegadas al pago.' })
  listPayableEvidence(@Param('proveedor') proveedor: string): Promise<PayableEvidenceRow[]> {
    return this.svc.listPayableEvidence(proveedor);
  }

  /**
   * `[PGP.21]` Abre la factura sin salir de Pagos.
   *
   * ⛔ Vive acá, y NO se enlaza al endpoint de Compras, por una razón medida el 2026-10-27:
   *    de los 32 roles con `FINANCE_PAYMENTS_VER`, **3 no tienen `COMPRAS_ENTRADAS_VER`** —
   *    `finanzas_operativo` (Tesorería), `contabilidad` y `auditor_externo`. Enlazar allá le
   *    habría dado 403 justo a quien hace el pago.
   */
  /**
   * `[PGP.21]` La evidencia de los documentos que la pantalla tiene A LA VISTA, en UNA llamada.
   *
   * ⛔ No hay variante «por sucursal» ni «todo»: medidas el 2026-10-27 en 1,082-1,179 ms y
   *    2,128 ms. La vista tiene un piso MEDIDO de ~2.2-2.5 s que NO baja con ningun filtro (es armar el hash
   *    sobre los 169 mil CFDI recibidos), así que una llamada por acreedor multiplicaría ese
   *    piso por la cantidad de acreedores en pantalla.
   */
  @Get('evidencia')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'La prueba documental de una lista de documentos (hasta 200), separados por coma, con el mismo `entity_ref` que ya trae cada obligación. Devuelve el PDF del proveedor, el UUID fiscal, o la razón por la que no hay ninguno — nunca un hueco mudo.' })
  listEvidenceByRefs(@Query('refs') refs?: string): Promise<PayableEvidenceRow[]> {
    return this.svc.listEvidenceByRefs(String(refs ?? '').split(',').filter(Boolean));
  }

  @Get('evidencia/archivo/:proofId')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Los archivos de un comprobante de evidencia, con URL prefirmada de 600 s para abrirlos desde la pantalla de Pagos. El `proofId` sale de `ref_evidencia` cuando `evidencia = pdf`.' })
  getEvidenceFiles(@Param('proofId') proofId: string): Promise<PayableEvidenceFile[]> {
    return this.svc.getEvidenceFiles(proofId);
  }

  @Get('obligations')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Obligaciones disponibles (UNION de los 4 orígenes: gasto, compromiso, factura capturada y deuda viva de Kepler). Devuelve { rows, total, limit, offset }: el total dice cuántas hay aunque el techo recorte. No se acota por día.' })
  listObligations(
    @Query('source') source?: ObligationSource,
    @Query('classification') classification?: string,
    @Query('search') search?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('onlyCritical') onlyCritical?: string,
    @Query('all') all?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('prontoPago') prontoPago?: 'por_vencer' | 'capturable',
    /** `[PGP.7]` El orden de Pronto pago, dentro del Calendario: por fecha limite del descuento. */
    @Query('orden') orden?: 'vencimiento' | 'descuento',
  ) {
    return this.svc.listObligations({
      source, classification, search, dueFrom, dueTo,
      onlyCritical: onlyCritical === 'true', onlyAvailable: all !== 'true',
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
      prontoPago, orden,
    });
  }

  @Get('weeks/:date')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[TP.16] La semana (lunes→domingo) que contiene :date — por día: resumen, pagos y folio del lote.' })
  week(@Param('date') date: string): Promise<PaymentCalendarWeek> {
    return this.svc.weekView(date);
  }

  @Get('origin-accounts')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[TP.16] Cuentas de ORIGEN elegibles al preparar un pago (activas, sin la caja).' })
  originAccounts(): Promise<PaymentOriginAccount[]> {
    return this.svc.originAccounts();
  }

  @Get('payment-habits')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[PGP.30] Con qué se le suele pagar a cada acreedor, para precargar método y cuenta. Propone, no decide.' })
  paymentHabits(): Promise<SupplierPaymentHabit[]> {
    return this.svc.paymentHabits();
  }

  @Get('days/:date/summary')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  daySummary(@Param('date') date: string) {
    return this.svc.daySummary(date);
  }

  @Get('days/:date/allocations')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  dayAllocations(@Param('date') date: string) {
    return this.svc.listDayAllocations(date);
  }

  @Get('days/:date/lot')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'El lote del día tal cual (folio/status) — null si aún no hay pagos.' })
  getLot(@Param('date') date: string) {
    return this.svc.getLot(date);
  }

  @Post('allocations')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Asigna una o varias obligaciones a un día (fecha+monto, sin banco/método).' })
  createAllocation(@Body() dto: CreateAllocationDto, @Req() req: AuthedRequest) {
    return this.svc.createAllocation(dto, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/items')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Agrega otra obligación al mismo pago (un pago cubre varias facturas).' })
  addItem(@Param('id') id: string, @Body() item: AllocationItemDto, @Req() req: AuthedRequest) {
    return this.svc.addItem(id, item, req.user?.username || 'sistema');
  }

  @Delete('allocations/:id/items/:itemId')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  removeItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.svc.removeItem(id, itemId);
  }

  @Post('allocations/:id/reprogramar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Mueve el pago a otro día (pendiente o fallido) — actualiza la capacidad consumida de ambas fechas. Exige motivo (TP.10).' })
  reprogram(@Param('id') id: string, @Body() body: { date: string; reason: ReprogramReason; reason_detail?: string }, @Req() req: AuthedRequest) {
    return this.svc.reprogram(id, body.date, body.reason, body.reason_detail, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/orden')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Ajusta manualmente el orden de pago (dónde "cortar" si falta capacidad).' })
  setPriorityRank(@Param('id') id: string, @Body() body: { priority_rank: number }, @Req() req: AuthedRequest) {
    return this.svc.setPriorityRank(id, Number(body.priority_rank), req.user?.username || 'sistema');
  }

  @Post('days/:date/proponer-orden')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Propone el orden de pago del día (compromisos financieros → críticos → resto). Tesorería lo ajusta después.' })
  suggestOrder(@Param('date') date: string, @Req() req: AuthedRequest) {
    return this.svc.suggestPriorityOrder(date, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/preparar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Completa método de pago / banco / caja — lo que Caja General necesita para ejecutar.' })
  prepare(@Param('id') id: string, @Body() dto: PrepareAllocationDto, @Req() req: AuthedRequest) {
    return this.svc.prepare(id, dto, req.user?.username || 'sistema');
  }

  /**
   * `[TP.19.3]` Liga el pago con su documento en Kepler (O3): de qué día del calendario salió esta
   * transferencia. Aparte de `ejecutar` porque el dinero sale antes de que el ERP capture el
   * documento — exigirlo al ejecutar obligaría a inventar un folio.
   */
  /**
   * `[TP.19.4]` Propone el documento de Kepler de un pago ejecutado (monto ±$0.01, día del lote
   * ±3 y proveedor). `unico: true` = un solo candidato, que es cuando ligarlo no deja lugar a
   * duda; con dos, los devuelve y **no elige**.
   */
  @Get('allocations/:id/kepler/sugerencias')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'TP.19.4 — candidatos de Kepler para ligar un pago ejecutado. No liga: propone.' })
  sugerirKepler(@Param('id') id: string): ReturnType<PaymentCalendarService['sugerirKeplerPayment']> {
    return this.svc.sugerirKeplerPayment(id);
  }

  @Post('allocations/:id/kepler')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'TP.19.3 — liga el pago ejecutado con su documento de Kepler (sucursal, doc_prefix, folio). Verifica que exista en el espejo del ERP.' })
  linkKepler(
    @Param('id') id: string,
    @Body() dto: { sucursal: string; doc_prefix: string; folio: string },
    @Req() req: AuthedRequest,
  ): ReturnType<PaymentCalendarService['linkKeplerPayment']> {
    return this.svc.linkKeplerPayment(id, dto, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/ejecutar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Caja General: marca el pago como ejecutado. No vuelve a liberar capacidad.' })
  execute(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.execute(id, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/fallo')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Marca el pago como fallido — NO liquida la obligación, su saldo regresa a revisión.' })
  fail(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.fail(id, body?.reason, req.user?.username || 'sistema');
  }

  @Post('allocations/:id/cancelar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  cancelAllocation(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: AuthedRequest) {
    return this.svc.cancelAllocation(id, body?.reason, req.user?.username || 'sistema');
  }

  @Post('days/:date/liberar')
  @RequirePermissions(Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
  @ApiOperation({ summary: 'AUTORIZA y libera el lote del día — exige capacidad definida, consumo <= autorizado y orden de pago completo. Permiso restringido (TP.6): distinto de quien prepara.' })
  releaseLot(@Param('date') date: string, @Req() req: AuthedRequest) {
    return this.svc.releaseLot(date, req.user?.username || 'sistema');
  }

  @Get('days/:date/preliminar.pdf')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Documento preliminar para autorización (leyendas de control interno). Disponible aunque el día aún no esté autorizado.' })
  async preliminarPdf(@Param('date') date: string, @Res() res: Response): Promise<void> {
    const buf = await this.docs.renderPreliminar(date);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preliminar-${date}.pdf"`);
    res.end(buf);
  }

  @Get('days/:date/caja-general.pdf')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Instrucción de ejecución para Caja General — sólo disponible tras autorizar (folio del lote generado).' })
  async cajaGeneralPdf(@Param('date') date: string, @Res() res: Response): Promise<void> {
    const buf = await this.docs.renderCajaGeneral(date);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="caja-general-${date}.pdf"`);
    res.end(buf);
  }

  @Post('days/:date/cerrar')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  closeLot(@Param('date') date: string, @Req() req: AuthedRequest) {
    return this.svc.closeLot(date, req.user?.username || 'sistema');
  }

  @Get('agreements')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  listAgreements(@Query('source') source: ObligationSource, @Query('obligation_id') obligationId: string) {
    return this.svc.listAgreements(source, obligationId);
  }

  @Post('agreements')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Registra un acuerdo de negociación (responsable/contraparte/fecha-monto comprometido/permite parcialidad/evidencia).' })
  createAgreement(@Body() dto: CreateAgreementDto, @Req() req: AuthedRequest) {
    return this.svc.createAgreement(dto, req.user?.username || 'sistema');
  }
}
