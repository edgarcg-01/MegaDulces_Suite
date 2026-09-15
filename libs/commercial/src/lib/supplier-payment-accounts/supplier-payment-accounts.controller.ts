import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { SupplierPaymentAccountsService, CreateAccountChangeRequestDto } from './supplier-payment-accounts.service';

interface AuthedRequest { user?: { username?: string; full_name?: string } }

/**
 * Fase TP.7 (ADR-064) — Catálogo de cuentas de pago a proveedor. Solicitar (alta/cambio/baja)
 * usa COMPRAS_OBLIGACIONES_GESTIONAR; aprobar/rechazar exige FINANCE_PAYMENT_CALENDAR_AUTORIZAR
 * (el MISMO permiso que libera el lote del Calendario de Pagos) — separación real: quien pide
 * el cambio no puede aprobarlo.
 */
@ApiTags('commercial-supplier-payment-accounts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/supplier-payment-accounts')
export class SupplierPaymentAccountsController {
  constructor(private readonly svc: SupplierPaymentAccountsService) {}

  @Get('by-supplier/:supplierId')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  listAccounts(@Param('supplierId') supplierId: string) {
    return this.svc.listAccounts(supplierId);
  }

  @Get('solicitudes')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_VER)
  @ApiOperation({ summary: 'Bandeja de solicitudes de alta/cambio/baja de cuenta. Default: pendientes.' })
  listRequests(@Query('status') status?: string) {
    return this.svc.listRequests(status);
  }

  @Post('adjunto')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Sube el JPG/PDF de la solicitud de pago (evita errores de captura contra la factura/recibo).' })
  uploadAttachment(@Body() body: { file_base64?: string }) {
    return this.svc.uploadAttachment(body?.file_base64 || '');
  }

  @Post('solicitudes')
  @RequirePermissions(Permission.COMPRAS_OBLIGACIONES_GESTIONAR)
  @ApiOperation({ summary: 'Solicita alta/cambio/baja de una cuenta de pago a proveedor. Requiere motivo. NO se aplica sola.' })
  createRequest(@Body() dto: CreateAccountChangeRequestDto, @Req() req: AuthedRequest) {
    return this.svc.createRequest(dto, req.user?.username || 'sistema');
  }

  @Post('solicitudes/:id/aprobar')
  @RequirePermissions(Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
  @ApiOperation({ summary: 'Aprueba y APLICA la solicitud (crea/modifica/desactiva la cuenta real). Permiso restringido.' })
  approve(@Param('id') id: string, @Body() body: { decision_notes?: string }, @Req() req: AuthedRequest) {
    return this.svc.approveRequest(id, req.user?.username || 'sistema', body?.decision_notes);
  }

  @Post('solicitudes/:id/rechazar')
  @RequirePermissions(Permission.FINANCE_PAYMENT_CALENDAR_AUTORIZAR)
  reject(@Param('id') id: string, @Body() body: { decision_notes?: string }, @Req() req: AuthedRequest) {
    return this.svc.rejectRequest(id, req.user?.username || 'sistema', body?.decision_notes);
  }
}
