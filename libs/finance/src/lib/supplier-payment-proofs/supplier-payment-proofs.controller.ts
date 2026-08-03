import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { SupplierPaymentProofsService, ListPaymentsQuery, AttachPaymentDto } from './supplier-payment-proofs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * Fase CC (extensión) — Comprobantes de Pago a Proveedor. Lista los pagos de
 * Kepler (XD2501) y les adjunta el comprobante de transferencia (imagen/PDF) con
 * OCR. Captura/adjunto a nivel VER (el capturista); validación/rechazo a nivel
 * GESTIONAR (el revisor). No escribe a Kepler.
 */
@ApiTags('finance-supplier-payment-proofs')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/supplier-payments')
export class SupplierPaymentProofsController {
  constructor(private readonly svc: SupplierPaymentProofsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Lista pagos a proveedor de Kepler + estado de su comprobante + KPIs.' })
  list(
    @Query('estado') estado?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const q: ListPaymentsQuery = { estado, from, to, search, limit: limit ? Number(limit) : undefined };
    return this.svc.listPayments(q);
  }

  @Get(':sucursal/:folio')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Detalle del pago + sus comprobantes adjuntos.' })
  detail(@Param('sucursal') sucursal: string, @Param('folio') folio: string) {
    return this.svc.detail(sucursal, folio);
  }

  @Post('ocr')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Corre OCR sobre el comprobante (imagen/PDF) y devuelve los campos (preview, no guarda).' })
  ocr(@Body() body: { file_base64?: string }) {
    return this.svc.runOcr(body?.file_base64 || '');
  }

  @Post('upload')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Sube el comprobante (imagen/PDF) a Cloudinary y devuelve su referencia.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.svc.uploadFile(body?.file_base64 || '', body?.role || 'comprobante');
  }

  @Post('attach')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Adjunta la evidencia al pago (con archivos ya subidos + OCR). Calcula el cuadre de monto.' })
  attach(@Body() body: AttachPaymentDto, @Req() req: AuthedRequest) {
    return this.svc.attach(body, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/validate')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Valida la evidencia del pago. Auditado.' })
  validate(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.svc.validate(id, req?.user?.full_name || req?.user?.username);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_GESTIONAR)
  @ApiOperation({ summary: 'Rechaza la evidencia (con motivo). Auditado.' })
  reject(@Param('id') id: string, @Body() body: { motivo?: string }, @Req() req: AuthedRequest) {
    return this.svc.reject(id, req?.user?.full_name || req?.user?.username, body?.motivo);
  }
}
