import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  PaymentCalendarService, ObligationSource, CreateAllocationDto, AllocationItemDto,
  PrepareAllocationDto, CreateAgreementDto, ReprogramReason,
} from './payment-calendar.service';
import { PaymentCalendarDocumentService } from './payment-calendar-document.service';

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

  @Get('obligations')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Obligaciones disponibles (UNION de los 3 orígenes). No se acota por día — los pendientes no se pierden al cambiar de mes/año.' })
  listObligations(
    @Query('source') source?: ObligationSource,
    @Query('classification') classification?: string,
    @Query('search') search?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('onlyCritical') onlyCritical?: string,
    @Query('all') all?: string,
  ) {
    return this.svc.listObligations({
      source, classification, search, dueFrom, dueTo,
      onlyCritical: onlyCritical === 'true', onlyAvailable: all !== 'true',
    });
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
